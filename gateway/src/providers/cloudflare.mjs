/**
 * Cloudflare Workers AI adapter (account-scoped REST endpoint).
 */
import { BaseProvider, extractOpenAIContent, extractOpenAIUsage, ProviderError } from './base.mjs';
import { config } from '../config.mjs';

export class CloudflareProvider extends BaseProvider {
  constructor({ id = 'cloudflare', name = 'Cloudflare Workers AI' } = {}) {
    super({ id, name });
  }

  #url(model) {
    const accountId = config.providers.cloudflare.accountId;
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
  }

  async chat({ model, messages, maxTokens = 1024, temperature = 0.5, key, timeoutMs = 90_000 }) {
    const accountId = config.providers.cloudflare.accountId;
    if (!accountId) {
      throw new ProviderError({
        status: 0,
        code: 'CF_ACCOUNT_MISSING',
        message: 'CF_ACCOUNT_ID is not configured',
        providerId: this.id,
        modelId: model.id,
      });
    }

    const body = { model: model.modelName, messages, max_tokens: maxTokens, temperature, stream: false };
    const { json, headers, latencyMs } = await this.request(this.#url(model), {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${key.key}`,
      },
      body,
      timeoutMs,
      modelId: model.id,
    });

    // Cloudflare wraps OpenAI-style payloads in { result: {...} }
    const payload = json?.result ?? json;
    const content = extractOpenAIContent(payload);
    if (!content) {
      throw new ProviderError({
        status: 502,
        code: 'EMPTY_COMPLETION',
        message: `Cloudflare returned an empty completion${json?.errors?.length ? `: ${JSON.stringify(json.errors).slice(0, 200)}` : ''}`,
        providerId: this.id,
        modelId: model.id,
      });
    }

    return {
      content,
      usage: extractOpenAIUsage(payload),
      finishReason: payload?.choices?.[0]?.finish_reason ?? null,
      headers,
      latencyMs,
      raw: { cfRay: headers?.get?.('cf-ray') ?? null },
    };
  }
}

export default CloudflareProvider;
