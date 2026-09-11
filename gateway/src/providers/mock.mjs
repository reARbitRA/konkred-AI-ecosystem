/**
 * Offline simulator — lets the whole stack (gateway + bot + CI) be exercised
 * without any upstream credentials or network access.
 */
import { BaseProvider } from './base.mjs';
import { estimateMessagesTokens, sleep } from '../util.mjs';

const FLAVOUR = Object.freeze({
  general: 'a concise, structured answer',
  'code-generation': 'a complete, runnable implementation',
  'bug-fixing': 'a root-cause analysis with a minimal patch',
  architecture: 'an architecture brief with trade-offs',
  summarization: 'a faithful summary',
  translate: 'a natural translation',
  extraction: 'structured extracted fields',
});

export class MockProvider extends BaseProvider {
  constructor({ id = 'mock', name = 'Offline Simulator' } = {}) {
    super({ id, name });
  }

  get isOffline() {
    return true;
  }

  async chat({ model, messages, maxTokens = 512, temperature = 0.5, key, timeoutMs = 90_000, taskType = 'general' }) {
    await sleep(40 + Math.random() * 120); // simulate latency

    const lastUser = [...(messages ?? [])].reverse().find((m) => String(m?.role ?? '').toLowerCase() === 'user');
    const prompt = String(lastUser?.content ?? '').trim() || '(empty prompt)';
    const promptTokens = estimateMessagesTokens(messages);
    const turnCount = Array.isArray(messages) ? messages.length : 0;

    const body = [
      `[${model.id} · offline simulator] ${FLAVOUR[taskType] ?? FLAVOUR.general} for:`,
      '',
      prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt,
      '',
      '--- simulated completion ---',
      `• task: ${taskType}`,
      `• messages forwarded: ${turnCount}`,
      `• temperature: ${temperature}, maxTokens: ${maxTokens}`,
      `• deterministic echo hash: ${(promptTokens * 31 + turnCount).toString(16)}`,
      '',
      'This response was produced by the offline simulator because no live provider',
      'credentials are configured (or every live provider is cooling down).',
    ].join('\n');

    const completionTokens = Math.ceil(body.length / 4);
    return {
      content: body,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      finishReason: 'stop',
      headers: null,
      latencyMs: 0,
      raw: { simulator: true, key: key?.label ?? 'mock' },
    };
  }
}

export default MockProvider;
