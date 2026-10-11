/**
 * Regression: the provider deadline must cover the response BODY, not only the
 * headers. Previously the timer was cleared as soon as headers arrived, so a
 * server that sent 200 and then stalled the body hung the request forever.
 *   node --test gateway/tests/provider-timeout.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { BaseProvider, ProviderError } = await import('../src/providers/base.mjs');

const sockets = new Set();
const servers = [];

/** Start a local server; `handler(req, res)` controls exactly what is sent and when. */
const startServer = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });

after(() => {
  for (const s of sockets) s.destroy();
  for (const server of servers) server.close();
});

const provider = new BaseProvider({ id: 'test-provider' });

test('a stalled response body is aborted by the deadline (TIMEOUT, not a hang)', async () => {
  const url = await startServer((req, res) => {
    // Headers + a partial body, then never finish: the classic stalled-body case.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"choices":[{"message":{"content":"partial');
  });

  const started = Date.now();
  await assert.rejects(
    provider.request(url, { method: 'GET', body: null, timeoutMs: 1000 }),
    (err) => {
      assert.ok(err instanceof ProviderError, 'should be a ProviderError');
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.status, 504);
      assert.match(err.message, /reading the response body/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, 'deadline must fire within seconds, not hang');
});

test('a server that never sends headers is still aborted (TIMEOUT)', async () => {
  const url = await startServer(() => {
    /* never respond */
  });
  await assert.rejects(provider.request(url, { method: 'GET', timeoutMs: 1000 }), { code: 'TIMEOUT', status: 504 });
});

test('a normal JSON response inside the deadline still succeeds', async () => {
  const url = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { json, status } = await provider.request(url, { method: 'GET', timeoutMs: 5000 });
  assert.deepEqual(json, { ok: true });
  assert.equal(status, 200);
});
