/**
 * Defaults for additional OpenAI-compatible providers. Providers can override
 * `*_BASE_URL` and `*_MODEL(S)` at deploy time. Unknown providers are accepted
 * when a key, base URL, and at least one model are configured.
 */
export const PROVIDER_PROFILES = Object.freeze({
  apmix: Object.freeze({
    name: 'APMIX',
    envPrefixes: ['APMIX', 'APIMIX'],
    baseUrl: 'https://api.apmix.ai/v1',
    modelEnv: 'APMIX_MODEL',
    modelsEnv: 'APMIX_MODELS',
    defaultModels: ['deepseek-v4.1-flash-free'],
    contextWindow: 65_536,
  }),
  agnes: Object.freeze({
    name: 'Agnes AI',
    envPrefixes: ['AGNES'],
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    modelEnv: 'AGNES_MODEL',
    modelsEnv: 'AGNES_MODELS',
    defaultModels: ['agnes-2.5-flash'],
    contextWindow: 524_288,
  }),
  deepseek: Object.freeze({
    name: 'DeepSeek',
    envPrefixes: ['DEEPSEEK'],
    baseUrl: 'https://api.deepseek.com/v1',
    modelEnv: 'DEEPSEEK_MODEL',
    modelsEnv: 'DEEPSEEK_MODELS',
    defaultModels: ['deepseek-chat'],
    contextWindow: 65_536,
  }),
  huggingface: Object.freeze({
    name: 'Hugging Face Inference Providers',
    envPrefixes: ['HUGGINGFACE', 'HUGGING_FACE', 'HF'],
    baseUrl: 'https://router.huggingface.co/v1',
    modelEnv: 'HUGGINGFACE_MODEL',
    modelsEnv: 'HUGGINGFACE_MODELS',
    defaultModels: ['Qwen/Qwen3-32B'],
    contextWindow: 32_768,
  }),
  openai: Object.freeze({
    name: 'OpenAI',
    envPrefixes: ['OPENAI'],
    baseUrl: 'https://api.openai.com/v1',
    modelEnv: 'OPENAI_MODEL',
    modelsEnv: 'OPENAI_MODELS',
    defaultModels: ['gpt-4o-mini'],
    contextWindow: 128_000,
  }),
});

export default PROVIDER_PROFILES;
