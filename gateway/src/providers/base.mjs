/**
 * Base provider contract: HTTP plumbing, timeout handling and error
 * normalisation shared by every concrete provider adapter.
 */
import { classifyError, parseRetryAfter, log } from '../util.mjs';

export class ProviderError extends Error {
  constructor({ status = 0, code = 'UPSTREAM_ERROR', message = 'Upstream request failed', errorClass = null, retryAfterSec = null, providerId = null, modelId = null }) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.errorClass = errorClass ?? classifyError({ status, message, code });
    this.retryAfterSec = retryAfterSec;
    this.providerId = providerId;
    this.modelId = modelId;
  }

  toJSON() {
    return {
      status: this.status,
      code: this.code,
      errorClass: this.errorClass,
      message: this.message,
      retryAfterSec: this.retryAfterSec,
      providerId: this.providerId,
      modelId: this.modelId,
    };
  }
}

export class BaseProvider {
  /** @param {{id:string, name?:string}} meta */
  constructor({ id, name }) {
    this.id = id;
    this.name = name ?? id;
  }

  /** Providers that talk to the network override this. */
  get isOffline() {
    return false;
  }

  /**
   * @param {object} req
   * @param {object} req.model       registry model record
   * @param {Array}  req.messages    [{role, content}]
   * @param {number} req.maxTokens
   * @param {number} req.temperature
   * @param {object} req.key         KeyState from the pool
   * @param {number} req.timeoutMs
   * @returns {Promise<{content:string, usage:object, finishReason:string|null, headers:Headers}>}
   */
  async chat() {
    throw new Error(`${this.constructor.name} must implement chat()`);
  }

  /** fetch with an abort deadline + normalised error surface. */
  async request(url, { method = 'POST', headers = {}, body = null, timeoutMs = 90_000, modelId = null }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      throw new ProviderError({
        status: aborted ? 504 : 0,
        code: aborted ? 'TIMEOUT' : 'NETWORK',
        message: aborted ? `Upstream timed out after ${timeoutMs}ms` : `Network error: ${err?.message ?? err}`,
        providerId: this.id,
        modelId,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!response.ok) {
      const message =
        json?.error?.message ??
        json?.message ??
        json?.error?.msg ??
        (text.slice(0, 400) || `HTTP ${response.status}`);
      const code = json?.error?.code ?? json?.error?.type ?? json?.code ?? `HTTP_${response.status}`;
      throw new ProviderError({
        status: response.status,
        code: String(code),
        message: String(message),
        retryAfterSec: parseRetryAfter(response.headers),
        providerId: this.id,
        modelId,
      });
    }

    if (!json) {
      log.warn(this.id, `non-JSON 200 response (${latencyMs}ms)`, { modelId });
      throw new ProviderError({
        status: 502,
        code: 'BAD_GATEWAY',
        message: 'Upstream returned a non-JSON body',
        providerId: this.id,
        modelId,
      });
    }
    return { json, headers: response.headers, latencyMs, status: response.status };
  }
}

/** Extract the first usable string out of an OpenAI-style completion body. */
export const extractOpenAIContent = (json) => {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.length) return content;
  if (Array.isArray(content)) {
    const joined = content.map((part) => part?.text ?? '').filter(Boolean).join('\n');
    if (joined) return joined;
  }
  if (Array.isArray(choice?.message?.reasoning)) {
    const joined = choice.message.reasoning.map((p) => p?.text ?? '').filter(Boolean).join('\n');
    if (joined) return joined;
  }
  if (typeof choice?.text === 'string' && choice.text.length) return choice.text;
  return '';
};

export const extractOpenAIUsage = (json) => ({
  promptTokens: json?.usage?.prompt_tokens ?? 0,
  completionTokens: json?.usage?.completion_tokens ?? 0,
  totalTokens: json?.usage?.total_tokens ?? 0,
});

export default BaseProvider;
