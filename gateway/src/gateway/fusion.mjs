/**
 * Normalises every provider response into one canonical envelope and provides
 * prompt-shaping helpers (context trimming) used by the fallback engine.
 */
import { estimateTokens } from '../util.mjs';

/**
 * @returns {{content:string, provider:string, model:string, modelId:string,
 *            usage:{promptTokens:number,completionTokens:number,totalTokens:number},
 *            finishReason:string|null, latencyMs:number}}
 */
export const normalizeResult = ({
  content,
  providerId,
  model,
  usage = {},
  finishReason = null,
  latencyMs = 0,
  raw = null,
}) => ({
  content: typeof content === 'string' ? content : String(content ?? ''),
  provider: providerId,
  providerName: providerId,
  model: model?.modelName ?? 'unknown',
  modelId: model?.id ?? 'unknown',
  usage: {
    promptTokens: Number(usage.promptTokens ?? 0) || 0,
    completionTokens: Number(usage.completionTokens ?? 0) || 0,
    totalTokens: Number(usage.totalTokens ?? 0) || 0,
  },
  finishReason: finishReason ?? null,
  latencyMs: Math.round(latencyMs),
  raw: raw ?? null,
});

const SYSTEM_ROLES = new Set(['system', 'developer']);

/**
 * Trim a message list so it fits inside `budgetTokens`, always preserving the
 * system prompt(s) and the final user turn.
 */
export const trimMessages = (messages, budgetTokens, { dropRatio = 0.45 } = {}) => {
  if (!Array.isArray(messages) || messages.length === 0) return { messages: [], trimmed: false, tokens: 0 };

  const clean = messages
    .filter((m) => m && typeof m.content === 'string')
    .map((m) => ({ role: String(m.role ?? 'user'), content: m.content }));

  const totalTokens = clean.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0 || totalTokens <= budgetTokens) {
    return { messages: clean, trimmed: false, tokens: totalTokens };
  }

  const system = clean.filter((m) => SYSTEM_ROLES.has(m.role.toLowerCase()));
  const rest = clean.filter((m) => !SYSTEM_ROLES.has(m.role.toLowerCase()));
  const last = rest.length ? [rest[rest.length - 1]] : [];
  const middle = rest.slice(0, Math.max(0, rest.length - 1));

  // Drop the oldest `dropRatio` of the conversation first.
  const dropCount = Math.min(middle.length, Math.max(1, Math.ceil(middle.length * dropRatio)));
  let kept = [...system, ...middle.slice(dropCount), ...last];

  let tokens = kept.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);

  // Still too big? Hard-truncate the remaining middle turns from the front.
  while (tokens > budgetTokens && kept.length > system.length + last.length) {
    const firstNonSystem = kept.findIndex((m) => !SYSTEM_ROLES.has(m.role.toLowerCase()));
    if (firstNonSystem < 0) break;
    if (kept.length - 1 === firstNonSystem) break; // never drop the final turn
    kept.splice(firstNonSystem, 1);
    tokens = kept.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
  }

  // Last resort: truncate the final turn itself.
  if (tokens > budgetTokens && last.length) {
    const overhead = kept.reduce((s, m) => (m === last[0] ? s : s + estimateTokens(m.content) + 4), 0);
    const allowChars = Math.max(512, (budgetTokens - overhead) * 4);
    kept = kept.map((m) => (m === last[0] && m.content.length > allowChars ? { ...m, content: m.content.slice(-allowChars) } : m));
    tokens = kept.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
  }

  return { messages: kept, trimmed: true, tokens, droppedTurns: clean.length - kept.length };
};

/** Merge attempt metadata into the final response payload. */
export const buildResponseData = ({ result, cached = false, attempts = [], deduplicated = false, taskType, privacy }) => ({
  ...result,
  cached,
  deduplicated,
  taskType,
  privacy,
  attempts: attempts.map((a) => ({
    modelId: a.modelId,
    provider: a.provider,
    status: a.status ?? null,
    errorClass: a.errorClass ?? null,
    message: a.message ?? null,
    latencyMs: a.latencyMs ?? 0,
  })),
  attemptCount: attempts.length,
});

export default normalizeResult;
