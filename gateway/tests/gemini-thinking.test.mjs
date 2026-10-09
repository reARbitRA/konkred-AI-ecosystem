/**
 * Gemini 2.5 Flash / Flash-Lite: thinking must be disabled (thinkingBudget=0 by
 * default) so thinking tokens do not consume maxOutputTokens and produce empty
 * MAX_TOKENS replies. Pro models cannot disable thinking, so they must not get
 * the field at all.
 *   node --test gateway/tests/gemini-thinking.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { GeminiProvider, supportsThinkingBudget } = await import('../src/providers/gemini.mjs');
const { config } = await import('../src/config.mjs');

const MSGS = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hi' },
];

afterEach(() => {
  delete globalThis.__geminiFetchStub;
});

test('default config disables thinking (GEMINI_THINKING_BUDGET unset -> 0)', () => {
  assert.equal(config.geminiThinkingBudget, 0);
});

test('flash and flash-lite get thinkingConfig.thinkingBudget = 0', () => {
  for (const modelName of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
    assert.equal(supportsThinkingBudget(modelName), true, modelName);
    const body = GeminiProvider.toGeminiPayload(MSGS, { maxTokens: 512, temperature: 0.2, modelName, thinkingBudget: 0 });
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, modelName);
    assert.equal(body.generationConfig.maxOutputTokens, 512);
  }
});

test('pro models never receive thinkingConfig (they cannot turn thinking off)', () => {
  assert.equal(supportsThinkingBudget('gemini-2.5-pro'), false);
  const body = GeminiProvider.toGeminiPayload(MSGS, { maxTokens: 512, temperature: 0.2, modelName: 'gemini-2.5-pro', thinkingBudget: 0 });
  assert.equal('thinkingConfig' in body.generationConfig, false);
});

test('a null thinkingBudget omits the field for flash too', () => {
  const body = GeminiProvider.toGeminiPayload(MSGS, { maxTokens: 512, temperature: 0.2, modelName: 'gemini-2.5-flash', thinkingBudget: null });
  assert.equal('thinkingConfig' in body.generationConfig, false);
});

test('GEMINI_THINKING_BUDGET env override is parsed and range-checked', async () => {
  const prev = process.env.GEMINI_THINKING_BUDGET;
  try {
    process.env.GEMINI_THINKING_BUDGET = '-1';
    const dynamic = await import('../src/config.mjs?budget=dynamic');
    assert.equal(dynamic.config.geminiThinkingBudget, -1);

    process.env.GEMINI_THINKING_BUDGET = '2048';
    const explicit = await import('../src/config.mjs?budget=2048');
    assert.equal(explicit.config.geminiThinkingBudget, 2048);

    process.env.GEMINI_THINKING_BUDGET = '999999'; // out of Flash range -> safe default
    const outOfRange = await import('../src/config.mjs?budget=oor');
    assert.equal(outOfRange.config.geminiThinkingBudget, 0);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_THINKING_BUDGET;
    else process.env.GEMINI_THINKING_BUDGET = prev;
  }
});

test('chat() puts thinkingConfig on the wire for a flash model', async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const provider = new GeminiProvider();
    const out = await provider.chat({
      model: { id: 'gemini:flash', modelName: 'gemini-2.5-flash' },
      messages: MSGS,
      maxTokens: 300,
      temperature: 0.3,
      key: { key: 'test-key' },
      timeoutMs: 5000,
      thinkingBudget: 0,
    });
    assert.equal(out.content, 'ok');
    assert.match(seen.url, /models\/gemini-2\.5-flash:generateContent/);
    assert.deepEqual(seen.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.equal(seen.body.generationConfig.maxOutputTokens, 300);
  } finally {
    globalThis.fetch = realFetch;
  }
});
