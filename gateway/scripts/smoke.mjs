#!/usr/bin/env node
/**
 * End-to-end smoke test that boots the real HTTP server against the offline
 * simulator and exercises every public route. No Docker, no network, no keys.
 *
 *   node scripts/smoke.mjs [--keep-alive] [--port 3100]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 3100 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = 'smoke-internal-key';
const ADMIN_KEY = 'smoke-admin-key';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DEMO_MOCK: 'true',
    MOCK_FALLBACK: 'true',
    ADMIN_KEY,
    USERS_JSON: JSON.stringify([{ key: API_KEY, userId: 'smoke-test', tier: 'internal' }]),
    WATCHDOG_ENABLED: 'true',
    WATCHDOG_INTERVAL_MS: '5000',
    CACHE_TTL_MS: '30000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
child.stdout.on('data', (d) => logs.push(d.toString()));
child.stderr.on('data', (d) => logs.push(d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForHealth = async (timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
};

const main = async () => {
  if (!(await waitForHealth())) {
    record('gateway boot', false, `did not become healthy in 20s\n${logs.join('')}`);
    process.exit(1);
  }
  record('gateway boot', true, `${BASE}`);

  /* --- health -------------------------------------------------------- */
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  record('GET /api/health', health?.ok === true && health?.data?.status === 'ok', `${health?.data?.pool?.available ?? '?'} keys available`);

  const ready = await fetch(`${BASE}/api/ready`);
  record('GET /api/ready', ready.status === 200, `status=${ready.status}`);

  /* --- auth ------------------------------------------------------------ */
  const noAuth = await fetch(`${BASE}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
  record('POST /api/ai without key → 401', noAuth.status === 401, `status=${noAuth.status}`);

  const badAuth = await fetch(`${BASE}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong' }, body: JSON.stringify({ prompt: 'hi' }) });
  record('POST /api/ai with bad key → 401', badAuth.status === 401, `status=${badAuth.status}`);

  const badBody = await fetch(`${BASE}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify({ taskType: 'general' }) });
  record('POST /api/ai without messages → 400', badBody.status === 400, `status=${badBody.status}`);

  const badTask = await fetch(`${BASE}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify({ taskType: 'nonsense', prompt: 'hi' }) });
  record('POST /api/ai with unknown taskType → 400', badTask.status === 400, `status=${badTask.status}`);

  /* --- happy path ------------------------------------------------------ */
  const t0 = Date.now();
  const okRes = await fetch(`${BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ taskType: 'code-generation', messages: [{ role: 'user', content: 'Write a JS function to chunk a string.' }], maxTokens: 256, temperature: 0.2 }),
  });
  const okBody = await okRes.json();
  const latency = Date.now() - t0;
  record(
    'POST /api/ai (cold, mock provider) → 200',
    okRes.status === 200 && typeof okBody?.data?.content === 'string' && okBody.data.content.length > 0 && okBody?.data?.provider === 'mock',
    `${latency}ms, provider=${okBody?.data?.provider}, model=${okBody?.data?.modelId}`,
  );

  /* --- cache ----------------------------------------------------------- */
  const cachedRes = await fetch(`${BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ taskType: 'code-generation', messages: [{ role: 'user', content: 'Write a JS function to chunk a string.' }], maxTokens: 256, temperature: 0.2 }),
  });
  const cachedBody = await cachedRes.json();
  record('identical request served from cache', cachedBody?.data?.cached === true, `cached=${cachedBody?.data?.cached}`);

  /* --- multi-turn ------------------------------------------------------ */
  const multiTurn = await fetch(`${BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      taskType: 'general',
      messages: [
        { role: 'user', content: 'Remember the number 42.' },
        { role: 'assistant', content: 'Noted: 42.' },
        { role: 'user', content: 'What number did I ask you to remember?' },
      ],
    }),
  });
  const mtBody = await multiTurn.json();
  // The simulator echoes the final turn and reports how many messages it received,
  // which proves history forwarding works without needing a real model.
  const forwarded = /messages forwarded: (\d+)/.exec(mtBody?.data?.content ?? '');
  record(
    'multi-turn conversation → 200 with full history forwarded',
    multiTurn.status === 200 && mtBody?.data?.content?.includes('What number did I ask you to remember') && Number(forwarded?.[1] ?? 0) >= 3,
    `messages forwarded=${forwarded?.[1] ?? '?'}`,
  );

  /* --- privacy routing ------------------------------------------------- */
  const privateRes = await fetch(`${BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ taskType: 'general', prompt: 'private data test', privacy: 'private' }),
  });
  record('privacy=private request → 200', privateRes.status === 200, `status=${privateRes.status}`);

  /* --- oversized payload ---------------------------------------------- */
  const huge = await fetch(`${BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ taskType: 'summarization', messages: [{ role: 'user', content: 'x'.repeat(120000) }], maxTokens: 512 }),
  });
  record('120k-char prompt handled', huge.status === 200 || huge.status === 413, `status=${huge.status}`);

  /* --- models + admin -------------------------------------------------- */
  const models = await fetch(`${BASE}/api/models`, { headers: { 'x-api-key': API_KEY } }).then((r) => r.json());
  record('GET /api/models', Array.isArray(models?.data?.models) && models.data.models.length > 0, `${models?.data?.models?.length ?? 0} models`);

  const statusNoAdmin = await fetch(`${BASE}/api/status`, { headers: { 'x-api-key': API_KEY } });
  record('GET /api/status without admin key → 403', statusNoAdmin.status === 403, `status=${statusNoAdmin.status}`);

  const status = await fetch(`${BASE}/api/status`, { headers: { 'x-admin-key': ADMIN_KEY } }).then((r) => r.json());
  record('GET /api/status with admin key', status?.ok === true && Array.isArray(status?.data?.pool?.providers), `keys=${status?.data?.pool?.totalKeys}`);

  const dashboard = await fetch(`${BASE}/`);
  const html = await dashboard.text();
  record('GET / dashboard renders HTML', dashboard.status === 200 && html.includes('Konkred'), `${html.length} bytes`);

  const notFound = await fetch(`${BASE}/api/nope`);
  record('unknown route → 404', notFound.status === 404, `status=${notFound.status}`);

  const methodNotAllowed = await fetch(`${BASE}/api/health`, { method: 'POST' });
  record('wrong method → 405', methodNotAllowed.status === 405, `status=${methodNotAllowed.status}`);

  const flush = await fetch(`${BASE}/api/admin/cache/flush`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } }).then((r) => r.json());
  record('POST /api/admin/cache/flush', flush?.ok === true, `flushed=${flush?.data?.flushed}`);

  const afterFlush = await fetch(`${BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ taskType: 'code-generation', messages: [{ role: 'user', content: 'Write a JS function to chunk a string.' }], maxTokens: 256, temperature: 0.2 }),
  }).then((r) => r.json());
  record('cache miss after flush', afterFlush?.data?.cached === false, `cached=${afterFlush?.data?.cached}`);

  /* --- concurrency / dedup --------------------------------------------- */
  const payload = JSON.stringify({ taskType: 'translate', messages: [{ role: 'user', content: 'Concurrent dedup probe' }] });
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(`${BASE}/api/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }, body: payload }).then((r) => r.json()),
    ),
  );
  record('8 concurrent identical requests all succeed', concurrent.every((c) => typeof c?.data?.content === 'string'), `ok=${concurrent.filter((c) => c?.data?.content).length}/8`);

  /* --- summary ---------------------------------------------------------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
  if (failed.length) {
    console.log('\n--- gateway logs ---');
    console.log(logs.join('').slice(-4000));
  }

  if (args.includes('--keep-alive')) {
    console.log(`\ngateway left running on ${BASE} (pid ${child.pid})`);
    return;
  }
  child.kill('SIGTERM');
  await sleep(400);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => {
  console.error('smoke harness crashed:', err);
  console.log(logs.join('').slice(-3000));
  child.kill('SIGKILL');
  process.exit(1);
});
