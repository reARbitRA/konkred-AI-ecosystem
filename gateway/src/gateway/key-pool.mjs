/**
 * Sliding-window quota accounting for every provider key in the pool.
 *
 * Windows tracked per key: rpm (60s), tpm (60s), rpd / tpd (calendar day in the
 * provider's reset timezone) and monthlyTokens (calendar month).
 * Keys are penalised with cooldowns on 429/401 responses and can learn their
 * real limits from provider response headers (learnFromHeaders in the registry).
 */
import { config } from '../config.mjs';
import { policyStore } from '../policy-store.mjs';
import { dayBucket, monthBucket, nextResetAt, log, redact } from '../util.mjs';

const MINUTE_MS = 60_000;

class KeyState {
  constructor(providerId, key, index) {
    this.providerId = providerId;
    this.key = key;
    this.label = `${providerId}#${index}:${redact(key)}`;
    this.index = index;

    // Learned limits (null = use registry/static defaults)
    this.learned = { rpm: null, tpm: null };

    // Sliding windows
    this.requestTimes = [];
    this.tokenEvents = []; // { t, tokens }

    // Calendar buckets
    this.day = { bucket: null, requests: 0, tokens: 0, resetAt: null };
    this.month = { bucket: null, tokens: 0 };

    // Health
    this.cooldownUntil = 0;
    this.disabled = false;
    this.disabledUntil = 0;
    this.disabledReason = null;
    this.stats = { attempts: 0, successes: 0, rateLimits: 0, errors: 0, tokens: 0, lastUsedAt: null, lastError: null };
  }

  get cooling() {
    return this.disabled || Date.now() < this.cooldownUntil;
  }

  cooldownMsRemaining() {
    if (this.disabled) return Infinity;
    return Math.max(0, this.cooldownUntil - Date.now());
  }
}

class KeyPool {
  #keys = new Map(); // providerId -> KeyState[]

  constructor() {
    this.initialized = false;
  }

  /** Build pool state from configured credentials + registry models. */
  init() {
    this.#keys = new Map();
    for (const providerId of policyStore.providers.keys()) {
      const states = [];
      const providerCfg = config.providers[providerId];

      if (providerId === 'mock') {
        // Mock provider always gets a single synthetic key (offline simulator).
        states.push(new KeyState('mock', 'mock-key', 0));
      } else if (providerId === 'cloudflare') {
        if (providerCfg?.accountId && providerCfg?.tokens?.length) {
          providerCfg.tokens.forEach((token, i) => states.push(new KeyState(providerId, token, i)));
        }
      } else if (providerCfg?.keys?.length) {
        providerCfg.keys.forEach((k, i) => states.push(new KeyState(providerId, k, i)));
      }
      this.#keys.set(providerId, states);
    }
    this.initialized = true;
    log.info('key-pool', this.stats().providers.map((p) => `${p.id}:${p.keys}`).join(' '));
    return this;
  }

  keysFor(providerId) {
    return this.#keys.get(providerId) ?? [];
  }

  availableKeys(providerId) {
    return this.keysFor(providerId).filter((k) => !k.cooling);
  }

  hasProvider(providerId) {
    return this.keysFor(providerId).length > 0;
  }

  /** Effective limits for a key/model pair (learned values win). */
  #limitsFor(keyState, model) {
    return {
      rpm: keyState.learned.rpm ?? model.rpm,
      tpm: keyState.learned.tpm ?? model.tpm,
      rpd: model.rpd,
      tpd: model.tpd,
      monthlyTokens: model.monthlyTokens,
    };
  }

  #prune(keyState, now = Date.now()) {
    const cutoff = now - MINUTE_MS;
    while (keyState.requestTimes.length && keyState.requestTimes[0] < cutoff) keyState.requestTimes.shift();
    while (keyState.tokenEvents.length && keyState.tokenEvents[0].t < cutoff) keyState.tokenEvents.shift();

    const policy = policyStore.resetPolicy(keyState.providerId);
    const today = dayBucket(policy, now);
    if (keyState.day.bucket !== today) {
      keyState.day = { bucket: today, requests: 0, tokens: 0, resetAt: nextResetAt(policy, now) };
    }
    const thisMonth = monthBucket(now);
    if (keyState.month.bucket !== thisMonth) {
      keyState.month = { bucket: thisMonth, tokens: 0 };
    }
  }

  /**
   * Decide whether `model` can be served by `keyState` right now.
   * Returns { ok: true } or { ok: false, reason, retryAfterMs }.
   */
  check(keyState, model, estimatedTokens = 0, now = Date.now()) {
    if (!keyState) return { ok: false, reason: 'NO_KEY', retryAfterMs: 60_000 };
    this.#prune(keyState, now);

    if (keyState.disabled) {
      return { ok: false, reason: `DISABLED:${keyState.disabledReason ?? 'unknown'}`, retryAfterMs: 3_600_000 };
    }
    const coolingMs = keyState.cooldownMsRemaining();
    if (coolingMs > 0) return { ok: false, reason: 'COOLDOWN', retryAfterMs: coolingMs };

    const limits = this.#limitsFor(keyState, model);
    const minuteRequests = keyState.requestTimes.length;
    const minuteTokens = keyState.tokenEvents.reduce((s, e) => s + e.tokens, 0);

    if (limits.rpm !== null && minuteRequests + 1 > limits.rpm) {
      const oldest = keyState.requestTimes[0] ?? now;
      return { ok: false, reason: 'RPM', retryAfterMs: Math.max(1000, oldest + MINUTE_MS - now) };
    }
    if (limits.tpm !== null && minuteTokens + estimatedTokens > limits.tpm) {
      const oldest = keyState.tokenEvents[0]?.t ?? now;
      return { ok: false, reason: 'TPM', retryAfterMs: Math.max(1000, oldest + MINUTE_MS - now) };
    }
    if (limits.rpd !== null && keyState.day.requests + 1 > limits.rpd) {
      return { ok: false, reason: 'RPD', retryAfterMs: Math.max(1000, (keyState.day.resetAt ?? nextResetAt(policyStore.resetPolicy(keyState.providerId), now)) - now) };
    }
    if (limits.tpd !== null && keyState.day.tokens + estimatedTokens > limits.tpd) {
      return { ok: false, reason: 'TPD', retryAfterMs: Math.max(1000, (keyState.day.resetAt ?? now + MINUTE_MS) - now) };
    }
    if (limits.monthlyTokens !== null && keyState.month.tokens + estimatedTokens > limits.monthlyTokens) {
      return { ok: false, reason: 'MONTHLY_TOKENS', retryAfterMs: 6 * 3_600_000 };
    }
    if (model.contextWindow && estimatedTokens > model.contextWindow) {
      return { ok: false, reason: 'CONTEXT_WINDOW', retryAfterMs: 0 };
    }
    return { ok: true };
  }

  /** Reserve one request + estimated tokens before dispatching upstream. */
  reserve(keyState, model, estimatedTokens = 0, now = Date.now()) {
    const verdict = this.check(keyState, model, estimatedTokens, now);
    if (!verdict.ok) return verdict;
    keyState.requestTimes.push(now);
    if (estimatedTokens > 0) keyState.tokenEvents.push({ t: now, tokens: estimatedTokens });
    keyState.day.requests += 1;
    keyState.day.tokens += estimatedTokens;
    keyState.month.tokens += estimatedTokens;
    keyState.stats.attempts += 1;
    keyState.stats.lastUsedAt = new Date(now).toISOString();
    return { ok: true };
  }

  /** Commit real token usage after a successful completion. */
  commit(keyState, usage = {}, model = null) {
    if (!keyState) return;
    const now = Date.now();
    this.#prune(keyState, now);
    const total = Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    if (total > 0) {
      keyState.tokenEvents.push({ t: now, tokens: total });
      keyState.day.tokens += total;
      keyState.month.tokens += total;
      keyState.stats.tokens += total;
    }
    keyState.stats.successes += 1;
    // Context-window overflow reported by the provider: treat as soft limit hint.
    if (model && usage.promptTokens && usage.promptTokens > model.contextWindow) {
      log.warn('key-pool', `${keyState.label} exceeded advertised context window`);
    }
  }

  /** Apply a cooldown after a 429 (or similar) upstream response. */
  penalize(keyState, { retryAfterSec = null, errorClass = 'RATE_LIMIT', model = null, message = '' } = {}) {
    if (!keyState) return;
    const now = Date.now();
    keyState.stats.errors += 1;
    keyState.stats.lastError = { at: new Date(now).toISOString(), errorClass, message: String(message).slice(0, 240) };

    if (errorClass === 'AUTH') {
      keyState.disabled = true;
      keyState.disabledUntil = now + config.cooldownAfterAuthFailureMs;
      keyState.cooldownUntil = keyState.disabledUntil;
      keyState.disabledReason = 'AUTH';
      keyState.stats.rateLimits += 0;
      log.warn('key-pool', `${keyState.label} auth failure — disabled for ${Math.round(config.cooldownAfterAuthFailureMs / 60000)}m`);
      return;
    }
    if (errorClass === 'RATE_LIMIT') keyState.stats.rateLimits += 1;

    const seconds = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : config.cooldownAfterRateLimitMs;
    keyState.cooldownUntil = Math.max(keyState.cooldownUntil, now + seconds);
    // Drain the current minute window so we do not immediately re-trip.
    if (errorClass === 'RATE_LIMIT' || errorClass === 'CAPACITY') {
      keyState.requestTimes = [];
      keyState.tokenEvents = [];
    }
    log.warn('key-pool', `${keyState.label} penalised (${errorClass}) for ${Math.round(seconds / 1000)}s${model ? ` model=${model.id}` : ''}`);
  }

  disable(keyState, reason) {
    if (!keyState) return;
    keyState.disabled = true;
    keyState.disabledReason = reason;
    log.error('key-pool', `${keyState.label} disabled: ${reason}`);
  }

  enable(keyState) {
    if (!keyState) return;
    keyState.disabled = false;
    keyState.disabledReason = null;
    keyState.cooldownUntil = 0;
  }

  /** Update learned rpm/tpm from provider headers (registry.learnFromHeaders). */
  learnFromHeaders(keyState, headers) {
    if (!keyState) return;
    const spec = policyStore.learnFromHeaders(keyState.providerId);
    if (!spec || !headers?.get) return;
    const readNumber = (name) => {
      if (!name) return null;
      const v = headers.get(name);
      if (!v) return null;
      const n = Number.parseInt(String(v).replace(/[^\d-]/g, ''), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const rpm = readNumber(spec.rpm);
    const tpm = readNumber(spec.tpm);
    if (rpm && rpm !== keyState.learned.rpm) {
      keyState.learned.rpm = rpm;
      log.info('key-pool', `${keyState.label} learned rpm=${rpm}`);
    }
    if (tpm && tpm !== keyState.learned.tpm) {
      keyState.learned.tpm = tpm;
      log.info('key-pool', `${keyState.label} learned tpm=${tpm}`);
    }
  }

  /** Housekeeping called by watchdog.mjs */
  sweep(now = Date.now()) {
    let pruned = 0;
    for (const states of this.#keys.values()) {
      for (const k of states) {
        this.#prune(k, now);
        if (k.disabled && k.disabledUntil && k.disabledUntil <= now) {
          k.disabled = false;
          k.disabledUntil = 0;
          k.disabledReason = null;
          pruned += 1;
        }
        if (k.cooldownUntil && k.cooldownUntil <= now && !k.disabled) {
          k.cooldownUntil = 0;
          pruned += 1;
        }
      }
    }
    return { pruned };
  }

  /** Earliest time any key of a provider becomes usable again (ms from now). */
  soonestAvailability(providerId, now = Date.now()) {
    const states = this.keysFor(providerId);
    if (!states.length) return Infinity;
    const waiting = states.filter((k) => k.cooling).map((k) => (k.disabled ? Infinity : k.cooldownUntil - now));
    if (waiting.length < states.length) return 0;
    return waiting.length ? Math.max(0, Math.min(...waiting.filter((n) => Number.isFinite(n)))) : 0;
  }

  stats() {
    const providers = [];
    let totalKeys = 0;
    let availableKeys = 0;
    for (const [providerId, states] of this.#keys.entries()) {
      const now = Date.now();
      const avail = states.filter((k) => !k.cooling).length;
      totalKeys += states.length;
      availableKeys += avail;
      providers.push({
        id: providerId,
        name: policyStore.provider(providerId)?.name ?? providerId,
        keys: states.length,
        available: avail,
        cooling: states.length - avail,
        models: policyStore.modelsForProvider(providerId).length,
        soonestAvailabilityMs: states.length && avail === 0 ? this.soonestAvailability(providerId, now) : 0,
        keyDetails: states.map((k) => ({
          label: k.label,
          cooling: k.cooling,
          cooldownRemainingMs: Number.isFinite(k.cooldownMsRemaining()) ? k.cooldownMsRemaining() : null,
          rpmUsed: k.requestTimes.length,
          learned: { ...k.learned },
          day: { bucket: k.day.bucket, requests: k.day.requests, tokens: k.day.tokens },
          stats: { ...k.stats },
        })),
      });
    }
    return { totalKeys, availableKeys, providers };
  }
}

export const keyPool = new KeyPool();
export { KeyState };
export default keyPool;
