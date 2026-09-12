#!/usr/bin/env bash
# =============================================================================
# Konkred AI Ecosystem — full local verification suite.
#
#   ./scripts/verify.sh            # run everything that the environment allows
#   ./scripts/verify.sh --fast     # skip the docker build + integration test
#   ./scripts/verify.sh --strict   # any warning becomes a failure
#
# The same script is executed by .github/workflows/deploy.yml, so a green run
# here means a green CI run. Steps that need tools you do not have installed
# (docker, pyyaml, bot requirements) are reported as SKIP, not FAIL.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

FAST=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --strict) STRICT=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
  esac
done

PASS=0; FAIL=0; SKIP=0; WARN=0
FAILED_STEPS=()

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'

step() { printf '\n%s▶ %s%s\n' "$BLUE" "$*" "$NC"; }
ok()   { printf '%s  PASS%s %s\n' "$GREEN" "$NC" "$*"; PASS=$((PASS+1)); }
bad()  { printf '%s  FAIL%s %s\n' "$RED" "$NC" "$*"; FAIL=$((FAIL+1)); FAILED_STEPS+=("$*"); }
skip() { printf '%s  SKIP%s %s\n' "$YELLOW" "$NC" "$*"; SKIP=$((SKIP+1)); }
warn() { printf '%s  WARN%s %s\n' "$YELLOW" "$NC" "$*"; WARN=$((WARN+1)); }

# Interpreter selection: prefer a project venv when present (it has bot deps).
PY=python3
if [[ -x ".venv-bot/bin/python" ]]; then PY=".venv-bot/bin/python"; fi
if [[ -n "${PYTHON:-}" ]]; then PY="$PYTHON"; fi

run() { # run <label> <cmd...>
  local label="$1"; shift
  step "$label"
  if "$@"; then ok "$label"; else bad "$label"; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

echo "═══════════════════════════════════════════════════════════════════════════"
echo " Konkred AI Ecosystem — verification suite"
echo " repo: $REPO_ROOT"
echo " node: $(have node && node --version || echo 'not installed')   python: $($PY --version 2>&1)   docker: $(have docker && docker --version | cut -d' ' -f3 || echo 'not installed')"
echo "═══════════════════════════════════════════════════════════════════════════"

# --------------------------------------------------------------------------- #
step "1. Repository structure"
required=(docker-compose.yml .env.example .gitignore setup.sh render.yaml
          ci/deploy.yml
          gateway/Dockerfile gateway/package.json gateway/data/policies.registry.json gateway/src/server.mjs
          bot/Dockerfile bot/requirements.txt bot/main.py bot/handlers.py bot/gateway_client.py bot/chunking.py bot/history.py bot/healthcheck.py)
missing=0
for f in "${required[@]}"; do [[ -e "$f" ]] || { warn "missing $f"; missing=$((missing+1)); }; done
if [[ $missing -eq 0 ]]; then ok "all ${#required[@]} required files present"; else bad "$missing required file(s) missing"; fi
if [[ -x setup.sh ]]; then ok "setup.sh is executable"; else bad "setup.sh is not executable (chmod +x setup.sh)"; fi

# --------------------------------------------------------------------------- #
step "2. Gateway ESM syntax (node --check on every module)"
if have node; then
  errs=0; count=0
  while IFS= read -r -d '' f; do
    count=$((count+1))
    node --check "$f" >/dev/null 2>&1 || { bad "node --check $f"; errs=$((errs+1)); }
  done < <(find gateway/src gateway/scripts gateway/tests -name '*.mjs' -print0)
  [[ $errs -eq 0 ]] && ok "$count ESM modules parse"
else
  skip "node not installed"
fi

# --------------------------------------------------------------------------- #
step "3. Gateway integrity (import graph + registry + invariants)"
if have node; then
  if node gateway/scripts/check.mjs; then ok "gateway integrity check"; else bad "gateway integrity check"; fi
else
  skip "node not installed"
fi

# --------------------------------------------------------------------------- #
step "4. Gateway unit/integration tests (node --test)"
if have node; then
  if (cd gateway && node --test tests/*.test.mjs > /tmp/konkred-node-tests.log 2>&1); then
    ok "gateway tests: $(grep -E '^# (tests|pass)' /tmp/konkred-node-tests.log | tr '\n' ' ')"
  else
    bad "gateway tests failed (see /tmp/konkred-node-tests.log)"; tail -30 /tmp/konkred-node-tests.log
  fi
else
  skip "node not installed"
fi

# --------------------------------------------------------------------------- #
step "5. Bot byte-compilation"
if $PY -m compileall -q bot >/dev/null 2>&1; then ok "bot modules compile"; else bad "bot modules failed to compile"; fi

# --------------------------------------------------------------------------- #
step "6. Bot import safety (no stdlib/package shadowing)"
if $PY -c "import aiogram, httpx, redis" >/dev/null 2>&1; then
  if $PY scripts/check_python_imports.py; then ok "import audit clean"; else bad "import audit found problems"; fi
else
  skip "bot requirements not installed in $PY (pip install -r bot/requirements.txt)"
fi

# --------------------------------------------------------------------------- #
step "7. Bot unit tests (unittest)"
if $PY -c "import aiogram, httpx, redis" >/dev/null 2>&1; then
  if (cd bot && PYTHONPATH=tests:. "$PY" -m unittest discover -s tests -p 'test_*.py' -t . > /tmp/konkred-bot-tests.log 2>&1); then    ok "bot tests: $(tail -3 /tmp/konkred-bot-tests.log | tr '\n' ' ')"
  else
    bad "bot tests failed (see /tmp/konkred-bot-tests.log)"; tail -40 /tmp/konkred-bot-tests.log
  fi
else
  skip "bot requirements not installed"
fi

# --------------------------------------------------------------------------- #
run "8. .env.example ↔ code agreement" $PY scripts/validate_env.py

# --------------------------------------------------------------------------- #
step "9. docker-compose.yml"
if $PY -c "import yaml" >/dev/null 2>&1; then
  if $PY scripts/validate_compose.py; then ok "compose topology validated"; else bad "compose topology invalid"; fi
else
  skip "PyYAML not installed in $PY"
fi
if have docker && docker info >/dev/null 2>&1; then
  [[ -f .env ]] || cp .env.example .env
  if docker compose config --quiet; then ok "'docker compose config' resolves"; else bad "'docker compose config' rejected the file"; fi
else
  skip "docker daemon unavailable — 'docker compose config' not run"
fi

# --------------------------------------------------------------------------- #
step "10. YAML documents (render.yaml, workflow)"
if $PY -c "import yaml" >/dev/null 2>&1; then
  if $PY - <<'PY'
import sys, yaml, pathlib
bad = 0
workflow = ".github/workflows/deploy.yml" if pathlib.Path(".github/workflows/deploy.yml").exists() else "ci/deploy.yml"
if workflow == "ci/deploy.yml":
    print("  ⚠ CI workflow is not installed yet — run ./scripts/install-workflow.sh")
for p in ["render.yaml", workflow, "docker-compose.yml"]:
    path = pathlib.Path(p)
    try:
        yaml.safe_load(path.read_text())
        print(f"  ✓ {p} parses")
    except Exception as exc:
        print(f"  ✗ {p}: {exc}")
        bad += 1
sys.exit(1 if bad else 0)
PY
  then ok "YAML documents parse"; else bad "a YAML document is invalid"; fi
  # Blueprint sanity: services exist and point at the right Dockerfiles.
  $PY - <<'PY' || bad "render.yaml blueprint sanity"
import yaml, pathlib, sys
doc = yaml.safe_load(pathlib.Path("render.yaml").read_text())
services = {s["name"]: s for s in doc.get("services", [])}
assert "konkred-gateway" in services, "gateway service missing from blueprint"
assert "konkred-bot" in services, "bot service missing from blueprint"
assert services["konkred-gateway"]["dockerfilePath"].endswith("gateway/Dockerfile")
assert services["konkred-gateway"]["healthCheckPath"] == "/api/health"
assert services["konkred-bot"]["type"] == "worker", "bot must be a background worker (no inbound ports)"
for name, svc in services.items():
    ctx = pathlib.Path(svc["dockerContext"])
    assert ctx.is_dir(), f"{name}: dockerContext {ctx} missing"
    assert pathlib.Path(svc["dockerfilePath"]).exists(), f"{name}: dockerfilePath missing"
print("  ✓ blueprint services, contexts and healthcheck path verified")
PY
else
  skip "PyYAML not installed"
fi

# --------------------------------------------------------------------------- #
step "11. Shell scripts (bash -n / shellcheck)"
shells=(setup.sh scripts/verify.sh)
errs=0
for s in "${shells[@]}"; do
  [[ -f "$s" ]] || continue
  bash -n "$s" || { bad "bash -n $s"; errs=$((errs+1)); }
done
[[ $errs -eq 0 ]] && ok "shell scripts parse"
if have shellcheck; then
  if shellcheck -S warning "${shells[@]}"; then ok "shellcheck clean"; else warn "shellcheck reported findings"; fi
else
  skip "shellcheck not installed"
fi

# --------------------------------------------------------------------------- #
step "12. setup.sh --check (static bootstrap path)"
if bash setup.sh --check >/tmp/konkred-setup-check.log 2>&1; then
  ok "setup.sh --check completed"
else
  bad "setup.sh --check failed"; tail -20 /tmp/konkred-setup-check.log
fi

# --------------------------------------------------------------------------- #
step "13. Gateway HTTP smoke test (offline simulator)"
if have node; then
  if (cd gateway && node scripts/smoke.mjs > /tmp/konkred-smoke.log 2>&1); then
    ok "smoke: $(grep -E 'smoke checks passed' /tmp/konkred-smoke.log | tail -1)"
  else
    bad "gateway smoke test failed"; tail -30 /tmp/konkred-smoke.log
  fi
else
  skip "node not installed"
fi

# --------------------------------------------------------------------------- #
step "14. Bot ↔ gateway integration (real HTTP, mock provider)"
if [[ $FAST -eq 1 ]]; then
  skip "--fast mode"
elif $PY -c "import httpx" >/dev/null 2>&1 && have node; then
  if $PY scripts/integration_bot_gateway.py > /tmp/konkred-integration.log 2>&1; then
    ok "integration: $(grep -E 'integration checks passed' /tmp/konkred-integration.log | tail -1)"
  else
    bad "bot↔gateway integration failed"; tail -40 /tmp/konkred-integration.log
  fi
else
  skip "needs node + httpx"
fi

# --------------------------------------------------------------------------- #
step "15. Docker image builds"
if [[ $FAST -eq 1 ]]; then
  skip "--fast mode"
elif have docker && docker info >/dev/null 2>&1; then
  if docker build -q -t konkred-gateway:verify ./gateway >/dev/null 2>&1; then ok "gateway image builds"; else bad "gateway image build failed"; fi
  if docker build -q -t konkred-bot:verify ./bot >/dev/null 2>&1; then ok "bot image builds"; else bad "bot image build failed"; fi
else
  skip "docker daemon unavailable"
fi

# --------------------------------------------------------------------------- #
echo
echo "═══════════════════════════════════════════════════════════════════════════"
printf ' %sPASS %d%s   %sFAIL %d%s   %sSKIP %d%s   %sWARN %d%s\n' "$GREEN" "$PASS" "$NC" "$RED" "$FAIL" "$NC" "$YELLOW" "$SKIP" "$NC" "$YELLOW" "$WARN" "$NC"
if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
  printf ' %sFailed steps:%s\n' "$RED" "$NC"
  for s in "${FAILED_STEPS[@]}"; do printf '   - %s\n' "$s"; done
fi
echo "═══════════════════════════════════════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then exit 1; fi
if [[ $STRICT -eq 1 && $WARN -gt 0 ]]; then exit 1; fi
exit 0
