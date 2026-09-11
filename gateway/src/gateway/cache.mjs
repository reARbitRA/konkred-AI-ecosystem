/**
 * Bounded in-memory LRU response cache.
 * Key = sha256(taskType + normalised messages + sampling params).
 */
import { config } from '../config.mjs';
import { sha256, safeJson, log } from '../util.mjs';

class ResponseCache {
  #store = new Map(); // insertion ordered => LRU via delete+set

  get size() {
    return this.#store.size;
  }

  static keyFor({ taskType, messages, maxTokens, temperature, privacy, model = null }) {
    const normalised = Array.isArray(messages)
      ? messages.map((m) => ({ role: String(m?.role ?? 'user'), content: String(m?.content ?? '') }))
      : [];
    return sha256(
      safeJson({
        t: String(taskType ?? 'general').toLowerCase(),
        m: normalised,
        k: Number(maxTokens ?? 0),
        p: Number(temperature ?? 0),
        v: String(privacy ?? 'any'),
        x: model ? String(model) : null,
      }),
    );
  }

  get(cacheKey) {
    if (!config.cacheEnabled || !cacheKey) return null;
    const entry = this.#store.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.#store.delete(cacheKey);
      return null;
    }
    // Refresh recency
    this.#store.delete(cacheKey);
    this.#store.set(cacheKey, entry);
    entry.hits += 1;
    return entry.value;
  }

  set(cacheKey, value, ttlMs = config.cacheTtlMs) {
    if (!config.cacheEnabled || !cacheKey || !value) return false;
    if (this.#store.has(cacheKey)) this.#store.delete(cacheKey);
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : config.cacheTtlMs;
    this.#store.set(cacheKey, { value, expiresAt: Date.now() + ttl, hits: 0, storedAt: Date.now() });
    while (this.#store.size > config.cacheMaxEntries) {
      const oldest = this.#store.keys().next().value;
      if (oldest === undefined) break;
      this.#store.delete(oldest);
    }
    return true;
  }

  invalidate(cacheKey) {
    if (cacheKey) return this.#store.delete(cacheKey);
    const count = this.#store.size;
    this.#store.clear();
    log.info('cache', `flushed ${count} entries`);
    return count;
  }

  stats() {
    const now = Date.now();
    let live = 0;
    let hits = 0;
    for (const e of this.#store.values()) {
      if (e.expiresAt >= now) live += 1;
      hits += e.hits;
    }
    return { entries: this.#store.size, live, hits, maxEntries: config.cacheMaxEntries, ttlMs: config.cacheTtlMs, enabled: config.cacheEnabled };
  }

  /** Drop expired entries (called by the watchdog). */
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [k, e] of this.#store.entries()) {
      if (e.expiresAt < now) {
        this.#store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}

export const responseCache = new ResponseCache();
export default responseCache;
