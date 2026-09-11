/**
 * Loads + validates gateway/data/policies.registry.json and exposes
 * provider metadata, model records and task-type routing preferences.
 */
import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.mjs';
import { log } from './util.mjs';

const TASK_PREFERENCES = Object.freeze({
  general: { quality: 3, prefer: ['gemini:flash', 'groq:llama-70b', 'cerebras:gpt-oss-120b', 'mock:atlas-70b'] },
  'code-generation': { quality: 4, prefer: ['mistral:codestral', 'groq:gpt-oss-120b', 'cerebras:gpt-oss-120b', 'github:gpt-4o', 'gemini:flash', 'mock:atlas-70b'] },
  'bug-fixing': { quality: 4, prefer: ['groq:gpt-oss-120b', 'cerebras:gpt-oss-120b', 'mistral:codestral', 'gemini:flash', 'github:gpt-4o', 'mock:atlas-70b'] },
  architecture: { quality: 5, prefer: ['cerebras:qwen3-235b', 'github:gpt-4o', 'groq:kimi-k2', 'gemini:flash', 'mock:atlas-70b'] },
  summarization: { quality: 3, prefer: ['gemini:flash', 'groq:llama-70b', 'cerebras:gpt-oss-120b', 'groq:llama-8b', 'mock:atlas-70b'] },
  translate: { quality: 3, prefer: ['gemini:flash-lite', 'groq:llama-8b', 'cerebras:llama-8b', 'cloudflare:llama-8b', 'mock:sparrow-8b'] },
  extraction: { quality: 3, prefer: ['gemini:flash', 'groq:llama-8b', 'cerebras:llama-8b', 'mock:sparrow-8b'] },
});

const DEFAULT_TASK = 'general';

const REQUIRED_MODEL_FIELDS = ['id', 'providerId', 'modelName'];

class PolicyStore {
  #raw;
  #providers = new Map();
  #models = new Map();
  #modelsByProvider = new Map();

  constructor() {
    this.loadedAt = null;
    this.path = config.registryPath;
  }

  load() {
    if (!existsSync(this.path)) {
      throw new Error(`[policy-store] registry not found at ${this.path}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      throw new Error(`[policy-store] registry is not valid JSON: ${err.message}`);
    }

    const providers = parsed?.providers;
    const models = parsed?.models;
    if (!providers || typeof providers !== 'object') throw new Error('[policy-store] registry.providers is missing');
    if (!Array.isArray(models) || models.length === 0) throw new Error('[policy-store] registry.models is missing or empty');

    this.#providers = new Map();
    for (const [id, meta] of Object.entries(providers)) {
      this.#providers.set(id, {
        id,
        name: meta?.name ?? id,
        resetPolicy: meta?.resetPolicy ?? 'utc-midnight',
        trainsOnData: Boolean(meta?.trainsOnData),
        learnFromHeaders: meta?.learnFromHeaders ?? null,
        probe: meta?.probe ?? { kind: 'none' },
      });
    }

    this.#models = new Map();
    this.#modelsByProvider = new Map();
    for (const model of models) {
      for (const field of REQUIRED_MODEL_FIELDS) {
        if (!model?.[field]) throw new Error(`[policy-store] model record missing "${field}": ${JSON.stringify(model)}`);
      }
      if (!this.#providers.has(model.providerId)) {
        throw new Error(`[policy-store] model "${model.id}" references unknown provider "${model.providerId}"`);
      }
      const record = Object.freeze({
        id: model.id,
        providerId: model.providerId,
        modelName: model.modelName,
        rpm: Number.isFinite(model.rpm) ? model.rpm : null,
        rpd: Number.isFinite(model.rpd) ? model.rpd : null,
        tpm: Number.isFinite(model.tpm) ? model.tpm : null,
        tpd: Number.isFinite(model.tpd) ? model.tpd : null,
        monthlyTokens: Number.isFinite(model.monthlyTokens) ? model.monthlyTokens : null,
        contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : 8192,
        quality: Number.isFinite(model.quality) ? model.quality : 3,
        lastVerifiedAt: model.lastVerifiedAt ?? null,
        confidence: model.confidence ?? 'unknown',
      });
      this.#models.set(record.id, record);
      if (!this.#modelsByProvider.has(record.providerId)) this.#modelsByProvider.set(record.providerId, []);
      this.#modelsByProvider.get(record.providerId).push(record);
    }

    this.#raw = parsed;
    this.loadedAt = new Date().toISOString();
    log.info('policy-store', `loaded ${this.#models.size} models across ${this.#providers.size} providers`, {
      registryBuiltAt: parsed.registryBuiltAt ?? null,
      path: this.path,
    });
    return this;
  }

  get providers() {
    return this.#providers;
  }

  get models() {
    return [...this.#models.values()];
  }

  provider(id) {
    return this.#providers.get(id) ?? null;
  }

  model(id) {
    return this.#models.get(id) ?? null;
  }

  modelsForProvider(providerId) {
    return this.#modelsByProvider.get(providerId) ?? [];
  }

  trainsOnData(providerId) {
    return Boolean(this.#providers.get(providerId)?.trainsOnData);
  }

  resetPolicy(providerId) {
    return this.#providers.get(providerId)?.resetPolicy ?? 'utc-midnight';
  }

  learnFromHeaders(providerId) {
    return this.#providers.get(providerId)?.learnFromHeaders ?? null;
  }

  taskPreference(taskType) {
    const key = String(taskType ?? DEFAULT_TASK).toLowerCase();
    return TASK_PREFERENCES[key] ?? TASK_PREFERENCES[DEFAULT_TASK];
  }

  knownTaskTypes() {
    return Object.keys(TASK_PREFERENCES);
  }

  summary() {
    return {
      path: this.path,
      loadedAt: this.loadedAt,
      registryBuiltAt: this.#raw?.registryBuiltAt ?? null,
      providerCount: this.#providers.size,
      modelCount: this.#models.size,
      taskTypes: this.knownTaskTypes(),
    };
  }
}

export const policyStore = new PolicyStore();
export { TASK_PREFERENCES, DEFAULT_TASK };
export default policyStore;
