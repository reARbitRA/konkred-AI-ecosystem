# Konkred AI Ecosystem

A production-ready, **zero-cost-by-design** multi-container AI stack:

| Service | Stack | Role |
|---|---|---|
| **gateway** | Node.js 20 (ESM, *zero runtime dependencies*) | Quota-aware reverse proxy that pools free-tier LLM APIs (Gemini, Groq, Cerebras, Mistral, OpenRouter, Cloudflare Workers AI, GitHub Models) behind one OpenAI-ish endpoint with sliding-window rate limiting, per-error-class fallback, response caching and in-flight de-duplication. |
| **bot** | Python 3.11 · Aiogram 3.15 · httpx · redis | Telegram front-end: multi-turn conversation memory in Redis, task modes, non-blocking typing indicators, Telegram-safe 4096-character chunking, resilient gateway client. |
| **redis** | Redis 7 (AOF) | Conversation history + Aiogram FSM storage. |

```
Telegram ──long polling──▶ bot ──HTTP x-api-key──▶ gateway ──▶ Gemini / Groq / Cerebras /
                                                    │           Mistral / OpenRouter /
                                                    │           Cloudflare / GitHub
                                                    └── in-memory quota windows, cache, dedup
                          bot ──RESP──▶ redis (history + FSM)
```

Everything is wired with Docker Compose, ships a Render blueprint for 1-click cloud
deployment, and is covered by a CI workflow that validates config, runs the test
suites and smoke-tests the real containers on every commit.

> **CI one-liner:** the pipeline lives at `ci/deploy.yml`. GitHub only executes
> workflows from `.github/workflows/`, and pushing there needs the `workflows`
> token scope, so activate it once with:
> ```bash
> ./scripts/install-workflow.sh && git add .github/workflows/deploy.yml && git commit -m "ci: enable pipeline" && git push
> ```

---

## Quickstart (local or VPS)

```bash
git clone https://github.com/reARbitRA/konkred-AI-ecosystem.git
cd konkred-AI-ecosystem

./setup.sh                 # creates .env, validates, builds, starts, health-checks
nano .env                  # add TELEGRAM_BOT_TOKEN + at least one provider key
docker compose up -d       # apply the new secrets
docker compose logs -f bot
```

Want to try it **without any API keys**? Run the offline simulator:

```bash
./setup.sh --mock          # DEMO_MOCK=true → gateway answers via the mock provider
curl -s localhost:3000/api/health | jq .
```

Other entry points:

```bash
./setup.sh --check         # static validation only (no Docker required)
./setup.sh --logs          # tail all services
./setup.sh --down          # stop (keeps the redis volume)
./scripts/verify.sh        # full test/verification suite (same as CI)
```

Then open Telegram, message your bot, send `/start`, pick a task and ask a question.
Every reply is footered with the provider/model that actually served it.

---

## Gateway API

All responses use one envelope: `{ "ok": true, "data": {...} }` or
`{ "ok": false, "error": { "code", "message" } }`. Rate-limit responses carry a
`Retry-After` header the bot honours.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/ai` | `x-api-key` | Inference with quota-aware routing |
| `GET` | `/api/health` | — | Liveness + pool summary |
| `GET` | `/api/ready` | — | Readiness; `503` when every key is cooling |
| `GET` | `/api/models` | `x-api-key` | Registry listing + availability flags |
| `GET` | `/api/status` | `x-admin-key` | Deep JSON status (pool, cache, callers) |
| `POST` | `/api/admin/cache/flush` | `x-admin-key` | Drop the response cache |
| `GET` | `/` | — | HTML status dashboard |

### `POST /api/ai`

```json
{
  "taskType": "code-generation",
  "messages": [{"role": "user", "content": "Write a chunker in Python"}],
  "maxTokens": 2048,
  "temperature": 0.3,
  "privacy": "private",
  "skipCache": false,
  "model": "groq:gpt-oss-120b"
}
```

| Field | Notes |
|---|---|
| `taskType` | `general`, `code-generation`, `bug-fixing`, `architecture`, `summarization`, `translate`, `extraction` |
| `messages` | OpenAI-style `[{role, content}]`; a bare `prompt` string is also accepted |
| `privacy` | `private` routes only to providers that do **not** train on your data |
| `model` | Optional preference — ranked first when it has capacity |

Response `data` contains `content`, `provider`, `model`, `modelId`, `usage`,
`cached`, `attemptCount` and a per-attempt `attempts[]` trace for debugging
fallback behaviour.

### Error codes

`MISSING_API_KEY` · `INVALID_API_KEY` · `UNKNOWN_TASK_TYPE` · `MISSING_MESSAGES` ·
`USER_RPM` / `USER_RPD` / `USER_TPD` (429 + `Retry-After`) · `CAPACITY_EXHAUSTED`
(503) · `NO_PROVIDER_CREDENTIALS` · `PAYLOAD_TOO_LARGE`.

---

## How quota-aware routing works

1. **Registry** — `gateway/data/policies.registry.json` declares each provider's
   reset policy (`utc-midnight`, or `pt-midnight` for Gemini), whether it trains on
   data, header names for learned limits, and every model's `rpm`/`rpd`/`tpm`/`tpd`/
   `monthlyTokens`/`contextWindow`/`quality`.
2. **Key pool** — sliding 60-second windows for RPM/TPM plus calendar-day and
   calendar-month counters per key. Keys are cooled down after a 429, disabled for an
   hour after an auth failure, and can *learn* real limits from provider headers.
3. **Router** — ranks `{model, key}` candidates by task preference, quality fit,
   privacy and remaining capacity, then interleaves providers so one saturated vendor
   cannot burn every attempt.
4. **Fallback policy** — each upstream error is classified and mapped to a decision:
   `SAME_MODEL_NEXT_KEY`, `NEXT_MODEL`, `TRIM_CONTEXT`, `BACKOFF` or `ABORT`
   (`gateway/src/gateway/fallback.mjs`). Context-length errors shrink history while
   always keeping the system prompt and the newest turn.
5. **Cache + dedup** — identical prompts within the TTL are answered from memory, and
   concurrent identical requests share a single upstream attempt (one unit of quota).
6. **Watchdog** — prunes expired windows, sweeps the cache and logs pool saturation
   every minute.

---

## Configuration

Copy `.env.example` → `.env` (done automatically by `setup.sh`). The full list, with
comments, lives in [`.env.example`](.env.example); `scripts/validate_env.py` fails CI
if code and template drift apart.

Minimum viable `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:AA...          # @BotFather
ADMIN_KEY=$(openssl rand -hex 32)            # generated by setup.sh
USERS_JSON=[{"key":"bot-internal-key","userId":"telegram-bot","tier":"internal"}]
GATEWAY_API_KEY=bot-internal-key
GROQ_API_KEY=gsk_...                          # any ONE provider key is enough
```

Optional allow-list: `ALLOWED_USER_IDS=111111,222222` restricts the bot to specific
Telegram accounts (empty = open to everyone).

---

## Project layout

```
.
├── docker-compose.yml          # redis + gateway + bot on one bridge network
├── .env.example                # documented template for every knob
├── render.yaml                 # 1-click Render blueprint (web + worker)
├── setup.sh                    # idempotent bootstrap/validate/build/start
├── ci/deploy.yml               # CI/CD pipeline (install with ./scripts/install-workflow.sh)
├── scripts/install-workflow.sh # copies ci/deploy.yml → .github/workflows/
├── scripts/
│   ├── verify.sh               # the whole suite, locally or in CI
│   ├── validate_compose.py     # topology/network/healthcheck assertions
│   ├── validate_env.py         # .env.example ↔ code agreement
│   ├── check_python_imports.py # stdlib/package shadowing audit
│   └── integration_bot_gateway.py  # real bot client ↔ real gateway
├── gateway/
│   ├── Dockerfile  package.json
│   ├── data/policies.registry.json
│   ├── scripts/{check,smoke}.mjs
│   ├── tests/gateway.test.mjs
│   └── src/
│       ├── server.mjs  config.mjs  util.mjs  policy-store.mjs
│       ├── watchdog.mjs  dashboard.mjs
│       ├── providers/{base,openai-compat,gemini,cloudflare,mock,index}.mjs
│       └── gateway/{gateway,router,key-pool,user-limiter,fallback,cache,dedup,fusion}.mjs
├── bot/
│   ├── Dockerfile  requirements.txt  healthcheck.py
│   ├── config.py  main.py  handlers.py  gateway_client.py
│   ├── history.py  keyboards.py  chunking.py
│   └── tests/{test_chunking,test_gateway_client,test_history,test_handlers}.py
├── Konkred ecosystem.md        # original architecture spec (source of truth)
└── step-by-step.md             # original manual install guide
```

---

## Testing

```bash
./scripts/verify.sh                    # everything (skips what your machine lacks)
cd gateway && node --test tests/*.test.mjs   # 31 gateway tests
cd gateway && node scripts/smoke.mjs         # 21 HTTP smoke checks
cd bot && PYTHONPATH=tests:. python -m unittest discover -s tests -p 'test_*.py' -t .   # 85 bot tests
python scripts/integration_bot_gateway.py    # 8 end-to-end checks
```

Coverage highlights: sliding-window ceilings and cooldowns, fallback decisions for
every error class, context trimming, cache TTL/dedup coalescing, caller quotas,
UTF-16-aware message chunking (emoji, code fences, no-boundary walls of text,
infinite-loop regressions), gateway cold starts, `Retry-After` (seconds and
HTTP-date), 503/504 retries, malformed 200s, Redis outages and corrupt payloads.

---

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for:

1. Docker Compose on any VPS (Ubuntu/Debian, incl. Oracle Always-Free) — truly 24/7 at $0
2. Render 1-click blueprint (`render.yaml`)
3. Koyeb CLI
4. Fly.io
5. Managed Redis (Upstash) wiring, secrets management, log/health monitoring, rollback

---

## Operational notes

* **24/7 for free**: a Telegram bot needs an always-on worker. Render's free *web*
  plan sleeps, and free background workers do not exist — so the fully-free path is a
  Docker Compose host (Oracle Always-Free ARM VM, or any $0-tier machine) with the
  Render blueprint as the low-cost managed alternative.
* **Cold starts**: the bot waits for `GET /api/health` before polling and retries
  connect errors with backoff, so a sleeping/scaled-to-zero gateway recovers by itself.
* **Secrets**: `.env` is git-ignored and created with mode `600`. Never commit keys.
* **State**: Redis runs with AOF on a named volume; history keys expire after 24h.

## License

MIT — see headers in each source file.
