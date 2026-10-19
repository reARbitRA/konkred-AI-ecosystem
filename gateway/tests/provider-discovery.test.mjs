import { test } from 'node:test';
import assert from 'node:assert/strict';

const testSecrets = {
  APMIX_API_KEY: 'test-apmix-secret',
  AGNES_API_KEY: 'test-agnes-secret',
  DEEPSEEK_API_KEY: 'test-deepseek-secret',
  HUGGINGFACE_API_KEY: 'test-hf-secret',
  CUSTOM_AI_API_KEY: 'test-custom-secret',
  CUSTOM_AI_BASE_URL: 'https://custom.example/v1/',
  CUSTOM_AI_MODEL: 'acme/chat-small',
  MISSING_PROVIDER_API_KEY: 'test-missing-secret',
  MISSING_PROVIDER_BASE_URL: '',
  MISSING_PROVIDER_MODEL: '',
  // A host GitHub credential is not an inference-provider key and must not be
  // captured by the environment scanner.
  GITHUB_TOKEN: 'do-not-use-as-an-inference-key',
  MOCK_FALLBACK: 'false',
};
Object.assign(process.env, testSecrets);

const { config, enabledProviderIds } = await import('../src/config.mjs');
const { policyStore } = await import('../src/policy-store.mjs');
const { keyPool } = await import('../src/gateway/key-pool.mjs');
const { initProviders, getProvider } = await import('../src/providers/index.mjs');

policyStore.load();
keyPool.init();
initProviders();

test('built-in provider credentials are discovered without revealing values', () => {
  for (const id of ['apmix', 'agnes', 'deepseek', 'huggingface']) {
    assert.ok(config.providerScan.detected.includes(id));
    assert.ok(config.providerScan.configured.includes(id));
    assert.ok(enabledProviderIds().includes(id));
    assert.ok(getProvider(id));
  }
  assert.ok(!config.providerScan.detected.includes('github'));
});

test('new provider profiles expose their OpenAI-compatible endpoint and model', () => {
  assert.equal(getProvider('apmix').endpoint, 'https://api.apmix.ai/v1/chat/completions');
  assert.equal(getProvider('agnes').endpoint, 'https://apihub.agnes-ai.com/v1/chat/completions');
  assert.equal(getProvider('deepseek').endpoint, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(getProvider('huggingface').endpoint, 'https://router.huggingface.co/v1/chat/completions');
  assert.ok(policyStore.model('agnes:agnes-2-5-flash'));
});

test('custom OpenAI-compatible providers are detected from key, base URL, and model', () => {
  const custom = config.providers['custom-ai'];
  assert.ok(custom);
  assert.deepEqual(custom.keys, ['test-custom-secret']);
  assert.equal(custom.endpoint, 'https://custom.example/v1/chat/completions');
  assert.equal(custom.models[0].modelName, 'acme/chat-small');
  assert.ok(policyStore.provider('custom-ai'));
  assert.ok(getProvider('custom-ai'));
});

test('a key without endpoint and model is reported but not activated', () => {
  assert.ok(config.providerScan.detected.includes('missing-provider'));
  assert.ok(config.providerScan.unconfigured.includes('missing-provider'));
  assert.ok(!enabledProviderIds().includes('missing-provider'));
  assert.equal(getProvider('missing-provider'), null);
});
