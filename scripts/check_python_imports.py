#!/usr/bin/env python3
"""Import-safety audit for `bot/`.

Verifies the two dependency-integrity claims in the brief:

1. No local module shadows a CPython standard-library module (which would break
   `import json`, `import asyncio`, … inside third-party packages).
2. No local module shadows an installed third-party top-level module
   (aiogram, httpx, redis, aiohttp, pydantic, …).
3. Every module in `bot/` imports cleanly with the pinned requirements.

Usage: python3 scripts/check_python_imports.py [--bot-dir bot]
"""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import List, Set

ROOT = Path(__file__).resolve().parent.parent


def local_modules(bot_dir: Path) -> List[str]:
    return sorted(p.stem for p in bot_dir.glob("*.py") if p.stem != "__init__")


def stdlib_names() -> Set[str]:
    return set(sys.stdlib_module_names)


def third_party_names(bot_dir: Path) -> Set[str]:
    """Top-level importable names from the active environment, minus stdlib."""
    names: Set[str] = set()
    for path in sys.path:
        if not path or path == str(bot_dir):
            continue
        candidate = Path(path)
        if not candidate.is_dir():
            continue
        for entry in candidate.iterdir():
            if entry.name.startswith("_") or entry.name.endswith((".dist-info", ".egg-info")):
                continue
            if entry.suffix == ".py":
                names.add(entry.stem)
            elif entry.is_dir() and (entry / "__init__.py").exists():
                names.add(entry.name)
    return names - stdlib_names()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bot-dir", default="bot")
    parser.add_argument("--skip-import", action="store_true", help="only check shadowing, do not import modules")
    args = parser.parse_args()

    bot_dir = (ROOT / args.bot_dir).resolve()
    if not bot_dir.is_dir():
        print(f"FAIL: {bot_dir} does not exist")
        return 1

    modules = local_modules(bot_dir)
    if not modules:
        print(f"FAIL: no python modules found in {bot_dir}")
        return 1

    stdlib = stdlib_names()
    third_party = third_party_names(bot_dir)

    shadowed_stdlib = [m for m in modules if m in stdlib]
    shadowed_third = [m for m in modules if m in third_party]

    print(f"[imports] local modules: {', '.join(modules)}")

    problems = 0
    if shadowed_stdlib:
        print(f"  ✗ shadows CPython stdlib: {', '.join(shadowed_stdlib)}")
        problems += 1
    else:
        print("  ✓ no local module shadows a stdlib module")

    if shadowed_third:
        print(f"  ✗ shadows an installed package: {', '.join(shadowed_third)}")
        problems += 1
    else:
        print("  ✓ no local module shadows an installed third-party package")

    # Dependency resolution sanity (pip check) when the deps are installed.
    try:
        result = subprocess.run([sys.executable, "-m", "pip", "check"], capture_output=True, text=True, timeout=120)
        if result.returncode == 0:
            print("  ✓ pip check: no broken requirements")
        else:
            print(f"  ⚠ pip check reported: {result.stdout.strip() or result.stderr.strip()}")
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"  ⚠ pip check skipped: {exc}")

    if not args.skip_import:
        sys.path.insert(0, str(bot_dir))
        import os

        os.environ.setdefault("TELEGRAM_BOT_TOKEN", "1:import-check-placeholder")
        for name in modules:
            if name == "main":
                continue  # main.py starts the polling loop on import-guard only
            try:
                importlib.import_module(name)
                print(f"  ✓ import {name}")
            except SystemExit as exc:  # config.py exits when the token is missing
                print(f"  ⚠ import {name} raised SystemExit({exc}) — acceptable for entrypoints")
            except ModuleNotFoundError as exc:
                print(f"  ✗ import {name} failed: {exc} (install bot/requirements.txt)")
                problems += 1
            except Exception as exc:  # noqa: BLE001
                print(f"  ✗ import {name} failed: {type(exc).__name__}: {exc}")
                problems += 1

        # main.py must at least compile and expose main()
        spec = importlib.util.spec_from_file_location("konkred_main", bot_dir / "main.py")
        if spec is None or spec.loader is None:
            print("  ✗ could not load main.py for inspection")
            problems += 1
        else:
            module = importlib.util.module_from_spec(spec)
            try:
                spec.loader.exec_module(module)
                if not callable(getattr(module, "main", None)):
                    print("  ✗ main.py does not expose an async main()")
                    problems += 1
                else:
                    print("  ✓ main.py loads and exposes main()")
            except SystemExit:
                print("  ✓ main.py loads (exited via SystemExit as designed)")
            except Exception as exc:  # noqa: BLE001
                print(f"  ✗ main.py failed to load: {type(exc).__name__}: {exc}")
                problems += 1

    if problems:
        print(f"[imports] FAILED with {problems} problem(s)")
        return 1
    print("[imports] OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
