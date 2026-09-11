#!/usr/bin/env bash
# =============================================================================
# Install the CI/CD pipeline into .github/workflows/.
#
# The canonical source is `ci/deploy.yml`. GitHub Actions only executes workflow
# files from `.github/workflows/`, and writing to that path requires a token with
# the `workflows` scope — which automated agents and many fine-grained PATs do not
# have. This script performs the copy locally so a human (or a token with the
# right scope) can commit it.
#
#   ./scripts/install-workflow.sh            # copy, then show the git commands
#   ./scripts/install-workflow.sh --commit   # copy + commit on the current branch
# =============================================================================
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SOURCE="ci/deploy.yml"
TARGET_DIR=".github/workflows"
TARGET="${TARGET_DIR}/deploy.yml"

GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'

[[ -f "$SOURCE" ]] || { printf '%s[fail]%s %s is missing\n' "$RED" "$NC" "$SOURCE" >&2; exit 1; }

if [[ -f "$TARGET" ]] && cmp -s "$SOURCE" "$TARGET"; then
  printf '%s[ ok ]%s %s is already installed and identical to %s\n' "$GREEN" "$NC" "$TARGET" "$SOURCE"
  exit 0
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE" "$TARGET"
printf '%s[ ok ]%s installed %s from %s\n' "$GREEN" "$NC" "$TARGET" "$SOURCE"

# Sanity check the copy parses as YAML when PyYAML is available.
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY' || printf '%s[warn]%s could not validate YAML (install pyyaml to check)\n' "$YELLOW" "$NC"
import pathlib, sys
try:
    import yaml
except ImportError:
    sys.exit(1)
doc = yaml.safe_load(pathlib.Path(".github/workflows/deploy.yml").read_text())
jobs = list(doc.get("jobs", {}))
assert jobs, "no jobs found"
print(f"       workflow '{doc.get('name')}' parses — jobs: {', '.join(jobs)}")
PY
fi

if [[ "${1:-}" == "--commit" ]]; then
  git add "$TARGET"
  git commit -m "ci: install GitHub Actions pipeline (.github/workflows/deploy.yml)"
  printf '%s[ ok ]%s committed\n' "$GREEN" "$NC"
  printf '       push with: git push origin "$(git rev-parse --abbrev-ref HEAD)"\n'
  printf '%s[note]%s if the push is rejected with "refusing to allow a GitHub App to\n' "$YELLOW" "$NC"
  printf '       create or update workflow", your token needs the "workflows" scope:\n'
  printf '       use a classic PAT with repo+workflow, or push from your own machine.\n'
else
  cat <<EOF

Next steps:
  git add ${TARGET}
  git commit -m "ci: enable GitHub Actions pipeline"
  git push origin "\$(git rev-parse --abbrev-ref HEAD)"

If the push is rejected with:
  "refusing to allow a GitHub App to create or update workflow ..."
then the credentials in use lack the \`workflows\` scope. Push with a classic PAT
(scope: repo + workflow) or from your own git credentials — the file content itself
is valid and identical to ${SOURCE}.
EOF
fi
