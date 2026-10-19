/**
 * Konkred Free-API Maximizer v2 — central configuration.
 * Zero external dependencies (Node >= 20 built-ins only).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVIDER_PROFILES } from './providers/profiles.mjs';

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
 * Collect provider keys without exposing their values in diagnostics. Supported
 * forms include PREFIX_API_KEY(S), PREFIX_KEY_P1..P6, PREFIX_KEY1..6 and
 * PREFIX_API_KEY_P1..P6. Aliases such as HF_TOKEN are handled by the detector.
 */
const collectKeys = (prefixes, { slots = 6, env = process.env } = {}) => {
  const found = [];
  for (const prefix of Array.isArray(prefixes) ? prefixes : [prefixes]) {
    const base = String(prefix).toUpperCase().replace(/-/g, '_');
    const names = [`${base}_API_KEY`, `${base}_API_KEYS`];
    for (let i = 1; i <= slots; i += 1) {
      names.push(`${base}_KEY_P${i}`, `${base}_KEY${i}`, `${base}_API_KEY_P${i}`, `${base}_API_KEY${i}`);
    }
    if (base === 'HF' || base === 'HUGGINGFACE' || base === 'HUGGING_FACE') names.push('HF_TOKEN');
    if (base === 'CF' || base === 'CLOUDFLARE') names.push('CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN');
    for (const name of names) found.push(...toList(env[name] ?? ''));
  }
  return [...new Set(found.filter(Boolean))];
};

const providerIdForPrefix = (prefix) => {
  const normalized = String(prefix).toUpperCase().replace(/-/g, '_');
  const aliases = {
    APIMIX: 'apmix',
    HUGGING_FACE: 'huggingface',
    HF: 'huggingface',
    CLOUDFLARE: 'cloudflare',
    CF: 'cloudflare',
    GITHUB: 'github',
  };
  return aliases[normalized] ?? normalized.toLowerCase().replace(/_+/g, '-');
};

const prefixForProviderId = (providerId) => String(providerId).toUpperCase().replace(/-/g, '_');

const keyPrefixFromEnvName = (name) => {
  const patterns = [
    /^(.*)_API_KEYS?$/i,
    /^(.*)_API_KEY_P\d+$/i,
    /^(.*)_API_KEY\d+$/i,
    /^(.*)_KEY_P\d+$/i,
    /^(.*)_KEY\d+$/i,
  ];
  if (String(name).toUpperCase() === 'HF_TOKEN') return 'HF';
  for (const pattern of patterns) {
    const match = String(name).match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
};

const uniqueModelIdPart = (modelName) => String(modelName)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 72) || 'default';

const normalizeChatEndpoint = (baseUrl, explicitEndpoint = false) => {
  const value = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!value) return null;
  if (explicitEndpoint || /\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
};

const providerModelNames = (providerId, prefixes, profile, env) => {
  const base = prefixes[0] ?? prefixForProviderId(providerId);
  const modelEnv = profile?.modelEnv ?? `${base}_MODEL`;
  const modelsEnv = profile?.modelsEnv ?? `${base}_MODELS`;
  const explicitModels = toList(env[modelsEnv] ?? '');
  if (explicitModels.length) return explicitModels;
  const selected = String(env[modelEnv] ?? '').trim();
  if (selected) return [selected];
  return [...(profile?.defaultModels ?? [])];
};

const dynamicModels = (providerId, names, providerConfig, profile = {}) => names.map((modelName) => {
  const slug = uniqueModelIdPart(modelName);
  return {
    id: `${providerId}:${slug}`,
    providerId,
    modelName,
    rpm: providerConfig.rpm,
    rpd: null,
    tpm: providerConfig.tpm,
    tpd: null,
    monthlyTokens: null,
    contextWindow: providerConfig.contextWindow ?? profile.contextWindow ?? 32_768,
    quality: providerConfig.quality ?? profile.quality ?? 3,
    lastVerifiedAt: null,
    confidence: 'low',
  };
});

const makeProviderConfig = (providerId, prefixes, profile, env) => {
  const basePrefix = prefixes[0] ?? prefixForProviderId(providerId);
  const keys = collectKeys(prefixes, { env });
  const explicitEndpoint = String(env[`${basePrefix}_ENDPOINT`] ?? '').trim();
  const configuredBaseUrl = String(env[`${basePrefix}_BASE_URL`] ?? '').trim();
  const endpoint = explicitEndpoint
    ? normalizeChatEndpoint(explicitEndpoint, true)
    : normalizeChatEndpoint(configuredBaseUrl || profile?.baseUrl, false);
  const names = providerModelNames(providerId, prefixes, profile, env);
  const rpm = Number.parseInt(String(env[`${basePrefix}_RPM`] ?? ''), 10);
  const tpm = Number.parseInt(String(env[`${basePrefix}_TPM`] ?? ''), 10);
  const contextWindow = Number.parseInt(String(env[`${basePrefix}_CONTEXT_WINDOW`] ?? ''), 10);
  const providerConfig = {
    id: providerId,
    name: String(env[`${basePrefix}_PROVIDER_NAME`] ?? profile?.name ?? providerId).trim(),
    keys,
    endpoint,
    authHeader: String(env[`${basePrefix}_AUTH_HEADER`] ?? profile?.authHeader ?? 'Authorization').trim(),
    authScheme: String(env[`${basePrefix}_AUTH_SCHEME`] ?? profile?.authScheme ?? 'Bearer').trim(),
    rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : (profile?.rpm ?? 10),
    tpm: Number.isFinite(tpm) && tpm > 0 ? tpm : (profile?.tpm ?? 10_000),
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : (profile?.contextWindow ?? 32_768),
    quality: profile?.quality ?? 3,
    trainsOnData: Boolean(profile?.trainsOnData),
    resetPolicy: profile?.resetPolicy ?? 'utc-midnight',
    models: [],
  };
  providerConfig.models = dynamicModels(providerId, names, providerConfig, profile);
  return providerConfig;
};

const discoverProviderConfigs = (env = process.env) => {
  const configs = {
    gemini: makeProviderConfig('gemini', ['GEMINI'], { name: 'Google Generative Language' }, env),
    groq: makeProviderConfig('groq', ['GROQ'], { name: 'Groq Cloud' }, env),
    cerebras: makeProviderConfig('cerebras', ['CEREBRAS'], { name: 'Cerebras Inference' }, env),
    mistral: makeProviderConfig('mistral', ['MISTRAL'], { name: 'Mistral La Plateforme' }, env),
    openrouter: makeProviderConfig('openrouter', ['OPENROUTER'], { name: 'OpenRouter' }, env),
    github: makeProviderConfig('github', ['GITHUB'], { name: 'GitHub Models' }, env),
    cloudflare: {
      id: 'cloudflare',
      name: 'Cloudflare Workers AI',
      accountId: String(env.CF_ACCOUNT_ID ?? '').trim(),
      tokens: collectKeys(['CF', 'CLOUDFLARE'], { slots: 3, env }).length
        ? collectKeys(['CF', 'CLOUDFLARE'], { slots: 3, env })
        : toList(env.CF_API_TOKEN ?? ''),
    },
  };

  for (const [providerId, profile] of Object.entries(PROVIDER_PROFILES)) {
    const prefixes = profile.envPrefixes ?? [prefixForProviderId(providerId)];
    configs[providerId] = makeProviderConfig(providerId, prefixes, profile, env);
  }

  const candidatePrefixes = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    const prefix = keyPrefixFromEnvName(name);
    if (!prefix) continue;
    const providerId = providerIdForPrefix(prefix);
    if (!candidatePrefixes.has(providerId)) candidatePrefixes.set(providerId, new Set());
    candidatePrefixes.get(providerId).add(prefix.toUpperCase().replace(/-/g, '_'));
  }

  const unconfigured = [];
  for (const [providerId, candidates] of candidatePrefixes) {
    if (configs[providerId]) continue;
    const prefixes = [...candidates];
    const providerConfig = makeProviderConfig(providerId, prefixes, null, env);
    if (providerConfig.keys.length && providerConfig.endpoint && providerConfig.models.length) {
      configs[providerId] = providerConfig;
    } else if (providerConfig.keys.length) {
      unconfigured.push(providerId);
    }
  }

  const detected = [...new Set([
    ...candidatePrefixes.keys(),
    ...Object.entries(configs)
      .filter(([, provider]) => (provider.keys?.length ?? 0) > 0 || (provider.tokens?.length ?? 0) > 0)
      .map(([providerId]) => providerId),
  ])].sort();
  const configured = detected.filter((providerId) => configs[providerId] && !unconfigured.includes(providerId));

  return {
    providers: Object.freeze(Object.fromEntries(Object.entries(configs).map(([id, provider]) => [id, Object.freeze(provider)]))),
    scan: Object.freeze({
      detected: Object.freeze(detected),
      configured: Object.freeze(configured),
      unconfigured: Object.freeze(unconfigured.sort()),
    }),
  };
};

/** Gemini thinkingBudget: -1 (dynamic) or 0..24576 (Flash range); anything else -> 0. */
const geminiThinkingBudget = () => {
  const v = int('GEMINI_THINKING_BUDGET', 0);
  return v >= -1 && v <= 24576 ? v : 0;
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
  const encoded = trimmed('USERS_JSON_BASE64', '');
  if (encoded) {
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.warn(`[config] USERS_JSON_BASE64 is not valid base64-encoded JSON (${err.message}); falling back to USERS_JSON_PATH`);
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
const providerDiscovery = discoverProviderConfigs();

export const config = Object.freeze({
  env: trimmed('NODE_ENV', 'production'),
  host: trimmed('HOST', '0.0.0.0'),
  port: int('PORT', 3000),

  serviceRoot: SERVICE_ROOT,
  registryPath: path.isAbsolute(trimmed('REGISTRY_PATH', ''))
    ? trimmed('REGISTRY_PATH')
    : path.join(SERVICE_ROOT, trimmed('REGISTRY_PATH', 'data/policies.registry.json')),

  adminKey: trimmed('ADMIN_KEY', ''),
  /** Shared secret required on /api/fullkonk/* (x-brain-key). Empty = open (dev only). */
  fullkonkKey: trimmed('FULLKONK_KEY', ''),
  users: parseUsers(),
  tierLimits: TIER_LIMITS,
  allowAnonymous: bool('ALLOW_ANONYMOUS', false),
  anonymousTier: trimmed('ANONYMOUS_TIER', 'free'),

  /** Force the offline simulator on (used by CI + local smoke tests). */
  demoMock: bool('DEMO_MOCK', false),
  /** Allow the mock provider to act as last-resort capacity when no real key is configured. */
  mockFallback: bool('MOCK_FALLBACK', true),

  /** Provider adapters discovered from named secret variables at process start. */
  providers: providerDiscovery.providers,
  providerScan: providerDiscovery.scan,

  /* ---------------- Request / routing behaviour ---------------- */
  maxAttempts: int('MAX_ATTEMPTS', 6),
  attemptTimeoutMs: int('ATTEMPT_TIMEOUT_MS', 90000),
  connectTimeoutMs: int('CONNECT_TIMEOUT_MS', 10000),
  requestBodyLimitBytes: int('REQUEST_BODY_LIMIT_BYTES', 2 * 1024 * 1024),
  defaultMaxTokens: int('DEFAULT_MAX_TOKENS', 2048),
  /** Gemini 2.5 Flash / Flash-Lite thinking budget (see .env.example GEMINI_THINKING_BUDGET). */
  geminiThinkingBudget: geminiThinkingBudget(),
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
