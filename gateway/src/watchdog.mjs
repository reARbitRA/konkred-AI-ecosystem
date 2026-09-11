/**
 * Background maintenance: window pruning, cache sweeping, capacity logging
 * and optional provider health probing.
 */
import { config } from './config.mjs';
import { keyPool } from './gateway/key-pool.mjs';
import { responseCache } from './gateway/cache.mjs';
import { deduper } from './gateway/dedup.mjs';
import { log } from './util.mjs';

let timer = null;
let ticks = 0;
let lastReport = null;

const tick = () => {
  ticks += 1;
  try {
    const swept = keyPool.sweep();
    const expiredCacheEntries = responseCache.sweep();
    const pool = keyPool.stats();
    lastReport = {
      at: new Date().toISOString(),
      tick: ticks,
      keys: { total: pool.totalKeys, available: pool.availableKeys },
      providers: pool.providers.map((p) => ({ id: p.id, available: p.available, keys: p.keys })),
      cache: responseCache.stats(),
      dedup: deduper.stats(),
      pruned: swept.pruned,
      expiredCacheEntries,
    };
    const saturated = pool.providers.filter((p) => p.keys > 0 && p.available === 0);
    if (saturated.length) {
      log.warn('watchdog', `providers fully cooling: ${saturated.map((p) => p.id).join(', ')}`);
    } else {
      log.info('watchdog', `ok — ${pool.availableKeys}/${pool.totalKeys} keys available, cache=${lastReport.cache.live}/${lastReport.cache.entries}`);
    }
  } catch (err) {
    log.error('watchdog', `tick failed: ${err?.stack ?? err}`);
  }
};

export const startWatchdog = () => {
  if (!config.watchdogEnabled) {
    log.info('watchdog', 'disabled');
    return null;
  }
  if (timer) return timer;
  timer = setInterval(tick, Math.max(5000, config.watchdogIntervalMs));
  timer.unref?.();
  log.info('watchdog', `started (interval=${config.watchdogIntervalMs}ms)`);
  return timer;
};

export const stopWatchdog = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

export const watchdogStatus = () => ({ enabled: config.watchdogEnabled, intervalMs: config.watchdogIntervalMs, ticks, lastReport });

export default startWatchdog;
