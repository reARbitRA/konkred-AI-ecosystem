/**
 * Provider factory — maps registry providerIds to concrete adapters.
 */
import { policyStore } from '../policy-store.mjs';
import { config } from '../config.mjs';
import { keyPool } from '../gateway/key-pool.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { GeminiProvider } from './gemini.mjs';
import { CloudflareProvider } from './cloudflare.mjs';
import { MockProvider } from './mock.mjs';
import { log } from '../util.mjs';

const registry = new Map();

const build = (providerId) => {
  const meta = policyStore.provider(providerId);
  const name = meta?.name ?? providerId;
  switch (providerId) {
    case 'gemini':
      return new GeminiProvider({ id: providerId, name });
    case 'cloudflare':
      return new CloudflareProvider({ id: providerId, name });
    case 'mock':
      return new MockProvider({ id: providerId, name });
    case 'groq':
    case 'cerebras':
    case 'mistral':
    case 'openrouter':
    case 'github':
      return new OpenAICompatProvider({ id: providerId, name });
    default:
      // Unknown providers default to the OpenAI-compatible shape.
      return new OpenAICompatProvider({ id: providerId, name, endpoint: process.env[`${providerId.toUpperCase()}_BASE_URL`] ?? null });
  }
};

/** Instantiate an adapter for every provider that has credentials in the pool. */
export const initProviders = () => {
  registry.clear();
  for (const providerId of policyStore.providers.keys()) {
    if (!keyPool.hasProvider(providerId)) continue;
    if (providerId === 'mock' && !config.demoMock && !config.mockFallback) continue;
    try {
      registry.set(providerId, build(providerId));
    } catch (err) {
      log.error('providers', `failed to initialise "${providerId}": ${err.message}`);
    }
  }
  log.info('providers', `active adapters: ${[...registry.keys()].join(', ') || '(none)'}`);
  return registry;
};

export const getProvider = (providerId) => registry.get(providerId) ?? null;
export const hasProvider = (providerId) => registry.has(providerId);
export const activeProviderIds = () => [...registry.keys()];
export const providerStats = () =>
  [...registry.values()].map((p) => ({ id: p.id, name: p.name, offline: Boolean(p.isOffline), keys: keyPool.keysFor(p.id).length }));

export { OpenAICompatProvider, GeminiProvider, CloudflareProvider, MockProvider };
export default registry;
