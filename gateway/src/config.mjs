/**
 * Konkred Free-API Maximizer v2 — central configuration.
 * Zero external dependencies (Node >= 20 built-ins only).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = path.resolve(SRC_DIR, '..');

/* ------------------------------------------------------------------ *
 * Primitive env helpers
 * ------------------------------------------------------------------ */
const raw = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === null ? fallback : String(v);
};

const trimmed = (key, fallback = '') => raw(key, fallback).trim();

const int = (key, fallback) => {
  const v = Number.parseInt(trimmed(key, ''), 10);
  return Number.isFinite(v) ? v : fallback;
};

const bool = (key, fallback = false) => {
  const v = trimmed(key, '').toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
};

/** Split a comma / whitespace separated list into unique non-empty strings. */
export const toList = (value) =>
  String(value ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Collect provider keys from every supported convention:
 *   GROQ_API_KEY, GROQ_API_KEYS, GROQ_KEY_P1..GROQ_KEY_P5
 * Returns a de-duplicated array (order preserved = priority order).
 */
const collectKeys = (baseName, { slots = 6 } = {}) => {
  const found = [];
  found.push(...toList(raw(`${baseName}_API_KEY`)), ...toList(raw(`${baseName}_API_KEYS`)));
  for (let i = 1; i <= slots; i += 1) {
    found.push(...toList(raw(`${baseName}_KEY_P${i}`)), ...toList(raw(`${baseName}_KEY${i}`)));
  }
  return [...new Set(found.filter(Boolean))];
};

/* ------------------------------------------------------------------ *
 * User / auth directory
 * ------------------------------------------------------------------ */
const parseUsers = () => {
  const inline = trimmed('USERS_JSON', '');
  if (inline) {
    try {
      const parsed = JSON.parse(inline);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.warn(`[config] USERS_JSON is not valid JSON (${err.message}); falling back to USERS_JSON_PATH`);
    }
  }
  const file = trimmed('USERS_JSON_PATH', '');
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.warn(`[config] USERS_JSON_PATH could not be parsed: ${err.message}`);
    }
  }
  return [];
};

/** Per-tier sliding window budgets applied by user-limiter.mjs */
export const TIER_LIMITS = {
  internal: { rpm: int('INTERNAL_RPM', 240), rpd: int('INTERNAL_RPD', 100000), tpd: int('INTERNAL_TPD', 0) },
  trusted: { rpm: int('TRUSTED_RPM', 30), rpd: int('TRUSTED_RPD', 2000), tpd: int('TRUSTED_TPD', 2000000) },
  standard: { rpm: int('STANDARD_RPM', 10), rpd: int('STANDARD_RPD', 500), tpd: int('STANDARD_TPD', 500000) },
  free: { rpm: int('FREE_RPM', 4), rpd: int('FREE_RPD', 120), tpd: int('FREE_TPD', 150000) },
};

/* ------------------------------------------------------------------ *
 * Exported configuration object
 * ------------------------------------------------------------------ */
export const config = Object.freeze({
  env: trimmed('NODE_ENV', 'production'),
  host: trimmed('HOST', '0.0.0.0'),
  port: int('PORT', 3000),

  serviceRoot: SERVICE_ROOT,
  registryPath: path.isAbsolute(trimmed('REGISTRY_PATH', ''))
    ? trimmed('REGISTRY_PATH')
    : path.join(SERVICE_ROOT, trimmed('REGISTRY_PATH', 'data/policies.registry.json')),

  adminKey: trimmed('ADMIN_KEY', ''),
  users: parseUsers(),
  tierLimits: TIER_LIMITS,
  allowAnonymous: bool('ALLOW_ANONYMOUS', false),
  anonymousTier: trimmed('ANONYMOUS_TIER', 'free'),

  /** Force the offline simulator on (used by CI + local smoke tests). */
  demoMock: bool('DEMO_MOCK', false),
  /** Allow the mock provider to act as last-resort capacity when no real key is configured. */
  mockFallback: bool('MOCK_FALLBACK', true),

  providers: Object.freeze({
    gemini: Object.freeze({ keys: collectKeys('GEMINI') }),
    groq: Object.freeze({ keys: collectKeys('GROQ') }),
    cerebras: Object.freeze({ keys: collectKeys('CEREBRAS') }),
    mistral: Object.freeze({ keys: collectKeys('MISTRAL') }),
    openrouter: Object.freeze({ keys: collectKeys('OPENROUTER') }),
    github: Object.freeze({ keys: collectKeys('GITHUB') }),
    cloudflare: Object.freeze({
      accountId: trimmed('CF_ACCOUNT_ID', ''),
      tokens: collectKeys('CF', { slots: 3 }).length
        ? collectKeys('CF', { slots: 3 })
        : toList(raw('CF_API_TOKEN')),
    }),
  }),

  /* ---------------- Request / routing behaviour ---------------- */
  maxAttempts: int('MAX_ATTEMPTS', 6),
  attemptTimeoutMs: int('ATTEMPT_TIMEOUT_MS', 90000),
  connectTimeoutMs: int('CONNECT_TIMEOUT_MS', 10000),
  requestBodyLimitBytes: int('REQUEST_BODY_LIMIT_BYTES', 2 * 1024 * 1024),
  defaultMaxTokens: int('DEFAULT_MAX_TOKENS', 2048),
  hardMaxTokens: int('HARD_MAX_TOKENS', 8192),
  maxMessages: int('MAX_MESSAGES', 60),
  cooldownAfterRateLimitMs: int('COOLDOWN_AFTER_RATE_LIMIT_MS', 60000),
  cooldownAfterAuthFailureMs: int('COOLDOWN_AFTER_AUTH_FAILURE_MS', 3600000),
  contextTrimRatio: Number.parseFloat(trimmed('CONTEXT_TRIM_RATIO', '0.45')) || 0.45,

  /* ---------------- Cache / dedup ---------------- */
  cacheEnabled: bool('CACHE_ENABLED', true),
  cacheTtlMs: int('CACHE_TTL_MS', 15 * 60 * 1000),
  cacheMaxEntries: int('CACHE_MAX_ENTRIES', 500),
  dedupEnabled: bool('DEDUP_ENABLED', true),
  dedupTtlMs: int('DEDUP_TTL_MS', 120000),

  /* ---------------- Watchdog ---------------- */
  watchdogIntervalMs: int('WATCHDOG_INTERVAL_MS', 60000),
  watchdogEnabled: bool('WATCHDOG_ENABLED', true),
  dashboardEnabled: bool('DASHBOARD_ENABLED', true),
  corsAllowAll: bool('CORS_ALLOW_ALL', false),
  corsOrigins: toList(raw('CORS_ALLOW_ORIGINS', '')),
});

/** Names of providers that currently have usable credentials. */
export const enabledProviderIds = () => {
  const enabled = [];
  for (const [id, cfg] of Object.entries(config.providers)) {
    if (id === 'cloudflare') {
      if (cfg.accountId && cfg.tokens.length) enabled.push(id);
    } else if (cfg.keys?.length) {
      enabled.push(id);
    }
  }
  if (config.demoMock || config.mockFallback) enabled.push('mock');
  return [...new Set(enabled)];
};

export default config;
