# Konkred AI Ecosystem — developer shortcuts.
# Every target is a thin wrapper over scripts that also run in CI.

SHELL := /bin/bash
PYTHON ?= python3
COMPOSE ?= docker compose

.DEFAULT_GOAL := help

.PHONY: help setup check verify verify-fast test test-gateway test-bot smoke integration \
        lint build up down restart logs ps rebuild clean env mock status

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from .env.example (with a random ADMIN_KEY)
	@./setup.sh --check >/dev/null && echo ".env ready"

setup: ## Full bootstrap: validate, build, start, health-check
	@./setup.sh

mock: ## Start the stack in offline-simulator mode (no provider keys needed)
	@./setup.sh --mock

check: ## Static validation only (no Docker build)
	@./setup.sh --check

verify: ## Run the complete verification suite (same as CI)
	@PYTHON=$(PYTHON) ./scripts/verify.sh

verify-fast: ## Verification suite without Docker builds / integration
	@PYTHON=$(PYTHON) ./scripts/verify.sh --fast

test: test-gateway test-bot ## Run gateway + bot unit test suites

test-gateway: ## Gateway unit tests (node --test)
	@cd gateway && node --test tests/*.test.mjs

test-bot: ## Bot unit tests (stdlib unittest)
	@cd bot && PYTHONPATH=tests:. $(PYTHON) -m unittest discover -s tests -p 'test_*.py' -t .

smoke: ## Gateway HTTP smoke test against the offline simulator
	@cd gateway && node scripts/smoke.mjs

integration: ## Real bot client ↔ real gateway over HTTP
	@$(PYTHON) scripts/integration_bot_gateway.py

lint: ## Syntax + config linting (ESM, python, compose, env template, shell)
	@bash -n setup.sh && bash -n scripts/verify.sh && echo "shell ok"
	@$(PYTHON) scripts/validate_env.py
	@$(PYTHON) scripts/validate_compose.py || echo "(install pyyaml to validate compose)"
	@node gateway/scripts/check.mjs

build: ## Build both container images
	@$(COMPOSE) build --pull

up: ## Start the stack in the background
	@$(COMPOSE) up -d

down: ## Stop the stack (keeps the redis volume)
	@$(COMPOSE) down

restart: ## Restart every service
	@$(COMPOSE) restart

rebuild: ## Rebuild and recreate containers
	@$(COMPOSE) up -d --build

logs: ## Tail all service logs
	@$(COMPOSE) logs -f --tail=100

ps: ## Show container + health status
	@$(COMPOSE) ps

status: ## Query the running gateway's deep status endpoint
	@curl -s -H "x-admin-key: $$(grep -E '^ADMIN_KEY=' .env | cut -d= -f2-)" \
		http://127.0.0.1:$$(grep -E '^GATEWAY_PORT=' .env | cut -d= -f2- | sed 's/^$$/3000/')/api/status | head -c 2000

clean: ## Remove containers, images and caches created by local runs
	@$(COMPOSE) down -v --remove-orphans || true
	@docker image rm konkred-gateway:local konkred-bot:local konkred-gateway:ci konkred-bot:ci konkred-gateway:verify konkred-bot:verify 2>/dev/null || true
	@find . -path ./.git -prune -o -name '__pycache__' -type d -print0 2>/dev/null | xargs -0 rm -rf 2>/dev/null || true
