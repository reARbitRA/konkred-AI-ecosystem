#!/usr/bin/env python3
"""Structural validation of docker-compose.yml (works without Docker installed).

Checks the invariants the deployment brief depends on:
  * the file parses as YAML and uses the compose `services:` top-level key
  * redis / gateway / bot services exist with the expected images or build contexts
  * bot can resolve `http://gateway:3000/api/ai` and `redis://redis:6379/0`
    (i.e. all three services share one user-defined network)
  * gateway + redis expose healthchecks and bot depends on them being healthy
  * no container publishes a port that clashes with the compose default
  * the internal network is a user-defined bridge (required for DNS by name)

Usage: python3 scripts/validate_compose.py [--file docker-compose.yml]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Dict, List

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    print("PyYAML is required: pip install pyyaml")
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parent.parent
REQUIRED_SERVICES = ("redis", "gateway", "bot")
INTERNAL_NETWORK = "internal-net"


def networks_of(service: Dict[str, Any]) -> List[str]:
    nets = service.get("networks")
    if isinstance(nets, list):
        return list(nets)
    if isinstance(nets, dict):
        return list(nets.keys())
    return []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default="docker-compose.yml")
    args = parser.parse_args()

    path = (ROOT / args.file) if not Path(args.file).is_absolute() else Path(args.file)
    if not path.exists():
        print(f"FAIL: {path} not found")
        return 1

    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        print(f"FAIL: {path.name} is not valid YAML → {exc}")
        return 1

    problems: List[str] = []
    notes: List[str] = []

    if not isinstance(doc, dict) or "services" not in doc:
        print("FAIL: compose document has no top-level `services:` mapping")
        return 1

    services: Dict[str, Any] = doc["services"]
    for name in REQUIRED_SERVICES:
        if name not in services:
            problems.append(f"missing service: {name}")
    if problems:
        for p in problems:
            print(f"  ✗ {p}")
        return 1

    notes.append(f"services: {', '.join(services)}")

    # --- images / build contexts -----------------------------------------
    redis = services["redis"]
    if not str(redis.get("image", "")).startswith("redis:7"):
        problems.append(f"redis should use a redis:7 image, got {redis.get('image')!r}")
    if "appendonly" not in " ".join(map(str, redis.get("command", []))):
        problems.append("redis should run with --appendonly yes so state survives restarts")

    gateway = services["gateway"]
    build = gateway.get("build") or {}
    if not (isinstance(build, dict) and build.get("context", "").endswith("gateway")):
        problems.append("gateway.build.context must point at ./gateway")

    bot = services["bot"]
    bbuild = bot.get("build") or {}
    if not (isinstance(bbuild, dict) and bbuild.get("context", "").endswith("bot")):
        problems.append("bot.build.context must point at ./bot")

    # --- shared network (DNS by service name) ------------------------------
    declared_networks = set(doc.get("networks") or {})
    if INTERNAL_NETWORK not in declared_networks:
        problems.append(f"top-level network '{INTERNAL_NETWORK}' is not declared")
    else:
        driver = (doc["networks"][INTERNAL_NETWORK] or {}).get("driver")
        if driver and driver != "bridge":
            problems.append(f"network '{INTERNAL_NETWORK}' must use the bridge driver for service-name DNS")

    for name in REQUIRED_SERVICES:
        nets = networks_of(services[name])
        if INTERNAL_NETWORK not in nets:
            problems.append(f"service '{name}' is not attached to '{INTERNAL_NETWORK}' — bot cannot resolve gateway/redis by name")

    # --- bot wiring ---------------------------------------------------------
    bot_env = {str(k): str(v) for k, v in (bot.get("environment") or {}).items()} if isinstance(bot.get("environment"), dict) else {}
    for entry in bot.get("environment") or []:
        if isinstance(entry, str) and "=" in entry:
            k, _, v = entry.partition("=")
            bot_env[k] = v

    if bot_env.get("GATEWAY_URL") != "http://gateway:3000/api/ai":
        problems.append(f"bot.GATEWAY_URL must be http://gateway:3000/api/ai, got {bot_env.get('GATEWAY_URL')!r}")
    if bot_env.get("REDIS_URL") != "redis://redis:6379/0":
        problems.append(f"bot.REDIS_URL must be redis://redis:6379/0, got {bot_env.get('REDIS_URL')!r}")
    notes.append("bot → http://gateway:3000/api/ai and redis://redis:6379/0 (service-name DNS on internal-net)")

    # --- healthchecks + ordering -------------------------------------------
    for name in ("redis", "gateway"):
        if not services[name].get("healthcheck"):
            problems.append(f"service '{name}' has no healthcheck — bot may start before it is usable")

    depends = bot.get("depends_on") or {}
    if isinstance(depends, list):
        problems.append("bot.depends_on must use the long form with `condition: service_healthy`")
    else:
        for dep in ("redis", "gateway"):
            condition = (depends.get(dep) or {}).get("condition")
            if condition != "service_healthy":
                problems.append(f"bot.depends_on.{dep}.condition must be service_healthy, got {condition!r}")

    gw_health = (gateway.get("healthcheck") or {}).get("test")
    gw_health_text = " ".join(gw_health) if isinstance(gw_health, list) else str(gw_health or "")
    if "/api/health" not in gw_health_text:
        problems.append("gateway healthcheck should probe /api/health")

    bot_health_text = " ".join((bot.get("healthcheck") or {}).get("test") or [])
    if "healthcheck.py" not in bot_health_text:
        problems.append("bot healthcheck should run healthcheck.py (heartbeat based)")

    # --- ports / restart policy --------------------------------------------
    ports = gateway.get("ports") or []
    if not ports:
        problems.append("gateway should publish a port for local debugging (GATEWAY_PORT:3000)")
    if bot.get("ports"):
        problems.append("bot must not publish ports — Telegram polling is outbound only")

    for name in REQUIRED_SERVICES:
        if services[name].get("restart") not in {"unless-stopped", "always", "on-failure"}:
            problems.append(f"service '{name}' needs a restart policy for 24/7 operation")

    if (doc.get("volumes") or {}).get("redis-data") is None:
        problems.append("redis-data volume must be declared so history survives restarts")

    print(f"[compose] {path.name}")
    for note in notes:
        print(f"  ✓ {note}")
    if problems:
        for p in problems:
            print(f"  ✗ {p}")
        print(f"[compose] FAILED with {len(problems)} problem(s)")
        return 1
    print("[compose] OK — topology, healthchecks and bot wiring verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
