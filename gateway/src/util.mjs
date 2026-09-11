/**
 * Shared primitives: logging, hashing, HTTP helpers, token estimation,
 * error classification and retry-after parsing.
 */
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */
const ts = () => new Date().toISOString();
export const log = {
  info: (scope, msg, meta) => console.log(`${ts()} [INFO ] [${scope}] ${msg}${meta ? ` ${safeJson(meta)}` : ''}`),
  warn: (scope, msg, meta) => console.warn(`${ts()} [WARN ] [${scope}] ${msg}${meta ? ` ${safeJson(meta)}` : ''}`),
  error: (scope, msg, meta) => console.error(`${ts()} [ERROR] [${scope}] ${msg}${meta ? ` ${safeJson(meta)}` : ''}`),
};

export const safeJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Approximate token count (~4 chars/token) — used for pre-flight quota reservation. */
export const estimateTokens = (text) => {
  if (typeof text !== 'string') return 0;
  return Math.max(1, Math.ceil(text.length / 4));
};

export const estimateMessagesTokens = (messages) => {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, m) => sum + estimateTokens(String(m?.content ?? '')) + 4, 0);
};

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Constant-time string comparison that tolerates unequal lengths. */
export const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export const redact = (key) => {
  const s = String(key ?? '');
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

/* ------------------------------------------------------------------ *
 * HTTP body / response helpers
 * ------------------------------------------------------------------ */
export const readJsonBody = (req, limitBytes = 2 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('Request body is not valid JSON'), { code: 'INVALID_JSON', status: 400 }));
      }
      return undefined;
    });
    req.on('error', reject);
  });

export const sendJson = (res, status, payload, extraHeaders = {}) => {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
};

export const sendHtml = (res, status, html) => {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
};

export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ------------------------------------------------------------------ *
 * Retry-After / error classification
 * ------------------------------------------------------------------ */
export const parseRetryAfter = (headers) => {
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  if (!value) return null;
  const seconds = Number.parseInt(String(value), 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return null;
};

/** Normalised error classes drive fallback decisions in gateway/fallback.mjs. */
export const ERROR_CLASS = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  CAPACITY: 'CAPACITY',
  AUTH: 'AUTH',
  CONTEXT_LENGTH: 'CONTEXT_LENGTH',
  CONTENT_FILTER: 'CONTENT_FILTER',
  INVALID_REQUEST: 'INVALID_REQUEST',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  UPSTREAM: 'UPSTREAM',
  UNKNOWN: 'UNKNOWN',
});

const CONTEXT_HINTS = ['context length', 'context_length_exceeded', 'too many tokens', 'maximum context', 'prompt is too long', 'exceeds the model', 'token limit'];
const CAPACITY_HINTS = ['overloaded', 'capacity', 'try again later', 'temporarily unavailable', 'server overloaded', 'no healthy upstream', 'rate limit exceeded for tier'];
const FILTER_HINTS = ['content filter', 'safety', 'blocked', 'recitation', 'prohibited_content'];
const AUTH_HINTS = ['invalid api key', 'api key not valid', 'unauthorized', 'forbidden', 'permission_denied', 'invalid_api_key', 'account'];

export const classifyError = ({ status, message = '', code = '' } = {}) => {
  const hay = `${code} ${message}`.toLowerCase();
  if (status === 429) {
    return CAPACITY_HINTS.some((h) => hay.includes(h)) && !hay.includes('per minute') && !hay.includes('requests per')
      ? ERROR_CLASS.CAPACITY
      : ERROR_CLASS.RATE_LIMIT;
  }
  if (status === 401 || status === 403) return ERROR_CLASS.AUTH;
  if (status === 408 || status === 504 || code === 'TIMEOUT' || hay.includes('timed out') || hay.includes('timeout')) {
    return ERROR_CLASS.TIMEOUT;
  }
  if (status === 500 || status === 502 || status === 503 || status === 529 || status >= 500) {
    return CAPACITY_HINTS.some((h) => hay.includes(h)) ? ERROR_CLASS.CAPACITY : ERROR_CLASS.UPSTREAM;
  }
  if (status === 400 || status === 422) {
    if (CONTEXT_HINTS.some((h) => hay.includes(h))) return ERROR_CLASS.CONTEXT_LENGTH;
    if (FILTER_HINTS.some((h) => hay.includes(h))) return ERROR_CLASS.CONTENT_FILTER;
    return ERROR_CLASS.INVALID_REQUEST;
  }
  if (code === 'NETWORK' || hay.includes('fetch failed') || hay.includes('econnrefused') || hay.includes('enotfound') || hay.includes('socket hang up')) {
    return ERROR_CLASS.NETWORK;
  }
  if (CONTEXT_HINTS.some((h) => hay.includes(h))) return ERROR_CLASS.CONTEXT_LENGTH;
  if (FILTER_HINTS.some((h) => hay.includes(h))) return ERROR_CLASS.CONTENT_FILTER;
  if (AUTH_HINTS.some((h) => hay.includes(h))) return ERROR_CLASS.AUTH;
  return ERROR_CLASS.UNKNOWN;
};

/** Errors worth retrying on another key / model / provider. */
export const isRetriable = (errorClass) =>
  [
    ERROR_CLASS.RATE_LIMIT,
    ERROR_CLASS.CAPACITY,
    ERROR_CLASS.AUTH,
    ERROR_CLASS.CONTEXT_LENGTH,
    ERROR_CLASS.TIMEOUT,
    ERROR_CLASS.NETWORK,
    ERROR_CLASS.UPSTREAM,
    ERROR_CLASS.UNKNOWN,
  ].includes(errorClass);

/* ------------------------------------------------------------------ *
 * Time helpers (provider quota reset boundaries)
 * ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, '0');

/** Epoch ms of the next midnight boundary for a reset policy. */
export const nextResetAt = (policy = 'utc-midnight', now = Date.now()) => {
  const d = new Date(now);
  if (policy === 'pt-midnight') {
    // Google Gemini free tier resets at Pacific midnight.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '0';
    const ptHour = Number(get('hour')) % 24;
    const ptMin = Number(get('minute'));
    const ptSec = Number(get('second'));
    const elapsedMs = ((ptHour * 60 + ptMin) * 60 + ptSec) * 1000 + d.getMilliseconds();
    return now + (24 * 60 * 60 * 1000 - elapsedMs);
  }
  const elapsedMs = ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000 + d.getUTCMilliseconds();
  return now + (24 * 60 * 60 * 1000 - elapsedMs);
};

/** Stable "YYYY-MM-DD" bucket key in the provider's reset timezone. */
export const dayBucket = (policy = 'utc-midnight', now = Date.now()) => {
  if (policy === 'pt-midnight') {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(new Date(now));
  }
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export const monthBucket = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

/** Exponential backoff with full jitter, capped. */
export const backoffMs = (attempt, base = 250, cap = 8000) => {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
};

/* ------------------------------------------------------------------ *
 * Request identity / credential extraction
 * ------------------------------------------------------------------ */
export const randomId = () => crypto.randomBytes(8).toString('hex');

/**
 * Pull the caller credential out of either `x-api-key` or `Authorization`.
 * Header names arrive lower-cased from Node's HTTP parser.
 */
export const parseApiKey = (headers = {}) => {
  const direct = headers['x-api-key'] ?? headers['X-Api-Key'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const auth = headers.authorization ?? headers.Authorization;
  if (typeof auth === 'string' && auth.trim()) {
    const [scheme, value] = auth.trim().split(/\s+/);
    if (/^bearer$/i.test(scheme ?? '') && value) return value.trim();
    if (!value && scheme) return scheme.trim(); // tolerate a bare token
  }
  return '';
};
