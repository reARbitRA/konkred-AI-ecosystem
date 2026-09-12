/**
 * fullKONK_> brain adapter — makes this gateway the AI brain of konkred.xyz/fullkonk.
 *
 * Implements exactly the wire contract the fullKONK frontend consumes
 * (see reARbitRA/konkred-template2 · pages/FullKonkPage.tsx):
 *
 *   GET  /api/fullkonk/providers        → { providers:[{id,name,hasKey,models:[{id,label}]}], configured }
 *   POST /api/fullkonk/generate         → SSE stream of `data: {json}\n\n` events:
 *        {type:'stage',stage,content?} {type:'provider',provider,model}
 *        {type:'failover',from,to}     {type:'metrics',data:{...}}
 *        {type:'delta',content}        {type:'file',file:{path,content,language}}
 *        {type:'reset',characters}     {type:'done'}
 *        {type:'error',error,kind:'configuration'|'pipeline'}
 *   POST /api/fullkonk/github/export    → { success, filesUploaded, prUrl, errors[] }
 *
 * All inference runs through the existing quota-aware pool (runInference), so
 * failover, cooldowns, caching and dedup apply to the brain exactly as they do
 * to the Telegram bot. Zero new dependencies.
 */
import { config } from './config.mjs';
import { policyStore } from './policy-store.mjs';
import { keyPool } from './gateway/key-pool.mjs';
import { runInference, GatewayError } from './gateway/gateway.mjs';
import { log, readJsonBody, sendJson, safeEqual, randomId, sleep, clamp } from './util.mjs';

const MODES = new Set(['fullstack', 'frontend', 'backend', 'review']);
const STAGE_LABEL = {
  architect: 'ARCHITECT · SCOPING BUILD',
  build: 'BUILD · GENERATING FILES',
  verify: 'VERIFY · SELF-REVIEW',
  review: 'REVIEW · ANALYSING CODE',
};

let openAccessWarned = false;

/* ------------------------------------------------------------------ *
 * Auth + CORS
 * ------------------------------------------------------------------ */
const requireBrainKey = (req) => {
  if (!config.fullkonkKey) {
    if (!openAccessWarned) {
      openAccessWarned = true;
      log.warn('fullkonk', 'FULLKONK_KEY is empty — /api/fullkonk/* is open to anyone who knows the URL');
    }
    return;
  }
  const presented = req.headers['x-brain-key'] ?? req.headers['x-api-key'] ?? '';
  if (!presented || !safeEqual(String(presented), config.fullkonkKey)) {
    throw new GatewayError(401, 'INVALID_BRAIN_KEY', 'Provide the brain shared secret via the "x-brain-key" header');
  }
};

/** Attach CORS headers; returns true when the request was a handled preflight. */
export const handleCors = (req, res) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const allowed = origin && (config.corsAllowAll || config.corsOrigins.includes(origin));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-api-key,x-admin-key,x-provider-key,x-brain-key');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
  if (req.method === 'OPTIONS' && origin) {
    res.writeHead(allowed ? 204 : 403).end();
    return true;
  }
  return false;
};

/* ------------------------------------------------------------------ *
 * GET /api/fullkonk/providers
 * ------------------------------------------------------------------ */
export const handleFullkonkProviders = (req, res) => {
  const providers = [];
  for (const [id, meta] of policyStore.providers) {
    const models = policyStore.modelsForProvider
      ? policyStore.modelsForProvider(id)
      : policyStore.models.filter((m) => m.providerId === id);
    if (id !== 'mock' && !models.length) continue;
    providers.push({
      id,
      name: meta?.name ?? id,
      hasKey: id === 'mock'
        ? Boolean(config.demoMock || config.mockFallback)
        : keyPool.keysFor(id).length > 0,
      models: (models.length ? models : [{ id: `${id}:default`, modelName: `${id}-default` }])
        .map((m) => ({ id: m.id, label: m.modelName ?? m.id })),
    });
  }
  return sendJson(res, 200, {
    providers,
    configured: providers.some((p) => p.hasKey && p.id !== 'mock'),
  });
};

/* ------------------------------------------------------------------ *
 * SSE helpers
 * ------------------------------------------------------------------ */
const startSse = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': fullkonk brain online\n\n');
};

const sendEvent = (res, event) => {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
};

/** Typewriter delivery: newline-friendly chunks so the UI renders progressively. */
const streamText = async (res, text, aborted) => {
  let rest = String(text ?? '');
  while (rest.length && !aborted()) {
    let size = Math.min(480, rest.length);
    if (size < rest.length) {
      const cut = rest.lastIndexOf('\n', size);
      if (cut > size * 0.5) size = cut + 1;
    }
    sendEvent(res, { type: 'delta', content: rest.slice(0, size) });
    rest = rest.slice(size);
    if (rest) await sleep(4);
  }
};

/** Server-side fenced-file extraction (mirror of the frontend parser, lenient). */
export const extractFiles = (content) => {
  const files = new Map();
  const lines = String(content).split(/\r?\n/);
  let inFence = false;
  let marker = '```';
  let language = '';
  let path = '';
  let preceding = '';
  let buffer = [];
  let unnamed = 0;
  const pathLine = /(?:file(?:name)?\s*:\s*)([\w@+.,()[\]/-]+\.[\w]+)\s*$/i;
  for (const line of lines) {
    if (!inFence) {
      const pre = line.trim().match(pathLine);
      if (pre) preceding = pre[1];
      const open = line.match(/^\s*(`{3,}|~{3,})([^\s`]*)\s*(.*)$/);
      if (!open) continue;
      inFence = true;
      marker = open[1];
      language = open[2] || '';
      const inline = open[3].match(/^([^/\s]+\/)?[\w.-]+\.[\w]+$/);
      path = inline ? open[3] : preceding;
      buffer = [];
      continue;
    }
    if (line.trim() === marker || new RegExp(`^${marker[0]}{${marker.length},}$`).test(line.trim())) {
      inFence = false;
      const code = buffer.join('\n').trim();
      let target = path.trim().replace(/^\.\/|^\/+/, '');
      if (!target && code) {
        unnamed += 1;
        target = `generated/output-${unnamed}.${language || 'txt'}`;
      }
      if (code && target && !target.includes('..')) {
        files.set(target, { path: target, content: code, language: (language || target.split('.').pop()).toLowerCase() });
      }
      preceding = '';
      continue;
    }
    buffer.push(line);
  }
  return [...files.values()];
};

/* ------------------------------------------------------------------ *
 * Pipeline prompts
 * ------------------------------------------------------------------ */
const attachmentBlock = (attachedFiles) => {
  const list = Array.isArray(attachedFiles) ? attachedFiles.slice(0, 8) : [];
  if (!list.length) return '';
  return `\n\n--- ATTACHED CODE FILES ---\n${list
    .map((f) => `file: ${f?.path ?? 'unknown'}\n\`\`\`\n${String(f?.content ?? '').slice(0, 6000)}\n\`\`\``)
    .join('\n')}`;
};

const stageRequest = (stage, { prompt, mode, systemPrompt, attachedFiles, plan, build }) => {
  const base = { temperature: 0.4, privacy: 'any', skipCache: false };
  if (stage === 'architect') {
    return {
      ...base,
      taskType: 'architecture',
      maxTokens: 2048,
      messages: [{
        role: 'user',
        content:
          `You are the ARCHITECT stage of fullKONK_>, an autonomous build pipeline (mode: ${mode}).\n`
          + 'Produce a concise architecture plan in markdown: components, the exact file list '
          + '(each as `file: path/ext` on its own line) with one-line responsibilities, data flow, and risks.\n'
          + 'Do NOT emit code fences or full file contents in this stage.\n\n'
          + `USER REQUEST:\n${prompt}${systemPrompt ? `\n\nOWNER CONSTRAINTS:\n${systemPrompt}` : ''}${attachmentBlock(attachedFiles)}`,
      }],
    };
  }
  if (stage === 'build') {
    return {
      ...base,
      taskType: 'code-generation',
      maxTokens: config.hardMaxTokens,
      messages: [{
        role: 'user',
        content:
          `You are the BUILD stage of fullKONK_>. Implement the plan completely (mode: ${mode}).\n`
          + 'Output EVERY file as: a line `file: path/ext`, then a fenced code block with the language tag. '
          + 'Complete, runnable code only — no placeholders, no prose between files.\n\n'
          + `PLAN:\n${String(plan).slice(0, 6000)}\n\nUSER REQUEST:\n${prompt}${attachmentBlock(attachedFiles)}`,
      }],
    };
  }
  if (stage === 'verify') {
    return {
      ...base,
      taskType: 'bug-fixing',
      maxTokens: 2048,
      messages: [{
        role: 'user',
        content:
          'You are the VERIFY stage of fullKONK_>. Self-review the generated build: check imports, '
          + 'types, missing files and obvious runtime bugs. Output a markdown checklist with PASS/FAIL per item '
          + 'and a short "fixes applied" note. Do not reprint whole files.\n\n'
          + `USER REQUEST:\n${prompt}\n\nBUILD OUTPUT (truncated):\n${String(build).slice(0, 8000)}`,
      }],
    };
  }
  return {
    ...base,
    taskType: 'bug-fixing',
    maxTokens: 4096,
    messages: [{
      role: 'user',
      content:
        `You are fullKONK_> in REVIEW mode. Review the supplied code: correctness, security, performance, `
        + 'maintainability. Output markdown findings ordered by severity, each with a concrete patch snippet.\n\n'
        + `REVIEW REQUEST:\n${prompt}${systemPrompt ? `\n\nOWNER CONSTRAINTS:\n${systemPrompt}` : ''}${attachmentBlock(attachedFiles)}`,
    }],
  };
};

/* ------------------------------------------------------------------ *
 * POST /api/fullkonk/generate
 * ------------------------------------------------------------------ */
export const handleFullkonkGenerate = async (req, res) => {
  requireBrainKey(req);
  const body = await readJsonBody(req);
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new GatewayError(400, 'MISSING_PROMPT', 'Body must contain a non-empty "prompt" string');
  const mode = MODES.has(String(body.mode)) ? String(body.mode) : 'fullstack';
  const temperature = clamp(Number.parseFloat(body.temperature ?? 0.4) || 0.4, 0, 2);
  const preferredModel = typeof body.model === 'string' && body.model ? body.model : null;
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
  const attachedFiles = Array.isArray(body.attachedFiles) ? body.attachedFiles : [];

  let closed = false;
  req.on('close', () => { closed = true; });
  const aborted = () => closed || res.writableEnded || res.destroyed;

  startSse(res);
  const caller = { userId: 'fullkonk-brain', tier: 'internal', key: null };
  const stages = mode === 'review' ? ['review'] : ['architect', 'build', 'verify'];
  const startedAt = Date.now();
  let totalTokens = 0;
  let plan = '';
  let build = '';
  let lastProvider = null;

  try {
    for (const stage of stages) {
      if (aborted()) return;
      sendEvent(res, { type: 'stage', stage, content: STAGE_LABEL[stage] });
      const request = stageRequest(stage, { prompt, mode, systemPrompt, attachedFiles, plan, build });
      request.temperature = temperature;
      if (preferredModel) request.preferredModel = preferredModel;
      if (typeof body.maxTokens === 'number' && stage === 'build') {
        request.maxTokens = clamp(Math.round(body.maxTokens), 256, config.hardMaxTokens);
      }

      let result;
      try {
        result = await runInference(request, { caller, requestId: `fk-${randomId()}` });
      } catch (err) {
        const configuration = err?.code === 'NO_PROVIDER_CREDENTIALS' || err?.code === 'ADMIN_DISABLED';
        sendEvent(res, { type: 'error', error: err?.message ?? 'Generation failed', kind: configuration ? 'configuration' : 'pipeline' });
        return res.end();
      }

      /* surface pool failovers the frontend can render */
      const failed = (result.attempts ?? []).find((a) => a.status !== 200 && a.provider);
      if (failed && failed.provider !== result.provider) {
        sendEvent(res, { type: 'failover', from: failed.provider, to: result.provider });
      }
      if (result.provider !== lastProvider) {
        lastProvider = result.provider;
        sendEvent(res, { type: 'provider', provider: result.provider, model: result.model });
      }

      totalTokens += result.usage?.totalTokens ?? 0;
      const text = String(result.content ?? '');
      if (stage === 'architect') plan = text;
      if (stage === 'build') {
        build = text;
        await streamText(res, text, aborted);
        for (const file of extractFiles(text)) {
          if (!aborted()) sendEvent(res, { type: 'file', file });
        }
      } else {
        await streamText(res, text, aborted);
      }

      sendEvent(res, {
        type: 'metrics',
        data: {
          totalTokens,
          tokensPerSecond: Math.round((totalTokens / Math.max(1, Date.now() - startedAt)) * 10000) / 10,
          elapsedMs: Date.now() - startedAt,
          provider: result.provider,
        },
      });
    }
    if (!aborted()) sendEvent(res, { type: 'done' });
  } catch (err) {
    log.error('fullkonk', `generate failed: ${err?.stack ?? err}`);
    sendEvent(res, { type: 'error', error: err?.message ?? 'Internal brain failure', kind: 'pipeline' });
  }
  return res.end();
};

/* ------------------------------------------------------------------ *
 * POST /api/fullkonk/github/export
 * ------------------------------------------------------------------ */
const gh = async (path, { token, method = 'GET', body = null, timeoutMs = 20000 } = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'konkred-fullkonk-brain',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
};

export const handleFullkonkExport = async (req, res) => {
  requireBrainKey(req);
  const body = await readJsonBody(req);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const owner = typeof body?.owner === 'string' ? body.owner.trim() : '';
  const repo = typeof body?.repo === 'string' ? body.repo.trim() : '';
  const branch = (typeof body?.branch === 'string' && body.branch.trim()) || 'fullkonk-output';
  const message = (typeof body?.message === 'string' && body.message.trim()) || 'Generated by fullKONK_> · konkred.xyz';
  const files = Array.isArray(body?.files)
    ? body.files.filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    : [];

  if (!token || !owner || !repo) {
    throw new GatewayError(400, 'EXPORT_MISSING_FIELDS', 'token, owner and repo are required');
  }
  if (!files.length || files.length > 200) {
    throw new GatewayError(400, 'EXPORT_BAD_FILES', 'Provide between 1 and 200 files with path+content');
  }
  const clean = files.map((f) => ({
    path: f.path.trim().replace(/^\/+/, '').replace(/\\/g, '/'),
    content: f.content,
  }));
  if (clean.some((f) => !f.path || f.path.includes('..') || f.path.startsWith('.git/'))) {
    throw new GatewayError(400, 'EXPORT_BAD_PATH', 'File paths must be relative and must not escape the repository');
  }

  const errors = [];
  try {
    const repoInfo = await gh(`/repos/${owner}/${repo}`, { token });
    if (repoInfo.status !== 200) {
      return sendJson(res, repoInfo.status === 404 ? 404 : 502, {
        success: false, filesUploaded: 0, prUrl: null,
        errors: [`GitHub said: ${repoInfo.payload?.message ?? repoInfo.status}`],
      });
    }
    const defaultBranch = repoInfo.payload.default_branch ?? 'main';
    const baseRef = await gh(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, { token });
    if (baseRef.status !== 200) {
      return sendJson(res, 502, { success: false, filesUploaded: 0, prUrl: null, errors: [`Cannot read base branch ${defaultBranch}`] });
    }
    const baseSha = baseRef.payload.object.sha;

    let headSha = baseSha;
    const existing = await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, { token });
    if (existing.status === 200) {
      headSha = existing.payload.object.sha;
    } else {
      const created = await gh(`/repos/${owner}/${repo}/git/refs`, { token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: baseSha } });
      if (created.status !== 201) errors.push(`branch ${branch}: ${created.payload?.message ?? created.status}`);
    }

    const headCommit = await gh(`/repos/${owner}/${repo}/git/commits/${headSha}`, { token });
    if (headCommit.status !== 200) {
      return sendJson(res, 502, { success: false, filesUploaded: 0, prUrl: null, errors: ['Cannot resolve head commit'] });
    }

    const elements = [];
    for (const file of clean) {
      const blob = await gh(`/repos/${owner}/${repo}/git/blobs`, {
        token, method: 'POST',
        body: { content: Buffer.from(file.content, 'utf8').toString('base64'), encoding: 'base64' },
      });
      if (blob.status !== 201) {
        errors.push(`${file.path}: ${blob.payload?.message ?? blob.status}`);
        continue;
      }
      elements.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.payload.sha });
    }
    if (!elements.length) {
      return sendJson(res, 502, { success: false, filesUploaded: 0, prUrl: null, errors: errors.length ? errors : ['No blobs created'] });
    }

    const tree = await gh(`/repos/${owner}/${repo}/git/trees`, {
      token, method: 'POST',
      body: { base_tree: headCommit.payload.tree.sha, tree: elements },
    });
    if (tree.status !== 201) {
      return sendJson(res, 502, { success: false, filesUploaded: 0, prUrl: null, errors: [`tree: ${tree.payload?.message ?? tree.status}`] });
    }
    const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
      token, method: 'POST',
      body: { message, tree: tree.payload.sha, parents: [headSha] },
    });
    if (commit.status !== 201) {
      return sendJson(res, 502, { success: false, filesUploaded: 0, prUrl: null, errors: [`commit: ${commit.payload?.message ?? commit.status}`] });
    }
    const updated = await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      token, method: 'PATCH', body: { sha: commit.payload.sha, force: true },
    });
    if (updated.status !== 200) errors.push(`ref update: ${updated.payload?.message ?? updated.status}`);

    let prUrl = null;
    const pr = await gh(`/repos/${owner}/${repo}/pulls`, {
      token, method: 'POST', body: { title: message, head: branch, base: defaultBranch },
    });
    if (pr.status === 201) prUrl = pr.payload.html_url ?? null;
    else if (pr.status === 422) errors.push('PR already exists for this branch — push updated the branch instead.');
    else errors.push(`pr: ${pr.payload?.message ?? pr.status}`);

    return sendJson(res, 200, { success: true, filesUploaded: elements.length, prUrl, errors });
  } catch (err) {
    log.error('fullkonk', `github export failed: ${err?.message ?? err}`);
    return sendJson(res, 502, { success: false, filesUploaded: 0, prUrl: null, errors: [err?.message ?? 'Export failed'] });
  }
};
