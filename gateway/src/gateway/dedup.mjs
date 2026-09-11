/**
 * In-flight request de-duplication.
 * Two identical prompts arriving simultaneously share one upstream attempt
 * (and therefore one unit of quota) instead of paying for it twice.
 */
import { config } from '../config.mjs';

class Deduper {
  #inflight = new Map(); // key -> { promise, startedAt, waiters }

  has(key) {
    const entry = this.#inflight.get(key);
    if (!entry) return false;
    if (Date.now() - entry.startedAt > config.dedupTtlMs) {
      this.#inflight.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Run `factory()` at most once per key while a previous run is in flight.
   * @returns {Promise<{result:any, deduplicated:boolean, waiters:number}>}
   */
  async run(key, factory) {
    if (!config.dedupEnabled || !key) {
      const result = await factory();
      return { result, deduplicated: false, waiters: 0 };
    }

    const existing = this.#inflight.get(key);
    if (existing && Date.now() - existing.startedAt <= config.dedupTtlMs) {
      existing.waiters += 1;
      const result = await existing.promise;
      return { result, deduplicated: true, waiters: existing.waiters };
    }

    const entry = { startedAt: Date.now(), waiters: 0, promise: null };
    entry.promise = (async () => {
      try {
        return await factory();
      } finally {
        // Keep the entry briefly so near-simultaneous retries still coalesce,
        // but never longer than the configured TTL.
        setTimeout(() => {
          if (this.#inflight.get(key) === entry) this.#inflight.delete(key);
        }, Math.min(5000, config.dedupTtlMs)).unref?.();
      }
    })();
    this.#inflight.set(key, entry);

    try {
      const result = await entry.promise;
      return { result, deduplicated: false, waiters: entry.waiters };
    } finally {
      if (this.#inflight.get(key) === entry) this.#inflight.delete(key);
    }
  }

  clear() {
    this.#inflight.clear();
  }

  stats() {
    return { inflight: this.#inflight.size, enabled: config.dedupEnabled, ttlMs: config.dedupTtlMs };
  }
}

export const deduper = new Deduper();
export default deduper;
