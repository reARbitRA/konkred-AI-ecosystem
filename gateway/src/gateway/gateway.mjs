/**
 * Konkred Gateway core — cache → dedup → route → attempt loop → fuse.
 *
 * This is the only module that talks to the key pool, the fallback policy and
 * the provider adapters, which keeps server.mjs a thin HTTP layer.
 */
import { config } from '../config.mjs';
import { policyStore } from '../policy-store.mjs';
import { keyPool } from './key-pool.mjs';
import { userLimiter } from './user-limiter.mjs';
import { responseCache } from './cache.mjs';
import { deduper } from './dedup.mjs';
import { rankCandidates, capacityExhaustion } from './router.mjs';
import { decideFallback, DECISION, statusForClass } from './fallback.mjs';
import { normalizeResult, trimMessages, buildResponseData } from './fusion.mjs';
import { getProvider } from '../providers/index.mjs';
import {
  ERROR_CLASS,
  estimateMessagesTokens,
  classifyError,
  log,
  sleep,
  clamp,
} from '../util.mjs';

export class GatewayError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = extra.retryAfterSec ?? null;
    this.details = extra.details ?? null;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

const SYSTEM_PROMPTS = Object.freeze({
  general: 'You are Konkred, a precise engineering assistant. Answer directly and avoid filler.',
  'code-generation': 'You are Konkred, a senior software engineer. Produce complete, runnable code with brief inline comments and no placeholder bodies.',
  'bug-fixing': 'You are Konkred, a debugging specialist. Identify the root cause first, then give the minimal correct patch.',
  architecture: 'You are Konkred, a systems architect. Give component boundaries, data flow, failure modes and explicit trade-offs.',
  summarization: 'You are Konkred. Summarise faithfully, preserving numbers, names and causal order. Never invent facts.',
  translate: 'You are Konkred, a professional translator. Preserve formatting, code blocks and terminology. Output only the translation.',
  extraction: 'You are Konkred. Return only the requested structured data, with no commentary.',
});

/** Validate + normalise the /api/ai request body. */
export const validateRequest = (body) => {
  if (!body || typeof body !== 'object') throw new GatewayError(400, 'INVALID_BODY', 'Request body must be a JSON object');

  const taskType = String(body.taskType ?? body.task_type ?? 'general').toLowerCase();
  const known = policyStore.knownTaskTypes();
  if (!known.includes(taskType)) {
    throw new GatewayError(400, 'UNKNOWN_TASK_TYPE', `Unsupported taskType "${taskType}". Valid: ${known.join(', ')}`, {
      details: { validTaskTypes: known },
    });
  }

  let messages = Array.isArray(body.messages) ? body.messages : null;
  const prompt = typeof body.prompt === 'string' ? body.prompt : null;
  if (!messages && prompt) messages = [{ role: 'user', content: prompt }];
  if (!messages || !messages.length) {
    throw new GatewayError(400, 'MISSING_MESSAGES', 'Provide "messages": [{role, content}] or a "prompt" string');
  }

  const cleaned = [];
  for (const m of messages.slice(-config.maxMessages)) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role ?? 'user').toLowerCase();
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) continue;
    const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    if (!content.trim()) continue;
    cleaned.push({ role, content });
  }
  if (!cleaned.length) throw new GatewayError(400, 'EMPTY_MESSAGES', 'All supplied messages were empty or malformed');

  const maxTokens = clamp(Number.parseInt(body.maxTokens ?? body.max_tokens ?? config.defaultMaxTokens, 10) || config.defaultMaxTokens, 16, config.hardMaxTokens);
  const temperature = clamp(Number.parseFloat(body.temperature ?? 0.5), 0, 2);
  const privacy = ['private', 'any', 'training-ok'].includes(String(body.privacy ?? 'any').toLowerCase())
    ? String(body.privacy).toLowerCase()
    : 'any';
  const skipCache = Boolean(body.skipCache ?? body.skip_cache ?? false);
  const preferredModel = body.model ? String(body.model) : null;
  const systemPrompt = typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
    ? body.systemPrompt.trim()
    : SYSTEM_PROMPTS[taskType];

  const finalMessages = [{ role: 'system', content: systemPrompt }, ...cleaned.filter((m) => m.role !== 'system')];
  // Preserve any caller-supplied system prompt ahead of ours.
  const callerSystem = cleaned.filter((m) => m.role === 'system').map((m) => ({ ...m }));
  const composed = callerSystem.length ? [...callerSystem, ...finalMessages.slice(1)] : finalMessages;

  return { taskType, messages: composed, maxTokens, temperature, privacy, skipCache, preferredModel };
};

/** Single upstream attempt against one (model, key) pair. */
const attempt = async ({ candidate, messages, maxTokens, temperature, taskType, timeoutMs }) => {
  const { model, key } = candidate;
  const provider = getProvider(model.providerId);
  if (!provider) {
    return { ok: false, errorClass: ERROR_CLASS.NETWORK, status: 0, message: `No adapter for provider "${model.providerId}"`, modelId: model.id, provider: model.providerId, latencyMs: 0 };
  }

  const estimated = estimateMessagesTokens(messages) + maxTokens;
  const reservation = keyPool.reserve(key, model, estimated);
  if (!reservation.ok) {
    return {
      ok: false,
      errorClass: ERROR_CLASS.RATE_LIMIT,
      status: 429,
      message: `Local quota guard: ${reservation.reason}`,
      retryAfterSec: Math.ceil((reservation.retryAfterMs ?? 60000) / 1000),
      modelId: model.id,
      provider: model.providerId,
      latencyMs: 0,
      local: true,
    };
  }

  const started = Date.now();
  try {
    const raw = await provider.chat({ model, messages, maxTokens, temperature, key, timeoutMs, taskType });
    const latencyMs = Date.now() - started;
    if (raw.headers) keyPool.learnFromHeaders(key, raw.headers);
    keyPool.commit(key, raw.usage ?? {}, model);
    const result = normalizeResult({
      content: raw.content,
      providerId: model.providerId,
      model,
      usage: raw.usage ?? {},
      finishReason: raw.finishReason ?? null,
      latencyMs: raw.latencyMs || latencyMs,
      raw: raw.raw ?? null,
    });
    return { ok: true, result, modelId: model.id, provider: model.providerId, latencyMs, key };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const status = Number(err?.status ?? 0);
    const message = String(err?.message ?? err);
    const errorClass = err?.errorClass ?? classifyError({ status, message, code: err?.code ?? '' });

    if (errorClass === ERROR_CLASS.RATE_LIMIT || errorClass === ERROR_CLASS.AUTH || errorClass === ERROR_CLASS.CAPACITY) {
      keyPool.penalize(key, { retryAfterSec: err?.retryAfterSec ?? null, errorClass, model, message });
    } else {
      key.stats.errors += 1;
      key.stats.lastError = { at: new Date().toISOString(), errorClass, message: message.slice(0, 240) };
    }

    return {
      ok: false,
      errorClass,
      status,
      message,
      code: err?.code ?? errorClass,
      retryAfterSec: err?.retryAfterSec ?? null,
      modelId: model.id,
      provider: model.providerId,
      latencyMs,
      key,
    };
  }
};

/** Core entry point used by POST /api/ai. */
export const runInference = async (request, { caller, requestId }) => {
  const { taskType, messages, maxTokens, temperature, privacy, skipCache, preferredModel } = request;

  /* ---------------- admission (per-caller quota) ---------------- */
  const estimatedTokens = estimateMessagesTokens(messages) + maxTokens;
  const admission = userLimiter.check(caller.userId, caller.tier, estimatedTokens);
  if (!admission.ok) {
    userLimiter.reject(caller.userId, caller.tier);
    throw new GatewayError(429, admission.reason, `Caller "${caller.userId}" (${caller.tier}) exceeded ${admission.reason}`, {
      retryAfterSec: admission.retryAfterSec,
      details: { limits: admission.limits },
    });
  }
  userLimiter.record(caller.userId, caller.tier, estimatedTokens);

  /* ---------------- cache ---------------- */
  const cacheKey = responseCache.constructor.keyFor({ taskType, messages, maxTokens, temperature, privacy, model: preferredModel });
  if (!skipCache) {
    const hit = responseCache.get(cacheKey);
    if (hit) {
      log.info('gateway', `cache hit ${requestId}`, { modelId: hit.modelId, provider: hit.provider });
      return buildResponseData({ result: hit, cached: true, attempts: [], deduplicated: false, taskType, privacy });
    }
  }

  /* ---------------- dedup + attempt loop ---------------- */
  const { result: data, deduplicated } = await deduper.run(skipCache ? null : cacheKey, async () => {
    let workingMessages = messages;
    let contextTrimmed = false;
    const attempts = [];
    const excludedModels = new Set();
    let lastFailure = null;
    let sameModelFailures = 0;
    let currentModelId = null;

    for (let attemptNo = 1; attemptNo <= config.maxAttempts; attemptNo += 1) {
      const est = estimateMessagesTokens(workingMessages) + maxTokens;
      const candidates = rankCandidates({
        taskType,
        privacy,
        preferredModel: attemptNo === 1 ? preferredModel : null,
        estimatedTokens: est,
        maxAttempts: config.maxAttempts,
        excludeModels: excludedModels,
      });

      if (!candidates.length) {
        lastFailure = lastFailure ?? { errorClass: ERROR_CLASS.CAPACITY, status: 503, message: 'No provider capacity available' };
        break;
      }

      const candidate = candidates[0];
      if (candidate.model.id !== currentModelId) {
        currentModelId = candidate.model.id;
        sameModelFailures = 0;
      }

      const outcome = await attempt({
        candidate,
        messages: workingMessages,
        maxTokens,
        temperature,
        taskType,
        timeoutMs: config.attemptTimeoutMs,
      });
      attempts.push({
        modelId: candidate.model.id,
        provider: candidate.model.providerId,
        status: outcome.ok ? 200 : outcome.status,
        errorClass: outcome.ok ? null : outcome.errorClass,
        message: outcome.ok ? null : outcome.message,
        latencyMs: outcome.latencyMs,
      });

      if (outcome.ok) {
        log.info('gateway', `ok ${requestId} via ${candidate.model.id}`, {
          attempt: attemptNo,
          latencyMs: outcome.latencyMs,
          usage: outcome.result.usage,
        });
        responseCache.set(cacheKey, outcome.result);
        userLimiter.recordTokens(caller.userId, outcome.result.usage?.totalTokens ?? 0);
        return buildResponseData({ result: outcome.result, cached: false, attempts, deduplicated: false, taskType, privacy });
      }

      lastFailure = outcome;
      sameModelFailures += 1;

      const hasMoreKeys = keyPool.availableKeys(candidate.model.providerId).filter((k) => k !== candidate.key).length > 0;
      const hasMoreCandidates = rankCandidates({
        taskType,
        privacy,
        estimatedTokens: est,
        maxAttempts: config.maxAttempts + 1,
        excludeModels: new Set([...excludedModels, candidate.model.id]),
      }).length > 0;

      const decision = decideFallback({
        errorClass: outcome.errorClass,
        status: outcome.status,
        attempt: attemptNo,
        maxAttempts: config.maxAttempts,
        sameModelFailures,
        hasMoreKeys,
        hasMoreCandidates,
        retryAfterSec: outcome.retryAfterSec ?? null,
        contextTrimmed,
      });

      log.warn('gateway', `attempt ${attemptNo} failed ${requestId}`, {
        modelId: candidate.model.id,
        errorClass: outcome.errorClass,
        status: outcome.status,
        decision: decision.decision,
        message: String(outcome.message).slice(0, 200),
      });

      if (decision.decision === DECISION.ABORT) break;

      if (decision.decision === DECISION.TRIM_CONTEXT) {
        const budget = Math.max(512, Math.floor((candidate.model.contextWindow ?? 8192) * config.contextTrimRatio));
        const trimmed = trimMessages(workingMessages, budget, { dropRatio: config.contextTrimRatio });
        workingMessages = trimmed.messages;
        contextTrimmed = true;
        log.info('gateway', `context trimmed ${requestId}`, { from: messages.length, to: workingMessages.length, budget });
      } else if (decision.decision === DECISION.NEXT_MODEL) {
        excludedModels.add(candidate.model.id);
      }

      if (decision.delayMs > 0) await sleep(Math.min(decision.delayMs, 15000));
    }

    /* ---------------- terminal failure ---------------- */
    const exhaustion = capacityExhaustion({ privacy, preferredModel, estimatedTokens });
    const errorClass = lastFailure?.errorClass ?? ERROR_CLASS.CAPACITY;
    const status = exhaustion.exhausted && !lastFailure ? 503 : statusForClass(errorClass, 502);
    const retryAfterSec = exhaustion.exhausted
      ? Math.max(1, Math.ceil((exhaustion.retryAfterMs ?? config.cooldownAfterRateLimitMs) / 1000))
      : Math.max(1, lastFailure?.retryAfterSec ?? 30);

    const code = exhaustion.reason === 'NO_PROVIDER_CREDENTIALS'
      ? 'NO_PROVIDER_CREDENTIALS'
      : exhaustion.exhausted
        ? 'CAPACITY_EXHAUSTED'
        : lastFailure?.code ?? 'UPSTREAM_FAILURE';

    const message = lastFailure?.message
      ? `All ${attempts.length} attempt(s) failed. Last: [${errorClass}] ${String(lastFailure.message).slice(0, 300)}`
      : 'No provider capacity available for this request.';

    throw new GatewayError(status, code, message, {
      retryAfterSec,
      details: { attempts, errorClass, exhaustion: exhaustion.exhausted, reason: exhaustion.reason ?? null },
    });
  });

  if (deduplicated) log.info('gateway', `coalesced duplicate ${requestId}`);
  return { ...data, deduplicated };
};

export const gatewayStats = () => ({
  registry: policyStore.summary(),
  pool: keyPool.stats(),
  cache: responseCache.stats(),
  dedup: deduper.stats(),
  callers: userLimiter.stats(),
});

export default runInference;
