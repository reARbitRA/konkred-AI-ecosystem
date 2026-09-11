#!/usr/bin/env bash
# =============================================================================
# Konkred AI Ecosystem — one-shot local/VPS setup.
#
#   ./setup.sh              # create .env, validate, build, start, verify
#   ./setup.sh --check      # validation only (no docker build/start)
#   ./setup.sh --mock       # start with DEMO_MOCK=true (no provider keys needed)
#   ./setup.sh --down       # stop and remove containers (keeps volumes)
#   ./setup.sh --logs       # tail all service logs
#
# Idempotent: safe to re-run after editing .env or pulling new code.
# =============================================================================
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info()  { printf '%s[setup]%s %s\n' "$BLUE" "$NC" "$*"; }
ok()    { printf '%s[ ok  ]%s %s\n' "$GREEN" "$NC" "$*"; }
warn()  { printf '%s[warn ]%s %s\n' "$YELLOW" "$NC" "$*"; }
fail()  { printf '%s[fail ]%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

MODE="up"
DEMO_MOCK_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --check)  MODE="check" ;;
    --mock)   DEMO_MOCK_OVERRIDE="true" ;;
    --down)   MODE="down" ;;
    --logs)   MODE="logs" ;;
    --rebuild) MODE="rebuild" ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) warn "ignoring unknown argument: $arg" ;;
  esac
done

# --------------------------------------------------------------------------- #
# Locate the compose command (v2 plugin, fallback to legacy binary)
# --------------------------------------------------------------------------- #
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "Neither 'docker compose' nor 'docker-compose' is available. Install Docker: https://docs.docker.com/engine/install/"
  fi
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker CLI not found. Install it first (see DEPLOYMENT.md §0)."
  docker info >/dev/null 2>&1 || fail "Cannot reach the Docker daemon. Is it running? Do you need sudo/userns permissions?"
}

# --------------------------------------------------------------------------- #
# .env bootstrap
# --------------------------------------------------------------------------- #
bootstrap_env() {
  if [[ ! -f .env ]]; then
    [[ -f .env.example ]] || fail ".env.example is missing from the repository root."
    cp .env.example .env
    chmod 600 .env
    ok "created .env from .env.example (permissions 600)"
    # Generate a random ADMIN_KEY so the dashboard/status endpoint is not left open.
    if command -v openssl >/dev/null 2>&1; then
      local secret
      secret="$(openssl rand -hex 32)"
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^ADMIN_KEY=.*|ADMIN_KEY=${secret}|" .env
      else
        sed -i "s|^ADMIN_KEY=.*|ADMIN_KEY=${secret}|" .env
      fi
      ok "generated a random ADMIN_KEY"
    else
      warn "openssl not found — set ADMIN_KEY manually before exposing the gateway"
    fi
    warn "edit .env now and add TELEGRAM_BOT_TOKEN + at least one provider key"
  else
    ok ".env already exists — leaving it untouched"
  fi

  if [[ -n "$DEMO_MOCK_OVERRIDE" ]]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^DEMO_MOCK=.*|DEMO_MOCK=${DEMO_MOCK_OVERRIDE}|" .env
    else
      sed -i "s|^DEMO_MOCK=.*|DEMO_MOCK=${DEMO_MOCK_OVERRIDE}|" .env
    fi
    ok "DEMO_MOCK=${DEMO_MOCK_OVERRIDE} (offline simulator mode)"
  fi
}

# --------------------------------------------------------------------------- #
# Static validation (no Docker needed for --check)
# --------------------------------------------------------------------------- #
validate_static() {
  info "validating repository structure"
  local required=(
    docker-compose.yml
    .env.example
    gateway/package.json
    gateway/Dockerfile
    gateway/data/policies.registry.json
    gateway/src/server.mjs
    bot/Dockerfile
    bot/requirements.txt
    bot/main.py
    bot/handlers.py
    bot/gateway_client.py
  )
  local missing=0
  for f in "${required[@]}"; do
    if [[ -e "$f" ]]; then
      ok "found $f"
    else
      warn "MISSING $f"; missing=$((missing + 1))
    fi
  done
  [[ "$missing" -eq 0 ]] || fail "$missing required file(s) missing"

  if command -v node >/dev/null 2>&1; then
    info "syntax-checking gateway ESM sources"
    local errs=0
    while IFS= read -r -d '' file; do
      if node --check "$file" >/dev/null 2>&1; then :; else
        warn "node --check failed: $file"; errs=$((errs + 1))
      fi
    done < <(find gateway/src -name '*.mjs' -print0)
    [[ "$errs" -eq 0 ]] || fail "$errs gateway module(s) failed syntax check"
    ok "all gateway modules parse"
  else
    warn "node not installed — skipping gateway syntax check"
  fi

  if command -v python3 >/dev/null 2>&1; then
    info "byte-compiling bot sources"
    python3 -m compileall -q bot >/dev/null || fail "python syntax errors in bot/"
    ok "all bot modules compile"
  else
    warn "python3 not installed — skipping bot compile check"
  fi

  if command -v jq >/dev/null 2>&1; then
    info "validating JSON documents"
    jq empty gateway/data/policies.registry.json || fail "policies.registry.json is not valid JSON"
    jq empty gateway/package.json || fail "gateway/package.json is not valid JSON"
    ok "JSON documents valid"
  fi

  if [[ -f .env ]]; then
    info "checking .env sanity"
    # USERS_JSON must parse as JSON — a stray quote here silently breaks auth.
    local users_json
    users_json="$(grep -E '^USERS_JSON=' .env | head -n1 | cut -d= -f2- || true)"
    if [[ -n "$users_json" ]] && command -v jq >/dev/null 2>&1; then
      echo "$users_json" | jq empty >/dev/null 2>&1 || fail "USERS_JSON in .env is not valid JSON"
      ok "USERS_JSON parses"
    fi
    if ! grep -qE '^TELEGRAM_BOT_TOKEN=.+' .env; then
      warn "TELEGRAM_BOT_TOKEN is empty — the bot container will exit(2) until it is set"
    else
      ok "TELEGRAM_BOT_TOKEN is set"
    fi
  fi
}

validate_compose() {
  info "validating docker-compose.yml"
  compose config --quiet || fail "'docker compose config' rejected the compose file"
  ok "compose file parses and resolves"
}

check_env_ports() {
  local port
  port="$(grep -E '^GATEWAY_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)"
  port="${port:-3000}"
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${port} "; then
    warn "port ${port} is already in use on this host — set GATEWAY_PORT in .env to something else"
  fi
}

# --------------------------------------------------------------------------- #
# Modes
# --------------------------------------------------------------------------- #
if [[ "$MODE" == "down" ]]; then
  require_docker
  compose down
  ok "containers stopped (volume redis-data preserved; use 'docker volume rm' to wipe)"
  exit 0
fi

if [[ "$MODE" == "logs" ]]; then
  require_docker
  compose logs -f --tail=100
  exit 0
fi

bootstrap_env
validate_static

if [[ "$MODE" == "check" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    validate_compose
  else
    warn "docker unavailable — skipped 'compose config' validation"
  fi
  ok "static validation complete"
  exit 0
fi

require_docker
validate_compose
check_env_ports

info "building images"
compose build --pull

info "starting stack"
compose up -d

info "waiting for healthchecks (up to 90s)"
deadline=$((SECONDS + 90))
healthy=0
while (( SECONDS < deadline )); do
  status="$(compose ps --format '{{.Service}}={{.Health}}' 2>/dev/null || true)"
  if echo "$status" | grep -q 'gateway=healthy' && echo "$status" | grep -q 'redis=healthy'; then
    healthy=1
    break
  fi
  sleep 3
done

compose ps
if (( healthy )); then
  ok "gateway + redis report healthy"
else
  warn "healthchecks did not converge in 90s — inspect with: ./setup.sh --logs"
fi

GATEWAY_PORT_VALUE="$(grep -E '^GATEWAY_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)"
GATEWAY_PORT_VALUE="${GATEWAY_PORT_VALUE:-3000}"
info "smoke-testing http://127.0.0.1:${GATEWAY_PORT_VALUE}/api/health"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 10 "http://127.0.0.1:${GATEWAY_PORT_VALUE}/api/health" >/dev/null; then
    ok "gateway /api/health responded 200"
  else
    warn "gateway /api/health did not respond — check 'docker compose logs gateway'"
  fi
fi

cat <<'BANNER'

──────────────────────────────────────────────────────────────────────────────
 Konkred AI Ecosystem is up.

   Dashboard  http://127.0.0.1:3000/
   Health     http://127.0.0.1:3000/api/health
   Logs       ./setup.sh --logs
   Stop       ./setup.sh --down

 Next: open Telegram, message your bot, send /start, pick a task, ask a question.
──────────────────────────────────────────────────────────────────────────────
BANNER
