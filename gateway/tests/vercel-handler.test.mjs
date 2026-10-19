import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DEMO_MOCK = 'true';
process.env.MOCK_FALLBACK = 'true';
process.env.USERS_JSON = JSON.stringify([{ key: 'vercel-test-key', userId: 'vercel-test', tier: 'internal' }]);
process.env.ADMIN_KEY = 'vercel-test-admin';
process.env.WATCHDOG_ENABLED = 'false';

const { default: vercelHandler } = await import('../../api/[...path].mjs');
const server = http.createServer(vercelHandler);
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('Vercel function adapter serves the shared gateway health route without opening its own listener', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.service, 'konkred-gateway');
});

test('Vercel rewrites can dispatch OpenAI-compatible routes through /api/v1', async () => {
  const response = await fetch(`${baseUrl}/api/v1/models`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.object, 'list');
  assert.ok(body.data.some((model) => model.id === 'groq:gpt-oss-120b'));
});

test('Vercel function adapter forwards JSON bodies to the shared inference route', async () => {
  const response = await fetch(`${baseUrl}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'vercel-test-key' },
    body: JSON.stringify({ taskType: 'general', prompt: 'Hello from Vercel adapter' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.provider, 'mock');
  assert.match(body.data.content, /Hello from Vercel adapter/);
});
