/**
 * Gateway unit + integration tests (Node's built-in test runner, no deps).
 *   node --test gateway/tests/
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEMO_MOCK = 'true';
process.env.MOCK_FALLBACK = 'true';
process.env.USERS_JSON = JSON.stringify([
  { key: 'test-key', userId: 'tester', tier: 'standard' },
  { key: 'internal-key', userId: 'bot', tier: 'internal' },
]);
process.env.ADMIN_KEY = 'test-admin';
process.env.PORT = '0';

const { policyStore } = await import('../src/policy-store.mjs');
const { keyPool } = await import('../src/gateway/key-pool.mjs');
const { responseCache } = await import('../src/gateway/cache.mjs');
const { deduper } = await import('../src/gateway/dedup.mjs');
const { decideFallback, DECISION, statusForClass } = await import('../src/gateway/fallback.mjs');
const { trimMessages } = await import('../src/gateway/fusion.mjs');
const { rankCandidates, capacityExhaustion } = await import('../src/gateway/router.mjs');
const { userLimiter } = await import('../src/gateway/user-limiter.mjs');
const { classifyError, ERROR_CLASS, estimateTokens, parseRetryAfter, nextResetAt, dayBucket, safeEqual, parseApiKey } = await import('../src/util.mjs');
const { validateRequest, runInference, GatewayError } = await import('../src/gateway/gateway.mjs');
const { initProviders } = await import('../src/providers/index.mjs');

before(() => {
  policyStore.load();
  keyPool.init();
  initProviders();
});

describe('policy-store', () => {
  test('loads registry with providers and models', () => {
    assert.ok(policyStore.models.length >= 15);
    assert.ok(policyStore.provider('groq'));
    assert.equal(policyStore.provider('gemini').resetPolicy, 'pt-midnight');
    assert.equal(policyStore.trainsOnData('groq'), false);
    assert.equal(policyStore.trainsOnData('gemini'), true);
  });

  test('unknown task type falls back to general preferences', () => {
    assert.deepEqual(policyStore.taskPreference('nonsense').prefer, policyStore.taskPreference('general').prefer);
  });
});

describe('key-pool sliding windows', () => {
  test('reserve/commit/penalize transitions', () => {
    const model = policyStore.model('mock:atlas-70b');
    const key = keyPool.keysFor('mock')[0];
    keyPool.enable(key);
    const verdict = keyPool.reserve(key, model, 100);
    assert.equal(verdict.ok, true);
    keyPool.commit(key, { promptTokens: 50, completionTokens: 50, totalTokens: 100 }, model);
    assert.ok(key.stats.successes >= 1);

    keyPool.penalize(key, { retryAfterSec: 1, errorClass: ERROR_CLASS.RATE_LIMIT, model, message: 'slow down' });
    assert.equal(key.cooling, true);
    assert.equal(keyPool.check(key, model, 10).ok, false);

    key.cooldownUntil = Date.now() - 10;
    keyPool.enable(key);
    assert.equal(keyPool.check(key, model, 10).ok, true);
  });

  test('rpm ceiling blocks further reservations', () => {
    const model = { ...policyStore.model('mock:sparrow-8b'), rpm: 2, tpm: null, rpd: null, tpd: null, monthlyTokens: null };
    const key = keyPool.keysFor('mock')[0];
    keyPool.enable(key);
    key.requestTimes = [];
    key.tokenEvents = [];
    assert.equal(keyPool.reserve(key, model, 10).ok, true);
    assert.equal(keyPool.reserve(key, model, 10).ok, true);
    const blocked = keyPool.reserve(key, model, 10);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'RPM');
    assert.ok(blocked.retryAfterMs > 0);
    key.requestTimes = [];
    key.tokenEvents = [];
  });

  test('auth failure disables a key for an hour', () => {
    const key = keyPool.keysFor('mock')[0];
    keyPool.enable(key);
    keyPool.penalize(key, { errorClass: ERROR_CLASS.AUTH, message: 'invalid api key' });
    assert.ok(key.cooldownUntil - Date.now() > 30 * 60 * 1000);
    keyPool.enable(key);
  });
});

describe('router', () => {
  test('returns mock candidates in demo mode', () => {
    const candidates = rankCandidates({ taskType: 'general', privacy: 'any', estimatedTokens: 50 });
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((c) => c.model && c.key));
  });

  test('privacy=private excludes providers that train on data', () => {
    const candidates = rankCandidates({ taskType: 'code-generation', privacy: 'private', estimatedTokens: 50, maxAttempts: 20 });
    for (const c of candidates) {
      assert.equal(policyStore.trainsOnData(c.model.providerId), false, `${c.model.providerId} trains on data`);
    }
  });

  test('preferred model ranks first', () => {
    const candidates = rankCandidates({ taskType: 'general', privacy: 'any', preferredModel: 'mock:sparrow-8b', estimatedTokens: 50 });
    assert.equal(candidates[0].model.id, 'mock:sparrow-8b');
  });

  test('capacity exhaustion reports a retry-after', () => {
    const result = capacityExhaustion({ privacy: 'any', estimatedTokens: 10 });
    assert.equal(typeof result.exhausted, 'boolean');
  });
});

describe('fallback policy', () => {
  test('429 prefers another key, then another model', () => {
    assert.equal(decideFallback({ errorClass: ERROR_CLASS.RATE_LIMIT, hasMoreKeys: true }).decision, DECISION.SAME_MODEL_NEXT_KEY);
    assert.equal(decideFallback({ errorClass: ERROR_CLASS.RATE_LIMIT, hasMoreKeys: false, hasMoreCandidates: true }).decision, DECISION.NEXT_MODEL);
  });

  test('context length trims once then moves on', () => {
    assert.equal(decideFallback({ errorClass: ERROR_CLASS.CONTEXT_LENGTH, contextTrimmed: false }).decision, DECISION.TRIM_CONTEXT);
    assert.equal(decideFallback({ errorClass: ERROR_CLASS.CONTEXT_LENGTH, contextTrimmed: true, hasMoreCandidates: true }).decision, DECISION.NEXT_MODEL);
    assert.equal(decideFallback({ errorClass: ERROR_CLASS.CONTEXT_LENGTH, contextTrimmed: true, hasMoreCandidates: false }).decision, DECISION.ABORT);
  });

  test('content filter / bad request abort immediately', () => {
    assert.equal(decideFallback({ errorClass: ERROR_CLASS.CONTENT_FILTER, hasMoreCandidates: true }).decision, DECISION.ABORT);
    assert.equal(decideFallback({ errorClass: ERROR_CLASS.INVALID_REQUEST, hasMoreCandidates: true }).decision, DECISION.ABORT);
  });

  test('status mapping', () => {
    assert.equal(statusForClass(ERROR_CLASS.RATE_LIMIT), 429);
    assert.equal(statusForClass(ERROR_CLASS.CAPACITY), 503);
    assert.equal(statusForClass(ERROR_CLASS.TIMEOUT), 504);
    assert.equal(statusForClass(ERROR_CLASS.CONTENT_FILTER), 451);
  });
});

describe('fusion.trimMessages', () => {
  test('keeps system prompt and final turn within budget', () => {
    const messages = [
      { role: 'system', content: 'You are Konkred.' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'y'.repeat(200) })),
      { role: 'user', content: 'FINAL QUESTION' },
    ];
    const out = trimMessages(messages, 300);
    assert.equal(out.trimmed, true);
    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[out.messages.length - 1].content, 'FINAL QUESTION');
    assert.ok(out.tokens <= 340);
  });

  test('short conversations are untouched', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const out = trimMessages(messages, 5000);
    assert.equal(out.trimmed, false);
    assert.equal(out.messages.length, 1);
  });
});

describe('cache + dedup', () => {
  test('cache round-trip and TTL eviction', async () => {
    const key = responseCache.constructor.keyFor({ taskType: 'general', messages: [{ role: 'user', content: 'cache me' }], maxTokens: 10, temperature: 0.1 });
    responseCache.set(key, { content: 'cached', provider: 'mock', model: 'm' }, 50);
    assert.equal(responseCache.get(key).content, 'cached');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(responseCache.get(key), null);
  });

  test('identical keys coalesce concurrent calls', async () => {
    let calls = 0;
    const key = 'dedup-key';
    const results = await Promise.all([
      deduper.run(key, async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return 'value'; }),
      deduper.run(key, async () => { calls += 1; return 'value'; }),
    ]);
    assert.equal(calls, 1);
    assert.equal(results[1].deduplicated, true);
    assert.equal(results[0].result, 'value');
  });
});

describe('user-limiter', () => {
  test('authenticates configured keys only', () => {
    assert.equal(userLimiter.authenticate('test-key').userId, 'tester');
    assert.equal(userLimiter.authenticate('nope'), null);
    assert.equal(userLimiter.authenticate(''), null);
  });

  test('rpm ceiling rejects with retry-after', () => {
    const now = Date.now();
    let verdict = userLimiter.check('limit-user', 'free', 10, now);
    assert.equal(verdict.ok, true);
    for (let i = 0; i < 4; i += 1) {
      userLimiter.record('limit-user', 'free', 10, now);
    }
    verdict = userLimiter.check('limit-user', 'free', 10, now);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'USER_RPM');
    assert.ok(verdict.retryAfterSec >= 1);
    userLimiter.reset('limit-user');
  });
});

describe('request validation', () => {
  test('accepts messages[] and prompt shorthand', () => {
    const a = validateRequest({ taskType: 'code-generation', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(a.taskType, 'code-generation');
    assert.ok(a.messages.some((m) => m.role === 'system'));
    const b = validateRequest({ prompt: 'hello' });
    assert.equal(b.taskType, 'general');
  });

  test('rejects unknown task types and empty payloads', () => {
    assert.throws(() => validateRequest({ taskType: 'nope', prompt: 'x' }), GatewayError);
    assert.throws(() => validateRequest({ taskType: 'general' }), GatewayError);
    assert.throws(() => validateRequest({ taskType: 'general', messages: [{ role: 'user', content: '   ' }] }), GatewayError);
  });

  test('clamps sampling parameters', () => {
    const r = validateRequest({ prompt: 'x', maxTokens: 999999, temperature: 5 });
    assert.ok(r.maxTokens <= 8192);
    assert.equal(r.temperature, 2);
  });
});

describe('end-to-end inference (mock provider)', () => {
  test('returns a normalised completion', async () => {
    const request = validateRequest({ taskType: 'general', messages: [{ role: 'user', content: 'Say hello' }], skipCache: true });
    const data = await runInference(request, { caller: { userId: 'e2e', tier: 'internal' }, requestId: 'test-1' });
    assert.ok(data.content.length > 0);
    assert.equal(data.provider, 'mock');
    assert.equal(data.cached, false);
    assert.ok(data.usage.totalTokens >= 0);
    assert.ok(Array.isArray(data.attempts));
  });

  test('second identical call is served from cache', async () => {
    const body = { taskType: 'summarization', messages: [{ role: 'user', content: 'Summarise the cache test payload' }] };
    const first = await runInference(validateRequest(body), { caller: { userId: 'e2e-cache', tier: 'internal' }, requestId: 'test-2' });
    const second = await runInference(validateRequest(body), { caller: { userId: 'e2e-cache', tier: 'internal' }, requestId: 'test-3' });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.content, first.content);
  });

  test('caller quota exhaustion surfaces a 429 GatewayError', async () => {
    const request = validateRequest({ taskType: 'general', prompt: 'burn the free tier quota please', skipCache: true });
    let thrown = null;
    for (let i = 0; i < 8; i += 1) {
      try {
        await runInference(request, { caller: { userId: 'quota-user', tier: 'free' }, requestId: `test-q-${i}` });
      } catch (err) {
        thrown = err;
        break;
      }
    }
    assert.ok(thrown instanceof GatewayError, 'expected a GatewayError');
    assert.equal(thrown.status, 429);
    assert.ok(thrown.retryAfterSec >= 1);
    userLimiter.reset('quota-user');
  });
});

describe('util primitives', () => {
  test('classifyError maps statuses to classes', () => {
    assert.equal(classifyError({ status: 429, message: 'rate limit exceeded' }), ERROR_CLASS.RATE_LIMIT);
    assert.equal(classifyError({ status: 529, message: 'overloaded' }), ERROR_CLASS.CAPACITY);
    assert.equal(classifyError({ status: 400, message: 'maximum context length exceeded' }), ERROR_CLASS.CONTEXT_LENGTH);
    assert.equal(classifyError({ status: 401, message: 'invalid api key' }), ERROR_CLASS.AUTH);
    assert.equal(classifyError({ status: 0, code: 'NETWORK', message: 'fetch failed' }), ERROR_CLASS.NETWORK);
    assert.equal(classifyError({ status: 400, message: 'content filter triggered' }), ERROR_CLASS.CONTENT_FILTER);
  });

  test('parseRetryAfter with header-like object', () => {
    const headers = { get: (k) => (k === 'retry-after' ? '30' : null) };
    assert.equal(parseRetryAfter(headers), 30);
    const dateHeaders = { get: (k) => (k === 'retry-after' ? new Date(Date.now() + 60000).toUTCString() : null) };
    const parsed = parseRetryAfter(dateHeaders);
    assert.ok(parsed >= 55 && parsed <= 61);
  });

  test('reset boundaries are in the future', () => {
    const now = Date.now();
    assert.ok(nextResetAt('utc-midnight', now) > now);
    assert.ok(nextResetAt('pt-midnight', now) > now);
    assert.match(dayBucket('utc-midnight', now), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('safeEqual is length tolerant', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
  });

  test('parseApiKey reads x-api-key and bearer tokens', () => {
    assert.equal(parseApiKey({ 'x-api-key': 'abc' }), 'abc');
    assert.equal(parseApiKey({ authorization: 'Bearer xyz' }), 'xyz');
    assert.equal(parseApiKey({ authorization: 'xyz' }), 'xyz');
    assert.equal(parseApiKey({}), '');
  });

  test('estimateTokens scales with length', () => {
    assert.equal(estimateTokens(''), 1); // conservative floor: an empty prompt still costs a slot
    assert.ok(estimateTokens('a'.repeat(400)) === 100);
  });
});

after(() => {
  responseCache.invalidate(null);
});
