/**
 * Per-error-class fallback policy.
 *
 * Each upstream failure is classified (util.classifyError) and mapped to a
 * decision telling the gateway how to spend its next attempt:
 *   - SAME_MODEL_NEXT_KEY : another credential for the same model
 *   - NEXT_MODEL          : move on to the next ranked candidate
 *   - TRIM_CONTEXT        : shorten history, retry the same model
 *   - BACKOFF             : sleep, then retry the same candidate
 *   - ABORT               : stop and surface the error to the caller
 */
import { ERROR_CLASS } from '../util.mjs';

export const DECISION = Object.freeze({
  SAME_MODEL_NEXT_KEY: 'SAME_MODEL_NEXT_KEY',
  NEXT_MODEL: 'NEXT_MODEL',
  TRIM_CONTEXT: 'TRIM_CONTEXT',
  BACKOFF: 'BACKOFF',
  ABORT: 'ABORT',
});

/**
 * @param {object} ctx
 * @param {string} ctx.errorClass        one of ERROR_CLASS
 * @param {number} ctx.status            upstream HTTP status (0 = network)
 * @param {number} ctx.attempt           1-based attempt counter
 * @param {number} ctx.maxAttempts
 * @param {number} ctx.sameModelFailures consecutive failures on the current model
 * @param {boolean} ctx.hasMoreKeys      another key exists for this provider
 * @param {boolean} ctx.hasMoreCandidates
 * @param {number|null} ctx.retryAfterSec
 * @param {boolean} ctx.contextTrimmed   whether we already retried with a trimmed prompt
 */
export const decideFallback = (ctx) => {
  const {
    errorClass,
    status = 0,
    attempt = 1,
    maxAttempts = 6,
    sameModelFailures = 0,
    hasMoreKeys = false,
    hasMoreCandidates = false,
    retryAfterSec = null,
    contextTrimmed = false,
  } = ctx ?? {};

  const exhausted = attempt >= maxAttempts;
  const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? Math.min(30_000, retryAfterSec * 1000)
    : Math.min(4000, 300 * 2 ** Math.max(0, attempt - 1));

  switch (errorClass) {
    case ERROR_CLASS.RATE_LIMIT:
      // 429 with a key-level budget: burn another key first, then another model.
      if (hasMoreKeys) return { decision: DECISION.SAME_MODEL_NEXT_KEY, delayMs: 0 };
      if (hasMoreCandidates) return { decision: DECISION.NEXT_MODEL, delayMs: Math.min(backoff, 1500) };
      return { decision: exhausted ? DECISION.ABORT : DECISION.BACKOFF, delayMs: backoff };

    case ERROR_CLASS.CAPACITY:
      // 503/529 "overloaded": do not waste time on the same key.
      if (hasMoreCandidates) return { decision: DECISION.NEXT_MODEL, delayMs: 250 };
      if (hasMoreKeys) return { decision: DECISION.SAME_MODEL_NEXT_KEY, delayMs: 500 };
      return { decision: exhausted ? DECISION.ABORT : DECISION.BACKOFF, delayMs: backoff };

    case ERROR_CLASS.AUTH:
      // Credential rejected: never retry the same key, jump provider.
      if (hasMoreCandidates) return { decision: DECISION.NEXT_MODEL, delayMs: 0 };
      if (hasMoreKeys) return { decision: DECISION.SAME_MODEL_NEXT_KEY, delayMs: 0 };
      return { decision: DECISION.ABORT, delayMs: 0 };

    case ERROR_CLASS.CONTEXT_LENGTH:
      if (!contextTrimmed) return { decision: DECISION.TRIM_CONTEXT, delayMs: 0 };
      if (hasMoreCandidates) return { decision: DECISION.NEXT_MODEL, delayMs: 0 };
      return { decision: DECISION.ABORT, delayMs: 0 };

    case ERROR_CLASS.TIMEOUT:
    case ERROR_CLASS.NETWORK:
      if (sameModelFailures < 2 && hasMoreKeys) return { decision: DECISION.SAME_MODEL_NEXT_KEY, delayMs: 200 };
      if (hasMoreCandidates) return { decision: DECISION.NEXT_MODEL, delayMs: 200 };
      return { decision: exhausted ? DECISION.ABORT : DECISION.BACKOFF, delayMs: backoff };

    case ERROR_CLASS.UPSTREAM:
      if (hasMoreCandidates) return { decision: DECISION.NEXT_MODEL, delayMs: 400 };
      return { decision: exhausted ? DECISION.ABORT : DECISION.BACKOFF, delayMs: backoff };

    case ERROR_CLASS.CONTENT_FILTER:
    case ERROR_CLASS.INVALID_REQUEST:
      // Caller-side problems are not fixable by failover.
      return { decision: DECISION.ABORT, delayMs: 0 };

    default:
      if (hasMoreCandidates) return { decision: DECISION.NEXT_MODEL, delayMs: 300 };
      return { decision: exhausted ? DECISION.ABORT : DECISION.BACKOFF, delayMs: backoff };
  }
};

/** HTTP status the gateway should return for a terminal error class. */
export const statusForClass = (errorClass, fallbackStatus = 502) => {
  switch (errorClass) {
    case ERROR_CLASS.RATE_LIMIT:
      return 429;
    case ERROR_CLASS.CAPACITY:
      return 503;
    case ERROR_CLASS.AUTH:
      return 502;
    case ERROR_CLASS.CONTEXT_LENGTH:
      return 413;
    case ERROR_CLASS.CONTENT_FILTER:
      return 451;
    case ERROR_CLASS.INVALID_REQUEST:
      return 400;
    case ERROR_CLASS.TIMEOUT:
      return 504;
    default:
      return fallbackStatus;
  }
};

export default decideFallback;
