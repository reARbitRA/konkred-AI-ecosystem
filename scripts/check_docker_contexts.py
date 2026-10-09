#!/usr/bin/env python3
"""Static check: every COPY source must resolve from the Dockerfile's build context.

Docker (and Fly / Koyeb remote builders) only see files inside the build context,
and `.dockerignore` removes files from it. A COPY that points outside the context,
at a file that does not exist, or at a file the context ignores, only fails at
build time on a remote builder. This script catches it locally with no daemon.

For each Dockerfile it checks:
  * every COPY source (skipping `COPY --from=` stages) exists under the context,
  * no matched source is excluded by the context's `.dockerignore`,
  * the Dockerfile itself is not excluded (Fly requires it inside the context).

It also checks that:
  * fly.*.toml `[build] dockerfile` points at an existing Dockerfile at the repo root,
  * every Dockerfile / fly config path mentioned in DEPLOYMENT.md exists.

Usage:  python3 scripts/check_docker_contexts.py [repo_root]
Exit 1 on any problem.
"""
from __future__ import annotations

import glob
import json
import posixpath
import re
import shlex
import sys
from pathlib import Path
from typing import List, Tuple

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - older interpreters
    tomllib = None

# (Dockerfile, build context directory, must the Dockerfile stay inside its context?)
# Remote builders (Fly, Koyeb) need the Dockerfile inside the context, so the root
# Dockerfiles are strict. The per-service Dockerfiles are built locally by compose /
# Render, where their own .dockerignore excluding the Dockerfile is harmless.
DOCKERFILES: List[Tuple[str, str, bool]] = [
    ("Dockerfile.gateway", ".", True),   # Fly + Koyeb: repo-root context
    ("Dockerfile.bot", ".", True),       # Fly + Koyeb: repo-root context
    ("gateway/Dockerfile", "gateway", False),  # docker-compose / Render
    ("bot/Dockerfile", "bot", False),
]

# fly config -> the Dockerfile it must build (repo-root context).
FLY_CONFIGS = {"fly.gateway.toml": "Dockerfile.gateway", "fly.bot.toml": "Dockerfile.bot"}

# Paths that DEPLOYMENT.md may mention and that must exist.
DOC_PATH_RE = re.compile(r"(?<![\w/.-])((?:gateway/|bot/)Dockerfile|Dockerfile\.[a-z]+|fly\.[a-z]+\.toml)(?![\w.-])")

problems: List[str] = []


def fail(msg: str) -> None:
    problems.append(msg)
    print(f"  FAIL {msg}")


def ok(msg: str) -> None:
    print(f"  ok   {msg}")


# --------------------------------------------------------------------------- #
# .dockerignore (simplified Docker semantics: last matching rule wins; a rule
# also matches everything beneath a matching directory)
# --------------------------------------------------------------------------- #
def load_dockerignore(ctx: Path) -> List[Tuple[bool, str]]:
    rules: List[Tuple[bool, str]] = []
    f = ctx / ".dockerignore"
    if not f.exists():
        return rules
    for raw in f.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        pattern = line[1:] if negate else line
        pattern = posixpath.normpath(pattern.strip().lstrip("/"))
        rules.append((negate, pattern))
    return rules


def _pattern_to_regex(pattern: str) -> re.Pattern:
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def is_ignored(rel: str, rules: List[Tuple[bool, str]]) -> bool:
    rel = posixpath.normpath(rel)
    parts = rel.split("/")
    candidates = ["/".join(parts[: i + 1]) for i in range(len(parts))]
    ignored = False
    for negate, pattern in rules:
        rx = _pattern_to_regex(pattern)
        if any(rx.match(c) for c in candidates):
            ignored = not negate
    return ignored


# --------------------------------------------------------------------------- #
# Dockerfile COPY parsing
# --------------------------------------------------------------------------- #
def copy_instructions(dockerfile: Path) -> List[Tuple[int, List[str]]]:
    """Return (line_no, sources) for each COPY that comes from the build context."""
    logical: List[Tuple[int, str]] = []
    buf, start = "", 0
    for no, raw in enumerate(dockerfile.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.rstrip()
        if not buf:
            start = no
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        buf += line
        logical.append((start, buf.strip()))
        buf = ""

    result: List[Tuple[int, List[str]]] = []
    for no, text in logical:
        if not text or text.startswith("#"):
            continue
        keyword, _, rest = text.partition(" ")
        if keyword.upper() != "COPY":
            continue
        rest = rest.strip()
        if "--from=" in rest:
            continue  # copy from another build stage, not from the context
        rest = " ".join(t for t in rest.split() if not t.startswith("--"))
        if rest.startswith("["):
            tokens = json.loads(rest)
        else:
            tokens = shlex.split(rest)
        if len(tokens) < 2:
            fail(f"{dockerfile}:{no}: COPY needs at least one source and a destination")
            continue
        result.append((no, tokens[:-1]))
    return result


def check_dockerfile(root: Path, dockerfile: str, context: str, strict_in_context: bool) -> None:
    df = root / dockerfile
    ctx = root / context
    print(f"\n▶ {dockerfile}  (build context: {context}/)")
    if not df.is_file():
        fail(f"{dockerfile} does not exist")
        return
    if not ctx.is_dir():
        fail(f"{dockerfile}: build context directory {context}/ does not exist")
        return
    rules = load_dockerignore(ctx)

    df_rel = posixpath.relpath(df.relative_to(ctx).as_posix(), ".") if df.is_relative_to(ctx) else None
    if df_rel is None:
        fail(f"{dockerfile} is outside its build context {context}/")
    elif strict_in_context and is_ignored(df_rel, rules):
        fail(f"{dockerfile} is excluded by {context}/.dockerignore (Fly/BuildKit need the Dockerfile in context)")

    copies = copy_instructions(df)
    if not copies:
        fail(f"{dockerfile}: no COPY instructions found")
    for line_no, sources in copies:
        for src in sources:
            if "$" in src:
                fail(f"{dockerfile}:{line_no}: COPY source uses a build variable ({src}); cannot verify statically")
                continue
            if src.startswith("/") or src.startswith(".."):
                fail(f"{dockerfile}:{line_no}: COPY source '{src}' escapes the build context")
                continue
            matches = sorted(glob.glob(str(ctx / src), recursive=True))
            if not matches:
                fail(f"{dockerfile}:{line_no}: COPY '{src}' matches nothing under {context}/")
                continue
            usable, excluded = [], []
            for m in matches:
                rel = Path(m).relative_to(ctx).as_posix()
                if Path(m).is_dir():
                    files = [p for p in Path(m).rglob("*") if p.is_file()]
                    kept = [p for p in files if not is_ignored(p.relative_to(ctx).as_posix(), rules)]
                    if kept:
                        usable.append(rel)
                    elif files:
                        excluded.append(rel)
                elif not is_ignored(rel, rules):
                    usable.append(rel)
                else:
                    excluded.append(rel)
            if not usable:
                fail(f"{dockerfile}:{line_no}: COPY '{src}' is excluded by {context}/.dockerignore")
            elif excluded:
                fail(f"{dockerfile}:{line_no}: COPY '{src}' partly excluded by {context}/.dockerignore: {', '.join(excluded)}")
            else:
                ok(f"{dockerfile}:{line_no}: COPY {src} -> {len(usable)} path(s) in {context}/")


def check_fly(root: Path) -> None:
    print("\n▶ fly configs")
    if tomllib is None:
        fail("tomllib unavailable (need Python 3.11+) to parse fly.*.toml")
        return
    for cfg, dockerfile in FLY_CONFIGS.items():
        path = root / cfg
        if not path.is_file():
            fail(f"{cfg} missing")
            continue
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        build = (data.get("build") or {}).get("dockerfile")
        if build != dockerfile:
            fail(f"{cfg}: [build] dockerfile is {build!r}, expected {dockerfile!r}")
        elif not (root / build).is_file():
            fail(f"{cfg}: [build] dockerfile {build} does not exist (relative to repo root)")
        else:
            ok(f"{cfg}: app={data.get('app')!r} builds {build} from the repo-root context")
        if not data.get("app"):
            fail(f"{cfg}: missing app name")


def check_docs(root: Path) -> None:
    doc = root / "DEPLOYMENT.md"
    print("\n▶ DEPLOYMENT.md path references")
    if not doc.is_file():
        fail("DEPLOYMENT.md missing")
        return
    refs = sorted(set(DOC_PATH_RE.findall(doc.read_text(encoding="utf-8"))))
    missing = [r for r in refs if not (root / r).exists()]
    for r in missing:
        fail(f"DEPLOYMENT.md references {r}, which does not exist")
    if not missing:
        ok(f"{len(refs)} referenced Dockerfile/fly path(s) exist")


def main(argv: List[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else Path(__file__).resolve().parent.parent
    print(f"Docker build-context check — repo: {root}")
    for dockerfile, context, strict in DOCKERFILES:
        check_dockerfile(root, dockerfile, context, strict)
    check_fly(root)
    check_docs(root)
    print()
    if problems:
        print(f"{len(problems)} problem(s) found")
        return 1
    print("all COPY sources resolve from their build contexts")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
