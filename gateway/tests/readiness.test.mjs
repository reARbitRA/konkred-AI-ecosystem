import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DEMO_MOCK = 'false';
process.env.MOCK_FALLBACK = 'false';
process.env.USERS_JSON = JSON.stringify([{ key: 'readiness-test-key', userId: 'readiness-test', tier: 'internal' }]);
process.env.WATCHDOG_ENABLED = 'false';

const { handleRequest } = await import('../src/server.mjs');
const server = http.createServer(handleRequest);
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('readiness is 503 when there are no real provider keys and mock fallback is disabled', async () => {
  const response = await fetch(`${baseUrl}/api/ready`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.data.ready, false);
  assert.equal(body.data.pool.keys, 0);
  assert.equal(body.data.pool.available, 0);
});
