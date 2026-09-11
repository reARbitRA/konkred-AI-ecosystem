/**
 * Candidate ranking: turns a task type + privacy requirement into an ordered
 * list of {model, key} attempts that the gateway will try in sequence.
 */
import { policyStore } from '../policy-store.mjs';
import { keyPool } from './key-pool.mjs';
import { config } from '../config.mjs';
import { log } from '../util.mjs';

/**
 * @param {object} opts
 * @param {string} opts.taskType
 * @param {'private'|'any'|'training-ok'} [opts.privacy]
 * @param {string} [opts.preferredModel]
 * @param {number} opts.estimatedTokens
 * @param {number} [opts.maxAttempts]
 * @param {Set<string>} [opts.excludeModels]
 * @returns {Array<{model:object, key:object, score:number, reason:string}>}
 */
export const rankCandidates = ({
  taskType = 'general',
  privacy = 'any',
  preferredModel = null,
  estimatedTokens = 0,
  maxAttempts = config.maxAttempts,
  excludeModels = new Set(),
}) => {
  const pref = policyStore.taskPreference(taskType);
  const requirePrivate = String(privacy).toLowerCase() === 'private';
  const candidates = [];

  for (const model of policyStore.models) {
    if (excludeModels.has(model.id)) continue;

    const provider = policyStore.provider(model.providerId);
    if (!provider) continue;
    if (requirePrivate && provider.trainsOnData) continue;

    // The mock simulator is only eligible in demo mode or as genuine last resort.
    if (model.providerId === 'mock' && !config.demoMock && !config.mockFallback) continue;

    const keys = keyPool.availableKeys(model.providerId);
    if (!keys.length) continue;

    for (const key of keys) {
      const verdict = keyPool.check(key, model, estimatedTokens);
      if (!verdict.ok) continue;

      const prefIndex = pref.prefer.indexOf(model.id);
      const qualityDelta = Math.abs(model.quality - pref.quality);
      let score = 100;
      if (prefIndex >= 0) score -= 40 + prefIndex * 3; // explicit task preference dominates
      score -= model.quality * 4; // higher quality first
      score += qualityDelta * 6; // but stay close to the task's ideal quality
      score += model.providerId === 'mock' ? 60 : 0; // real providers before the simulator
      if (model.confidence === 'high') score -= 4;
      if (model.contextWindow && estimatedTokens > model.contextWindow * 0.8) score += 15;
      if (preferredModel && model.id === preferredModel) score -= 200;
      if (preferredModel && model.modelName === preferredModel) score -= 180;

      candidates.push({ model, key, score, reason: prefIndex >= 0 ? `task-preference#${prefIndex}` : 'capacity' });
    }
  }

  candidates.sort((a, b) => a.score - b.score || a.model.id.localeCompare(b.model.id));

  // Prefer distinct providers at the top of the list so one saturated vendor
  // cannot burn every attempt slot.
  const interleaved = [];
  const seenProviders = new Set();
  const rest = [];
  for (const c of candidates) {
    if (!seenProviders.has(c.model.providerId) && !rest.length) {
      seenProviders.add(c.model.providerId);
      interleaved.push(c);
    } else {
      rest.push(c);
    }
  }
  const ordered = [...interleaved, ...rest];

  // Collapse duplicate (model,key) pairs, then cap the attempt count.
  const unique = [];
  const seen = new Set();
  for (const c of ordered) {
    const id = `${c.model.id}|${c.key.label}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(c);
    if (unique.length >= Math.max(1, maxAttempts)) break;
  }

  if (!unique.length) {
    log.warn('router', 'no candidates available', { taskType, privacy, estimatedTokens });
  }
  return unique;
};

/** Human readable reason for total capacity exhaustion + Retry-After hint. */
export const capacityExhaustion = ({ privacy = 'any', preferredModel = null, estimatedTokens = 0 } = {}) => {
  const requirePrivate = String(privacy).toLowerCase() === 'private';
  let soonestMs = Infinity;
  let considered = 0;

  for (const model of policyStore.models) {
    const provider = policyStore.provider(model.providerId);
    if (!provider) continue;
    if (requirePrivate && provider.trainsOnData) continue;
    if (preferredModel && model.id !== preferredModel && model.modelName !== preferredModel) continue;
    if (model.contextWindow && estimatedTokens > model.contextWindow) continue;

    const keys = keyPool.keysFor(model.providerId);
    if (!keys.length) continue;
    considered += 1;

    for (const key of keys) {
      const verdict = keyPool.check(key, model, estimatedTokens);
      if (verdict.ok) return { exhausted: false, retryAfterMs: 0 };
      if (Number.isFinite(verdict.retryAfterMs)) soonestMs = Math.min(soonestMs, verdict.retryAfterMs);
    }
  }

  if (!considered) return { exhausted: true, retryAfterMs: 0, reason: 'NO_PROVIDER_CREDENTIALS' };
  return {
    exhausted: true,
    retryAfterMs: Number.isFinite(soonestMs) ? soonestMs : config.cooldownAfterRateLimitMs,
    reason: 'ALL_QUOTAS_EXHAUSTED',
  };
};

export default rankCandidates;
