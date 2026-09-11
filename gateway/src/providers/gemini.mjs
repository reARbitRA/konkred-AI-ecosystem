/**
 * Google Generative Language (Gemini) adapter — generateContent v1beta.
 */
import { BaseProvider, ProviderError } from './base.mjs';
import { log } from '../util.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SYSTEM_ROLES = new Set(['system', 'developer']);

export class GeminiProvider extends BaseProvider {
  constructor({ id = 'gemini', name = 'Google Generative Language' } = {}) {
    super({ id, name });
  }

  /** Translate OpenAI-style messages into Gemini `contents` + `systemInstruction`. */
  static toGeminiPayload(messages, { maxTokens, temperature }) {
    const systemParts = [];
    const contents = [];
    for (const m of messages ?? []) {
      const role = String(m?.role ?? 'user').toLowerCase();
      const text = String(m?.content ?? '');
      if (!text) continue;
      if (SYSTEM_ROLES.has(role)) {
        systemParts.push(text);
        continue;
      }
      contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
    }
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });

    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        candidateCount: 1,
      },
    };
    if (systemParts.length) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    return body;
  }

  async chat({ model, messages, maxTokens = 2048, temperature = 0.5, key, timeoutMs = 90_000 }) {
    const url = `${BASE}/${encodeURIComponent(model.modelName)}:generateContent?key=${encodeURIComponent(key.key)}`;
    const body = GeminiProvider.toGeminiPayload(messages, { maxTokens, temperature });

    const { json, headers, latencyMs } = await this.request(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      timeoutMs,
      modelId: model.id,
    });

    const candidate = json?.candidates?.[0];
    const content = (candidate?.content?.parts ?? [])
      .map((p) => p?.text ?? '')
      .filter(Boolean)
      .join('');

    if (!content) {
      const reason = candidate?.finishReason ?? json?.promptFeedback?.blockReason ?? 'UNKNOWN';
      const safety = candidate?.safetyRatings;
      throw new ProviderError({
        status: reason === 'MAX_TOKENS' ? 502 : 400,
        code: `GEMINI_${reason}`,
        message: `Gemini returned no content (finishReason=${reason}${safety ? `, safety=${JSON.stringify(safety).slice(0, 160)}` : ''})`,
        providerId: this.id,
        modelId: model.id,
      });
    }

    const usageMeta = json?.usageMetadata ?? {};
    const usage = {
      promptTokens: usageMeta.promptTokenCount ?? 0,
      completionTokens: usageMeta.candidatesTokenCount ?? 0,
      totalTokens: usageMeta.totalTokenCount ?? 0,
    };

    if (candidate?.finishReason === 'MAX_TOKENS') {
      log.warn(this.id, `completion truncated at maxOutputTokens=${maxTokens}`, { modelId: model.id });
    }

    return { content, usage, finishReason: candidate?.finishReason ?? null, headers, latencyMs, raw: { modelVersion: json?.modelVersion ?? null } };
  }
}

export default GeminiProvider;
