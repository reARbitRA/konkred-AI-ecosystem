/**
 * Generic OpenAI-compatible adapter covering Groq, Cerebras, Mistral,
 * OpenRouter and GitHub Models.
 */
import { BaseProvider, extractOpenAIContent, extractOpenAIUsage, ProviderError } from './base.mjs';

const ENDPOINTS = Object.freeze({
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  github: 'https://models.inference.ai.azure.com/chat/completions',
});

export class OpenAICompatProvider extends BaseProvider {
  constructor({ id, name, endpoint = null, extraHeaders = null }) {
    super({ id, name });
    this.endpoint = endpoint ?? ENDPOINTS[id];
    this.extraHeaders = extraHeaders ?? {};
    if (!this.endpoint) throw new Error(`[openai-compat] no endpoint configured for provider "${id}"`);
  }

  #authHeaders(key) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${key.key}`,
      ...this.extraHeaders,
    };
    if (this.id === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_REFERER ?? 'https://github.com/reARbitRA/konkred-AI-ecosystem';
      headers['X-Title'] = process.env.OPENROUTER_TITLE ?? 'Konkred Gateway';
    }
    return headers;
  }

  async chat({ model, messages, maxTokens = 2048, temperature = 0.5, key, timeoutMs = 90_000 }) {
    const body = {
      model: model.modelName,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };

    const { json, headers, latencyMs } = await this.request(this.endpoint, {
      headers: this.#authHeaders(key),
      body,
      timeoutMs,
      modelId: model.id,
    });

    const content = extractOpenAIContent(json);
    if (!content) {
      throw new ProviderError({
        status: 502,
        code: 'EMPTY_COMPLETION',
        message: `${this.id} returned an empty completion (finish_reason=${json?.choices?.[0]?.finish_reason ?? 'n/a'})`,
        providerId: this.id,
        modelId: model.id,
      });
    }

    return {
      content,
      usage: extractOpenAIUsage(json),
      finishReason: json?.choices?.[0]?.finish_reason ?? null,
      headers,
      latencyMs,
      raw: { id: json?.id ?? null, model: json?.model ?? model.modelName },
    };
  }
}

export { ENDPOINTS };
export default OpenAICompatProvider;
