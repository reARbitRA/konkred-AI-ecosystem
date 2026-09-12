/**
 * OpenAI-compatible edge — the "use the brain anywhere" door.
 *
 *   POST /v1/chat/completions   OpenAI chat shape (stream + non-stream)
 *   GET  /v1/models             OpenAI model list
 *
 * Any tool that speaks the OpenAI API (Discord/Slack bots via an SDK,
 * Discourse AI plugin, Continue, Cursor, LibreChat, n8n, Zapier, curl …)
 * can point its base URL at this gateway and authenticate with any key from
 * USERS_JSON (x-api-key or Authorization: Bearer). Requests are served by the
 * same quota-aware pool as /api/ai and /api/fullkonk/*: failover, cooldowns,
 * cache and dedup all apply.
 */
import { config } from './config.mjs';
import { policyStore } from './policy-store.mjs';
import { userLimiter } from './gateway/user-limiter.mjs';
import { runInference, validateRequest, GatewayError } from './gateway/gateway.mjs';
import { log, readJsonBody, sendJson, randomId, sleep, parseApiKey } from './util.mjs';

const authenticate = (req) => {
  const key = parseApiKey(req.headers);
  if (!key) {
    if (config.allowAnonymous) return { userId: 'anonymous', tier: config.anonymousTier, key: null };
    throw new GatewayError(401, 'MISSING_API_KEY', 'Provide an API key via "x-api-key" or "Authorization: Bearer <key>"');
  }
  const caller = userLimiter.authenticate(key);
  if (!caller) throw new GatewayError(401, 'INVALID_API_KEY', 'The supplied API key is not present in USERS_JSON');
  return caller;
};

const openAiError = (res, err) => {
  const status = err?.status ?? 500;
  return sendJson(res, status, {
    error: {
      message: err?.message ?? 'Internal error',
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: String(err?.code ?? 'internal_error').toLowerCase(),
    },
  });
};

export const handleOpenAiModels = (req, res) => {
  const created = Math.floor(Date.now() / 1000);
  return sendJson(res, 200, {
    object: 'list',
    data: policyStore.models.map((m) => ({
      id: m.id,
      object: 'model',
      created,
      owned_by: m.providerId,
    })),
  });
};

export const handleOpenAiChat = async (req, res) => {
  let caller;
  try {
    caller = authenticate(req);
    const body = await readJsonBody(req);
    const request = validateRequest({
      taskType: body.taskType ?? 'general',
      messages: body.messages,
      prompt: body.prompt,
      maxTokens: body.max_tokens ?? body.maxTokens,
      temperature: body.temperature,
      privacy: body.privacy,
      systemPrompt: body.systemPrompt,
      model: body.model,
    });
    const stream = Boolean(body.stream);
    const completionId = `chatcmpl-${randomId()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      const result = await runInference(request, { caller, requestId: completionId });
      return sendJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model: result.modelId ?? result.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.content },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: result.usage?.promptTokens ?? 0,
          completion_tokens: result.usage?.completionTokens ?? 0,
          total_tokens: result.usage?.totalTokens ?? 0,
        },
      });
    }

    /* ---------------- streaming (SSE, OpenAI chunk grammar) ---------------- */
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const modelLabel = request.preferredModel ?? 'konkred-auto';
    const chunk = (delta, finishReason = null) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelLabel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
    };

    let closed = false;
    req.on('close', () => { closed = true; });
    chunk({ role: 'assistant', content: '' });
    try {
      const result = await runInference(request, { caller, requestId: completionId });
      let rest = String(result.content ?? '');
      while (rest.length && !closed && !res.destroyed) {
        let size = Math.min(480, rest.length);
        if (size < rest.length) {
          const cut = rest.lastIndexOf('\n', size);
          if (cut > size * 0.5) size = cut + 1;
        }
        chunk({ content: rest.slice(0, size) });
        rest = rest.slice(size);
        if (rest) await sleep(4);
      }
      chunk({}, 'stop');
    } catch (err) {
      log.warn('openai-shim', `stream aborted: ${err?.message ?? err}`);
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({
          error: {
            message: err?.message ?? 'Upstream failure',
            type: (err?.status ?? 500) >= 500 ? 'server_error' : 'invalid_request_error',
            code: String(err?.code ?? 'upstream_error').toLowerCase(),
          },
        })}\n\n`);
      }
    }
    if (!res.writableEnded && !res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return undefined;
  } catch (err) {
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) res.end();
      return undefined;
    }
    return openAiError(res, err);
  }
};
