/**
 * Konkred Gateway HTTP server (Node 20+, zero runtime dependencies).
 *
 * Routes
 *   GET  /                 HTML dashboard
 *   GET  /api/health       liveness      (public)
 *   GET  /api/ready        readiness     (public) — 503 when no capacity
 *   POST /api/ai           inference     (x-api-key)
 *   GET  /api/models       registry      (x-api-key)
 *   GET  /api/status       deep status   (x-admin-key)
 *   POST /api/admin/cache/flush          (x-admin-key)
 */
import http from 'node:http';
import { config, enabledProviderIds } from './config.mjs';
import { policyStore } from './policy-store.mjs';
import { keyPool } from './gateway/key-pool.mjs';
import { initProviders, providerStats, activeProviderIds } from './providers/index.mjs';
import { responseCache } from './gateway/cache.mjs';
import { userLimiter } from './gateway/user-limiter.mjs';
import { runInference, validateRequest, gatewayStats, GatewayError } from './gateway/gateway.mjs';
import { startWatchdog, stopWatchdog, watchdogStatus } from './watchdog.mjs';
import { renderDashboard } from './dashboard.mjs';
import { log, readJsonBody, sendJson, sendHtml, safeEqual, randomId, parseApiKey } from './util.mjs';

const startedAt = Date.now();
let requestCount = 0;

/* ------------------------------------------------------------------ *
 * Boot sequence
 * ------------------------------------------------------------------ */
policyStore.load();
keyPool.init();
initProviders();
startWatchdog();

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
const authenticate = (req) => {
  const key = parseApiKey(req.headers);
  if (!key) {
    if (config.allowAnonymous) return { userId: 'anonymous', tier: config.anonymousTier, key: null };
    throw new GatewayError(401, 'MISSING_API_KEY', 'Provide an API key via the "x-api-key" header or "Authorization: Bearer <key>"');
  }
  const caller = userLimiter.authenticate(key);
  if (!caller) throw new GatewayError(401, 'INVALID_API_KEY', 'The supplied API key is not present in USERS_JSON');
  return caller;
};

const requireAdmin = (req) => {
  const adminKey = req.headers['x-admin-key'] ?? parseApiKey(req.headers);
  if (!config.adminKey) throw new GatewayError(503, 'ADMIN_DISABLED', 'ADMIN_KEY is not configured on this gateway');
  if (!adminKey || !safeEqual(adminKey, config.adminKey)) throw new GatewayError(403, 'FORBIDDEN', 'Invalid admin credentials');
  return true;
};

/* ------------------------------------------------------------------ *
 * Route handlers
 * ------------------------------------------------------------------ */
const healthPayload = () => {
  const pool = keyPool.stats();
  return {
    status: 'ok',
    service: 'konkred-gateway',
    version: '2.0.0',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    requestsServed: requestCount,
    time: new Date().toISOString(),
    registry: { models: policyStore.models.length, providers: policyStore.providers.size, builtAt: policyStore.summary().registryBuiltAt },
    providers: activeProviderIds(),
    pool: { keys: pool.totalKeys, available: pool.availableKeys },
    cache: responseCache.stats(),
  };
};

const handleHealth = (req, res) => sendJson(res, 200, { ok: true, data: healthPayload() });

const handleReady = (req, res) => {
  const payload = healthPayload();
  const ready = payload.pool.available > 0 || config.demoMock;
  return sendJson(res, ready ? 200 : 503, {
    ok: ready,
    data: { ...payload, ready },
    ...(ready ? {} : { error: { code: 'NO_CAPACITY', message: 'Every configured key is cooling down' } }),
  });
};

const handleModels = (req, res) => {
  authenticate(req);
  return sendJson(res, 200, {
    ok: true,
    data: {
      taskTypes: policyStore.knownTaskTypes(),
      models: policyStore.models.map((m) => ({
        ...m,
        trainsOnData: policyStore.trainsOnData(m.providerId),
        available: keyPool.availableKeys(m.providerId).length > 0,
      })),
    },
  });
};

const handleStatus = (req, res) => {
  requireAdmin(req);
  return sendJson(res, 200, { ok: true, data: { ...gatewayStats(), providers: providerStats(), watchdog: watchdogStatus(), health: healthPayload() } });
};

const handleAi = async (req, res) => {
  const requestId = randomId();
  const caller = authenticate(req);
  const body = await readJsonBody(req, config.requestBodyLimitBytes);
  const request = validateRequest(body);

  const t0 = Date.now();
  const data = await runInference(request, { caller, requestId });

  return sendJson(res, 200, {
    ok: true,
    requestId,
    data: { ...data, cached: Boolean(data.cached) },
    meta: { totalLatencyMs: Date.now() - t0, caller: { userId: caller.userId, tier: caller.tier } },
  }, data.attemptCount ? { 'x-konkred-attempts': String(data.attemptCount) } : {});
};

const handleFlushCache = (req, res) => {
  requireAdmin(req);
  const removed = responseCache.invalidate(null);
  return sendJson(res, 200, { ok: true, data: { flushed: removed } });
};

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */
const routes = [
  { method: 'GET', path: '/api/health', handler: handleHealth },
  { method: 'GET', path: '/healthz', handler: handleHealth },
  { method: 'GET', path: '/api/ready', handler: handleReady },
  { method: 'GET', path: '/readyz', handler: handleReady },
  { method: 'GET', path: '/api/models', handler: handleModels },
  { method: 'GET', path: '/api/status', handler: handleStatus },
  { method: 'POST', path: '/api/ai', handler: handleAi },
  { method: 'POST', path: '/api/admin/cache/flush', handler: handleFlushCache },
];

const server = http.createServer((req, res) => {
  requestCount += 1;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  res.setHeader('X-Request-Id', randomId());

  const route = routes.find((r) => r.path === pathname);
  if (!route) {
    if (pathname === '/' || pathname === '/dashboard') {
      if (!config.dashboardEnabled) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Dashboard disabled' } });
      try {
        return sendHtml(res, 200, renderDashboard());
      } catch (err) {
        log.error('http', `dashboard render failed: ${err.message}`);
        return sendJson(res, 500, { ok: false, error: { code: 'DASHBOARD_ERROR', message: err.message } });
      }
    }
    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${pathname}` } });
  }
  if (route.method !== req.method) {
    return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${route.method} ${pathname}` } }, { Allow: route.method });
  }

  return Promise.resolve()
    .then(() => route.handler(req, res))
    .catch((err) => {
      if (err instanceof GatewayError) {
        return sendJson(res, err.status, { ok: false, error: err.toJSON() }, err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {});
      }
      const status = Number(err?.status ?? 500);
      const code = String(err?.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'));
      if (status >= 500) log.error('http', `${code}: ${err?.stack ?? err}`);
      return sendJson(res, status, { ok: false, error: { code, message: err?.message ?? 'Request failed' } });
    });
});

server.headersTimeout = Math.max(65_000, config.attemptTimeoutMs + 5000);
server.requestTimeout = 0; // long-running inference requests are governed by attemptTimeoutMs
server.keepAliveTimeout = 65_000;

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server', `${signal} received — draining`);
  stopWatchdog();
  server.close(() => {
    log.info('server', 'closed cleanly');
    process.exit(0);
  });
  setTimeout(() => {
    log.warn('server', 'forced exit after drain timeout');
    process.exit(1);
  }, 10_000).unref?.();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('process', `unhandledRejection: ${reason?.stack ?? reason}`));
process.on('uncaughtException', (err) => {
  log.error('process', `uncaughtException: ${err?.stack ?? err}`);
  // Keep the container alive; the watchdog + healthcheck will surface real trouble.
});

server.listen(config.port, config.host, () => {
  log.info('server', `listening on http://${config.host}:${config.port}`, {
    providers: enabledProviderIds(),
    demoMock: config.demoMock,
    users: config.users.length,
    registry: config.registryPath,
  });
  if (!activeProviderIds().length) {
    log.warn('server', 'no provider adapters are active — set at least one provider key or DEMO_MOCK=true');
  }
});

export { server, healthPayload };
export default server;
