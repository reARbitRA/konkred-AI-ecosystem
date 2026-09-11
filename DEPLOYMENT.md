# Deployment Guide

Four ways to run the Konkred ecosystem 24/7, ordered from **free & self-hosted** to
**managed & one-click**. Pick one; they all use the same images, env vars and health
endpoints.

| Option | Cost | 24/7? | Effort |
|---|---|---|---|
| [1. Docker Compose on a VPS](#1-docker-compose-on-a-vps) | $0 (Oracle Always-Free) or ~$5/mo | ✅ | 10 min |
| [2. Render blueprint](#2-render-1-click-blueprint) | Gateway free · worker ~$7/mo | ✅ | 5 min |
| [3. Koyeb](#3-koyeb) | Free tier (1 small service) | ⚠️ partial | 10 min |
| [4. Fly.io](#4-flyio) | Pay-as-you-go, ~$2–5/mo | ✅ | 15 min |

**Reality check on "zero cost":** a Telegram bot long-polls, so it needs an
always-running process. Free *web* tiers that sleep (Render free, Koyeb free) will
drop updates while idle. The bot is built to survive that (it waits for the gateway's
`/api/health` and retries connect errors), but for genuinely uninterrupted 24/7
service use **option 1** on an Oracle Always-Free VM — 4 ARM cores / 24 GB RAM at $0.

---

## 0. Prerequisites

```bash
# Docker Engine + Compose plugin (Ubuntu/Debian)
curl -fsSL https://get.docker.com -o get-docker.sh && sudo sh get-docker.sh
sudo systemctl enable --now docker
sudo apt install -y docker-compose-plugin
docker --version && docker compose version

# Optional but recommended
sudo apt install -y jq curl
```

Credentials you need before deploying:

| What | Where |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram → `@BotFather` → `/newbot` |
| `ADMIN_KEY` | `openssl rand -hex 32` |
| ≥ 1 provider key | [Groq](https://console.groq.com/keys) · [Cerebras](https://cloud.cerebras.ai/) · [Gemini](https://aistudio.google.com/app/apikey) · [Mistral](https://console.mistral.ai/) · [OpenRouter](https://openrouter.ai/settings/keys) · [Cloudflare](https://dash.cloudflare.com/) · [GitHub Models](https://github.com/settings/tokens) |
| Redis (options 2–4 only) | [Upstash](https://upstash.com/) free tier → copy the **TLS (rediss://)** endpoint |

---

## 1. Docker Compose on a VPS

### 1.1 Get the code

```bash
git clone https://github.com/reARbitRA/konkred-AI-ecosystem.git
cd konkred-AI-ecosystem
git checkout main
```

### 1.2 Configure

```bash
./setup.sh --check      # validates structure, ESM syntax, python compile, compose file
cp .env.example .env    # setup.sh does this for you and generates ADMIN_KEY
nano .env
```

Fill in at minimum:

```env
TELEGRAM_BOT_TOKEN=123456789:AA...
ADMIN_KEY=<openssl rand -hex 32>
USERS_JSON=[{"key":"bot-internal-key","userId":"telegram-bot","tier":"internal"}]
GATEWAY_API_KEY=bot-internal-key
GROQ_API_KEY=gsk_...
CEREBRAS_API_KEY=csk-...
GEMINI_KEY_P1=...
DEMO_MOCK=false
ALLOWED_USER_IDS=<your telegram id>     # optional, recommended for public bots
```

```bash
chmod 600 .env
```

### 1.3 Build & start

```bash
./setup.sh                 # = docker compose build --pull && up -d && wait for healthy
docker compose ps          # redis + gateway should read (healthy)
docker compose logs -f bot
```

### 1.4 Verify

```bash
curl -s localhost:3000/api/health | jq '.data.pool, .data.providers'
curl -s -X POST localhost:3000/api/ai \
  -H 'Content-Type: application/json' -H 'x-api-key: bot-internal-key' \
  -d '{"taskType":"general","prompt":"Say hello"}' | jq '.data.provider, .data.modelId, .data.content'
curl -s -H "x-admin-key: $ADMIN_KEY" localhost:3000/api/status | jq '.data.pool.providers'
```

Open Telegram → `/start` → pick **Code Gen** → ask a question. The reply footer shows
which provider/model actually served it.

### 1.5 Firewall & exposure

The gateway port is published for debugging only. For a public host:

```bash
sudo ufw allow 22/tcp
sudo ufw deny 3000/tcp        # bot talks to the gateway over the internal network
sudo ufw enable
```

Or set `GATEWAY_PORT=127.0.0.1:3000:3000`-style binding by editing
`docker-compose.yml`'s `ports:` to `"127.0.0.1:3000:3000"` — the containers still
reach each other by service name on `konkred-internal-net`.

### 1.6 Day-2 operations

```bash
docker compose pull && docker compose up -d --build   # deploy a new version
docker compose logs -f --tail=100 gateway             # debug routing/fallback
docker compose restart bot                            # after changing .env secrets
./setup.sh --down                                     # stop (volume preserved)
docker volume rm konkred-AI-ecosystem_redis-data      # wipe history/FSM state
```

Auto-updates on push (optional, systemd unit):

```ini
# /etc/systemd/system/konkred-deploy.service
[Unit]
Description=Konkred deploy watcher
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/konkred-AI-ecosystem
ExecStart=/usr/bin/git pull --ff-only
ExecStart=/usr/bin/docker compose up -d --build
RemainAfterExit=no

# trigger with a GitHub webhook → `systemctl start konkred-deploy`
```

---

## 2. Render 1-click blueprint

[`render.yaml`](render.yaml) defines both services. Steps:

1. Push this repo to GitHub.
2. Render dashboard → **New +** → **Blueprint** → pick the repo → **Apply**.
3. Fill the `sync: false` variables it prompts for:
   * **konkred-gateway**: `USERS_JSON`, and any provider keys you have. `ADMIN_KEY`
     is generated automatically.
   * **konkred-bot**: `TELEGRAM_BOT_TOKEN`, `GATEWAY_API_KEY` (must match a `key` in
     `USERS_JSON`), `GATEWAY_URL`, `GATEWAY_HEALTH_URL`, `REDIS_URL`.
4. Copy the gateway's public URL from its **Settings** page and set, on the bot:
   ```
   GATEWAY_URL=https://konkred-gateway.onrender.com/api/ai
   GATEWAY_HEALTH_URL=https://konkred-gateway.onrender.com/api/health
   ```
   A bare origin also works — the client appends `/api/ai` automatically.
5. Create a free Redis at [Upstash](https://upstash.com/) and set:
   ```
   REDIS_URL=rediss://default:<password>@<endpoint>.upstash.io:6379
   ```
6. Deploy. Watch **Logs** for `gateway ready after N probe(s)` then
   `starting polling loop`.

**Costs:** the gateway runs on Render's free web plan (spins down after ~15 min idle,
~50 s cold start — the bot handles it). Background workers require the Starter plan
(~$7/mo). If you want $0, run the bot on a free VM and point `GATEWAY_URL` at the
Render gateway.

**Auto-deploy:** `autoDeploy: true` means every push to the tracked branch redeploys.
For an explicit trigger + audit trail, add the deploy hook:

1. Render service → **Settings** → **Deploy Hook** → copy the URL.
2. GitHub repo → **Settings → Secrets and variables → Actions** →
   * Secret `RENDER_DEPLOY_HOOK_URL` = the hook URL
   * Variable `PRODUCTION_URL` = `https://konkred-gateway.onrender.com`
3. Make sure the pipeline is installed (`.github/workflows/deploy.yml`, created by
   `./scripts/install-workflow.sh` from `ci/deploy.yml`). Its `deploy` job fires on
   every push to `main` after tests + container builds pass, then polls
   `/api/health` for 10 minutes.

---

## 3. Koyeb

Koyeb has no repo-root blueprint format, so use the CLI (free tier: one small service,
which fits the gateway; run the bot elsewhere or upgrade to a second service).

```bash
curl -sL https://get.koyeb.com | sudo bash     # or: pip install koyebctl
koyeb login

koyeb service create konkred-gateway \
  --type docker --dockerfile gateway/Dockerfile --docker-entrypoint "node src/server.mjs" \
  --ports 3000:http --health-checks 3000:http --routes /:3000 \
  --min-scale 1 --max-scale 1 --instance-type small \
  --env NODE_ENV=production --env DEMO_MOCK=false --env MOCK_FALLBACK=true \
  --env ADMIN_KEY@ <(openssl rand -hex 32) \
  --env USERS_JSON='[{"key":"bot-internal-key","userId":"telegram-bot","tier":"internal"}]' \
  --env GROQ_API_KEY@ --env CEREBRAS_API_KEY@ --env GEMINI_KEY_P1@ \
  --checks 3000:http:startup=/api/health:health=/api/health

koyeb service create konkred-bot \
  --type docker --dockerfile bot/Dockerfile --docker-entrypoint "python main.py" \
  --min-scale 1 --max-scale 1 --instance-type small \
  --env TELEGRAM_BOT_TOKEN@ --env GATEWAY_API_KEY=bot-internal-key \
  --env GATEWAY_URL=https://konkred-gateway-<org>.koyeb.app/api/ai \
  --env REDIS_URL=rediss://default:<password>@<endpoint>.upstash.io:6379 \
  --env STARTUP_WAIT_TIMEOUT=300

koyeb services list
koyeb logs konkred-bot --follow
```

Note: Koyeb builds from the repo root context; because each Dockerfile lives in its
service directory, pass `--dockerfile` as above (the CLI copies the repo and builds
that file). If your Koyeb plan only allows a root Dockerfile, add a thin
`Dockerfile.gateway` / `Dockerfile.bot` that `COPY`s from the respective directories.

---

## 4. Fly.io

```bash
curl -L https://fly.io/install.sh | sh && fly auth login
fly launch --no-deploy --copy-config --name konkred-gateway   # choose the gateway dir when prompted
# or create both apps explicitly:
fly apps create konkred-gateway
fly deploy --app konkred-gateway --dockerfile gateway/Dockerfile --local-only
fly secrets set --app konkred-gateway \
  ADMIN_KEY="$(openssl rand -hex 32)" \
  USERS_JSON='[{"key":"bot-internal-key","userId":"telegram-bot","tier":"internal"}]' \
  GROQ_API_KEY="$GROQ_API_KEY" DEMO_MOCK=false

fly apps create konkred-bot
fly deploy --app konkred-bot --dockerfile bot/Dockerfile --local-only
fly secrets set --app konkred-bot \
  TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  GATEWAY_API_KEY=bot-internal-key \
  GATEWAY_URL="https://konkred-gateway.fly.dev/api/ai" \
  REDIS_URL="rediss://default:<password>@<endpoint>.upstash.io:6379"

fly status --app konkred-gateway
fly logs --app konkred-bot
```

Prefer a private network over the public URL? Deploy both apps in the same region and
use `http://konkred-gateway.internal:3000/api/ai` (Fly's internal DNS, no public
exposure, no TLS needed).

---

## 5. Verification checklist (any platform)

```bash
BASE=https://<your-gateway-host>

# 1. liveness
curl -fsS $BASE/api/health | jq '.data.status, .data.pool'

# 2. readiness (503 until at least one key is usable)
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/ready

# 3. auth is enforced
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/ai \
  -H 'Content-Type: application/json' -d '{"prompt":"hi"}'          # → 401

# 4. inference works end-to-end
curl -fsS -X POST $BASE/api/ai -H 'Content-Type: application/json' \
  -H 'x-api-key: bot-internal-key' \
  -d '{"taskType":"code-generation","messages":[{"role":"user","content":"chunk a string in python"}]}' \
  | jq '.data.provider, .data.modelId, .data.content'

# 5. dashboard renders
curl -fsS $BASE/ | head -c 200
```

Then in Telegram: `/start` → choose a task → send a long prompt (paste a 10k-character
file) and confirm the answer arrives in several messages with no errors.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `bot` exits with `[FATAL] TELEGRAM_BOT_TOKEN is not set` | missing secret | set the env var, redeploy |
| Bot logs `gateway not ready after 180s` | wrong `GATEWAY_URL`, or gateway crashed | check the gateway logs; verify the URL/origin |
| `⛔ Gateway auth failure` in Telegram | `GATEWAY_API_KEY` not in `USERS_JSON` | make them match exactly |
| `⚠️ All providers saturated` | every free tier exhausted | add more keys (`GEMINI_KEY_P2/P3`), lower `MAX_ATTEMPTS` pressure, or wait for the daily reset |
| `⏳ Rate limited … retry in ~Ns` | per-caller tier ceiling | raise `INTERNAL_RPM`/`STANDARD_RPM` for your tier |
| Gateway `503 NO_PROVIDER_CREDENTIALS` | no provider keys at all | add a key, or set `DEMO_MOCK=true` to test |
| Telegram `message is too long` | should be impossible — `chunking.py` measures UTF-16 | open an issue with the payload; `CHUNK_SIZE` can be lowered to 3500 |
| Replies arrive without formatting | Telegram rejected the Markdown entities | automatic plain-text fallback is working as designed; set `PARSE_MODE=` empty to silence |
| History lost after restart | Redis volume missing (managed platforms) | point `REDIS_URL` at Upstash or attach a persistent volume |
| `docker compose config` fails on `env_file` | `.env` missing | `cp .env.example .env` (or run `./setup.sh`) |

Debug commands:

```bash
docker compose logs -f gateway | grep -E "penalised|attempt|fallback"
curl -s -H "x-admin-key: $ADMIN_KEY" localhost:3000/api/status | jq '.data.pool.providers'
docker compose exec redis redis-cli keys 'konkred:*'
docker compose exec bot python healthcheck.py
```

---

## 7. Security hardening before going public

1. Rotate `ADMIN_KEY` and every provider key; store them only in the platform's secret
   manager (never in git).
2. Set `ALLOWED_USER_IDS` so strangers cannot spend your quota.
3. Set `MOCK_FALLBACK=false` in production if you prefer a hard `503` over a simulated
   answer when all providers are exhausted.
4. Bind the gateway to localhost (`"127.0.0.1:3000:3000"`) or put it behind a reverse
   proxy with TLS; do not expose `/api/status` publicly (it needs `x-admin-key`).
5. Keep `DASHBOARD_ENABLED=true` only on trusted networks, or set it to `false`.
6. Review `.gitignore` — `.env` and `.env.*` are excluded, `.env.example` is not.
