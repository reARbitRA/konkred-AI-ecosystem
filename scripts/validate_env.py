#!/usr/bin/env python3
"""Cross-check `.env.example` against every variable the code actually reads.

Guards against the two classic template rot modes:
  * a variable the code needs is missing from `.env.example`  (broken onboarding)
  * a variable documented in `.env.example` is dead           (confusing ops)

Usage:
    python3 scripts/validate_env.py [--strict]

Exit code 1 on a missing required variable (or, with --strict, on dead entries).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Dict, Set

ROOT = Path(__file__).resolve().parent.parent

SOURCES: Dict[str, list] = {
    "gateway": ["gateway/src", "gateway/scripts", "gateway/Dockerfile"],
    "bot": ["bot"],
    # NOTE: .github/workflows is deliberately excluded — its variables are CI
    # runtime context (GITHUB_SHA, GITHUB_OUTPUT, job-local HOOK/URL), not
    # application configuration, and would create permanent false positives.
    "root": ["docker-compose.yml", "setup.sh", "render.yaml"],
}

# Variables consumed by tooling/runtime but not worth documenting per-service.
OPTIONAL_UNDOCUMENTED: Set[str] = {
    "NODE_ENV",
    "PORT",
    "HOST",
    "PATH",
    "HOME",
    "PYTHONUNBUFFERED",
    "PYTHONDONTWRITEBYTECODE",
    "PIP_NO_CACHE_DIR",
    "PIP_DISABLE_PIP_VERSION_CHECK",
    "KONKRED_BOT_MODULE",
    "OSTYPE",
    "GITHUB_TOKEN",  # also used by CI tooling
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "RENDER_EXTERNAL_URL",
    "SHELL",
    "CI",
    # setup.sh internals (shell locals, not environment configuration)
    "DEMO_MOCK_OVERRIDE",
    "GATEWAY_PORT_VALUE",
    "OPENROUTER_REFERER",
    "OPENROUTER_TITLE",
}

# Populated by setup.sh with a random secret; a blank template value is correct.
REQUIRED_NON_EMPTY_IN_TEMPLATE: Set[str] = set()

# Extension-aware patterns: shell locals ($MODE, $RED) must not be mistaken for
# environment configuration, while compose/render interpolation must be caught.
JS_PATTERNS = [
    re.compile(r"process\.env\.([A-Z][A-Z0-9_]+)"),
    re.compile(r"process\.env\[[\"']([A-Z][A-Z0-9_]+)[\"']\]"),
    re.compile(r"\b(?:int|bool|trimmed|raw|toList)\(\s*[\"']([A-Z][A-Z0-9_]+)[\"']"),
]
PY_PATTERNS = [
    re.compile(r"os\.getenv\(\s*[\"']([A-Z][A-Z0-9_]+)[\"']"),
    re.compile(r"os\.environ(?:\.get)?\(?[\"']([A-Z][A-Z0-9_]+)[\"']"),
    re.compile(r"\b_get(?:_int|_float|_bool|_list)?\(\s*[\"']([A-Z][A-Z0-9_]+)[\"']"),
]
YAML_PATTERNS = [
    re.compile(r"\$\{([A-Z][A-Z0-9_]+)(?::-[^}]*)?\}"),
    re.compile(r"\$([A-Z][A-Z0-9_]+)"),
    re.compile(r"^\s*-?\s*key:\s*([A-Z][A-Z0-9_]+)\s*$", re.MULTILINE),
    re.compile(r"^\s{4,}([A-Z][A-Z0-9_]+):", re.MULTILINE),
]
SH_PATTERNS = [
    re.compile(r"\$\{([A-Z][A-Z0-9_]+)(?::-[^}]*)?\}"),
    re.compile(r"^\s*export\s+([A-Z][A-Z0-9_]+)=", re.MULTILINE),
    re.compile(r"grep -q?E? ?\'?\^([A-Z][A-Z0-9_]+)="),
]
DOCKERFILE_PATTERNS = [
    re.compile(r"^\s*(?:ENV|ARG)\s+([A-Z][A-Z0-9_]+)", re.MULTILINE),
    re.compile(r"process\.env\.([A-Z][A-Z0-9_]+)"),
    re.compile(r"\$\{?([A-Z][A-Z0-9_]+)\}?"),
]

PATTERNS_BY_SUFFIX = {
    ".mjs": JS_PATTERNS,
    ".js": JS_PATTERNS,
    ".py": PY_PATTERNS,
    ".yml": YAML_PATTERNS,
    ".yaml": YAML_PATTERNS,
    ".sh": SH_PATTERNS,
}

SKIP_FILES = {Path(__file__).name, "validate_env.py"}


def scan(root: Path, rel_paths: list) -> Set[str]:
    found: Set[str] = set()
    for rel in rel_paths:
        target = root / rel
        files: list[Path] = []
        if target.is_file():
            files = [target]
        elif target.is_dir():
            files = [p for p in target.rglob("*") if p.is_file() and p.suffix in {".py", ".mjs", ".js", ".yml", ".yaml", ".sh", ""} and ".venv" not in p.parts and "__pycache__" not in p.parts]
        for path in files:
            if path.name in SKIP_FILES:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            patterns = PATTERNS_BY_SUFFIX.get(path.suffix, DOCKERFILE_PATTERNS if path.name == "Dockerfile" else [])
            for pattern in patterns:
                for match in pattern.finditer(text):
                    name = match.group(1)
                    if name and re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", name):
                        found.add(name)
    return found


def parse_template(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="also fail on template entries nothing reads")
    args = parser.parse_args()

    template = parse_template(ROOT / ".env.example")
    if not template:
        print("FAIL: .env.example is missing or empty")
        return 1

    referenced: Set[str] = set()
    for paths in SOURCES.values():
        referenced |= scan(ROOT, paths)

    # Compose interpolations like ${GATEWAY_PORT:-3000} count as references.
    missing = sorted(n for n in referenced if n not in template and n not in OPTIONAL_UNDOCUMENTED)
    dead = sorted(n for n in template if n not in referenced and n not in OPTIONAL_UNDOCUMENTED)

    print(f"[env] .env.example defines {len(template)} variables")
    print(f"[env] code/compose/blueprint reference {len(referenced)} variables")

    problems = 0
    for name in missing:
        print(f"  ✗ MISSING from .env.example but read by code: {name}")
        problems += 1
    for name in dead:
        marker = "⚠ not referenced by any code path (documentation-only?)"
        print(f"  {marker}: {name}")
        if args.strict:
            problems += 1

    # Values that must never ship with a placeholder.
    for name in REQUIRED_NON_EMPTY_IN_TEMPLATE:
        if not template.get(name):
            print(f"  ✗ {name} must have a value in .env.example")
            problems += 1

    if problems:
        print(f"[env] FAILED with {problems} problem(s)")
        return 1
    print("[env] OK — template and code agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
