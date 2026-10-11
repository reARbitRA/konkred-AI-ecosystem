/**
 * Regression: FULLKONK_KEY must actually gate /api/fullkonk/* routes.
 * Previously config.mjs never exported `fullkonkKey`, so the check always
 * passed and the brain endpoints were open to anyone.
 *   node --test gateway/tests/fullkonk-auth.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEMO_MOCK = 'true';
process.env.MOCK_FALLBACK = 'true';
process.env.USERS_JSON = JSON.stringify([{ key: 'internal-key', userId: 'bot', tier: 'internal' }]);
process.env.ADMIN_KEY = 'test-admin';
process.env.FULLKONK_KEY = 'brain-secret-123';

const { config } = await import('../src/config.mjs');
const { handleFullkonkGenerate, handleFullkonkExport } = await import('../src/fullkonk.mjs');

const fakeReq = (headers = {}) => ({ headers, method: 'POST', on() {} });
const fakeRes = () => ({ writableEnded: false, destroyed: false, writeHead() {}, write() {}, end() {}, setHeader() {} });

test('config reads FULLKONK_KEY from the environment', () => {
  assert.equal(config.fullkonkKey, 'brain-secret-123');
});

test('generate rejects requests without the brain key (401)', async () => {
  await assert.rejects(handleFullkonkGenerate(fakeReq({}), fakeRes()), { status: 401, code: 'INVALID_BRAIN_KEY' });
});

test('generate rejects a wrong brain key (401)', async () => {
  await assert.rejects(
    handleFullkonkGenerate(fakeReq({ 'x-brain-key': 'nope' }), fakeRes()),
    { status: 401, code: 'INVALID_BRAIN_KEY' },
  );
});

test('github export rejects requests without the brain key (401)', async () => {
  await assert.rejects(handleFullkonkExport(fakeReq({}), fakeRes()), { status: 401, code: 'INVALID_BRAIN_KEY' });
});
