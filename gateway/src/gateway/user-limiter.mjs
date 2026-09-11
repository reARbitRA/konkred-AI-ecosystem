/**
 * Per-caller (API key / user) sliding-window limiter.
 * Enforces tier budgets declared in TIER_LIMITS (config.mjs) and returns a
 * Retry-After hint so clients (the Telegram bot) can back off politely.
 */
import { config } from '../config.mjs';
import { dayBucket, log } from '../util.mjs';

const MINUTE_MS = 60_000;

class CallerState {
  constructor(userId, tier) {
    this.userId = userId;
    this.tier = tier;
    this.requestTimes = [];
    this.day = { bucket: null, requests: 0, tokens: 0 };
    this.stats = { total: 0, rejected: 0, tokens: 0, lastSeenAt: null };
  }
}

class UserLimiter {
  #callers = new Map();

  /** Resolve credentials to a caller identity + tier. Returns null when rejected. */
  authenticate(apiKey) {
    const key = String(apiKey ?? '').trim();
    if (!key) {
      return config.allowAnonymous
        ? { userId: 'anonymous', tier: config.anonymousTier, key: null }
        : null;
    }
    const user = config.users.find((u) => String(u?.key ?? '') === key);
    if (!user) return null;
    return {
      userId: String(user.userId ?? user.id ?? 'unknown'),
      tier: String(user.tier ?? 'standard'),
      key,
    };
  }

  #state(userId, tier) {
    let state = this.#callers.get(userId);
    if (!state) {
      state = new CallerState(userId, tier);
      this.#callers.set(userId, state);
    }
    state.tier = tier;
    return state;
  }

  #limits(tier) {
    return config.tierLimits[tier] ?? config.tierLimits.standard;
  }

  #prune(state, now) {
    const cutoff = now - MINUTE_MS;
    while (state.requestTimes.length && state.requestTimes[0] < cutoff) state.requestTimes.shift();
    const today = dayBucket('utc-midnight', now);
    if (state.day.bucket !== today) state.day = { bucket: today, requests: 0, tokens: 0 };
  }

  /**
   * Pre-flight admission check.
   * @returns {{ok:true, remaining:{rpm:number,rpd:number}}|{ok:false, retryAfterSec:number, reason:string, limit:object}}
   */
  check(userId, tier, estimatedTokens = 0, now = Date.now()) {
    const state = this.#state(userId, tier);
    this.#prune(state, now);
    const limits = this.#limits(tier);

    if (limits.rpm > 0 && state.requestTimes.length + 1 > limits.rpm) {
      const oldest = state.requestTimes[0] ?? now;
      return {
        ok: false,
        reason: 'USER_RPM',
        retryAfterSec: Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000)),
        limits,
      };
    }
    if (limits.rpd > 0 && state.day.requests + 1 > limits.rpd) {
      const secondsLeft = Math.max(1, Math.ceil((nextUtcMidnight(now) - now) / 1000));
      return { ok: false, reason: 'USER_RPD', retryAfterSec: secondsLeft, limits };
    }
    if (limits.tpd > 0 && estimatedTokens > 0 && state.day.tokens + estimatedTokens > limits.tpd) {
      const secondsLeft = Math.max(1, Math.ceil((nextUtcMidnight(now) - now) / 1000));
      return { ok: false, reason: 'USER_TPD', retryAfterSec: secondsLeft, limits };
    }
    return {
      ok: true,
      remaining: {
        rpm: limits.rpm > 0 ? Math.max(0, limits.rpm - state.requestTimes.length - 1) : null,
        rpd: limits.rpd > 0 ? Math.max(0, limits.rpd - state.day.requests - 1) : null,
      },
    };
  }

  record(userId, tier, estimatedTokens = 0, now = Date.now()) {
    const state = this.#state(userId, tier);
    this.#prune(state, now);
    state.requestTimes.push(now);
    state.day.requests += 1;
    state.day.tokens += estimatedTokens;
    state.stats.total += 1;
    state.stats.tokens += estimatedTokens;
    state.stats.lastSeenAt = new Date(now).toISOString();
    return state;
  }

  recordTokens(userId, tokens) {
    const state = this.#callers.get(userId);
    if (!state || !(tokens > 0)) return;
    state.day.tokens += tokens;
    state.stats.tokens += tokens;
  }

  reject(userId, tier, now = Date.now()) {
    const state = this.#state(userId, tier);
    this.#prune(state, now);
    state.stats.rejected += 1;
    state.stats.lastSeenAt = new Date(now).toISOString();
  }

  stats() {
    const now = Date.now();
    return [...this.#callers.values()].map((s) => {
      this.#prune(s, now);
      const limits = this.#limits(s.tier);
      return {
        userId: s.userId,
        tier: s.tier,
        rpmUsed: s.requestTimes.length,
        rpmLimit: limits.rpm,
        day: { ...s.day },
        stats: { ...s.stats },
      };
    });
  }

  reset(userId) {
    if (userId) return this.#callers.delete(userId);
    this.#callers.clear();
    log.info('user-limiter', 'all caller windows reset');
    return true;
  }
}

const nextUtcMidnight = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
};

export const userLimiter = new UserLimiter();
export default userLimiter;
