#!/usr/bin/env node
/**
 * Static integrity check for the gateway service (no network, no Docker).
 *
 *  1. Every .mjs under src/ parses as ESM (`node --check`).
 *  2. Every relative import specifier resolves to a real file.
 *  3. data/policies.registry.json parses, and every model references a known
 *     provider with the required quota fields.
 *  4. The module graph actually loads (imports are exercised, not just parsed).
 *
 * Exits non-zero on the first category of failure so CI can gate merges.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
};

const files = walk(SRC).sort();
notes.push(`found ${files.length} ESM modules under gateway/src`);

/* 1 + 2: syntax and import resolution ------------------------------------ */
const importRe = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`${rel}: node --check failed → ${String(err.stderr ?? err.message).trim().split('\n')[0]}`);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(importRe)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    if (!spec.startsWith('.')) continue; // bare specifier = node builtin or package
    const target = path.resolve(path.dirname(file), spec);
    if (!existsSync(target)) {
      fail(`${rel}: unresolved import "${spec}" → expected ${path.relative(ROOT, target)}`);
    } else if (statSync(target).isDirectory()) {
      fail(`${rel}: import "${spec}" resolves to a directory (ESM needs an explicit file)`);
    }
  }
}

/* 3: registry integrity --------------------------------------------------- */
const registryPath = path.join(ROOT, 'data', 'policies.registry.json');
let registry = null;
if (!existsSync(registryPath)) {
  fail(`registry missing at ${path.relative(ROOT, registryPath)}`);
} else {
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    fail(`registry is not valid JSON: ${err.message}`);
  }
}
if (registry) {
  const providerIds = new Set(Object.keys(registry.providers ?? {}));
  if (providerIds.size === 0) fail('registry.providers is empty');
  const ids = new Set();
  for (const model of registry.models ?? []) {
    for (const field of ['id', 'providerId', 'modelName']) {
      if (!model?.[field]) fail(`registry model ${JSON.stringify(model).slice(0, 80)} missing "${field}"`);
    }
    if (!providerIds.has(model.providerId)) fail(`registry model "${model.id}" references unknown provider "${model.providerId}"`);
    if (ids.has(model.id)) fail(`duplicate registry model id "${model.id}"`);
    ids.add(model.id);
    for (const field of ['rpm', 'rpd', 'tpm', 'tpd', 'monthlyTokens', 'contextWindow', 'quality']) {
      if (!(field in model)) fail(`registry model "${model.id}" missing quota field "${field}"`);
    }
    if (model.contextWindow && model.contextWindow < 1024) fail(`registry model "${model.id}" has an implausible contextWindow`);
  }
  notes.push(`registry: ${ids.size} models, ${providerIds.size} providers`);
}

/* 4: live import of the module graph -------------------------------------- */
try {
  const { policyStore } = await import(path.join(SRC, 'policy-store.mjs'));
  policyStore.load();
  const { keyPool } = await import(path.join(SRC, 'gateway', 'key-pool.mjs'));
  keyPool.init();
  const { initProviders } = await import(path.join(SRC, 'providers', 'index.mjs'));
  initProviders();
  const { responseCache } = await import(path.join(SRC, 'gateway', 'cache.mjs'));
  const key = responseCache.constructor.keyFor({ taskType: 'general', messages: [{ role: 'user', content: 'ping' }], maxTokens: 16, temperature: 0.3 });
  responseCache.set(key, { content: 'pong' });
  if (responseCache.get(key)?.content !== 'pong') fail('cache round-trip failed');
  const { decideFallback, DECISION } = await import(path.join(SRC, 'gateway', 'fallback.mjs'));
  const d = decideFallback({ errorClass: 'RATE_LIMIT', attempt: 1, maxAttempts: 6, hasMoreKeys: true });
  if (d.decision !== DECISION.SAME_MODEL_NEXT_KEY) fail(`fallback policy regression: ${d.decision}`);
  const { trimMessages } = await import(path.join(SRC, 'gateway', 'fusion.mjs'));
  const trimmed = trimMessages(
    [{ role: 'system', content: 'sys' }, ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) }))],
    400,
  );
  if (!trimmed.trimmed) fail('trimMessages did not trim an oversized conversation');
  if (trimmed.messages[0].role !== 'system') fail('trimMessages dropped the system prompt');
  notes.push('module graph loads and core invariants hold');
} catch (err) {
  fail(`module graph failed to load: ${err?.stack ?? err}`);
}

/* Report ------------------------------------------------------------------ */
for (const n of notes) console.log(`[check] ${n}`);
if (failures.length) {
  console.error(`\n[check] FAILED with ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`[check] OK — ${files.length} modules, registry + module graph verified`);
