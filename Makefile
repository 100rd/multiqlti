# ─────────────────────────────────────────────────────────────────────────────
# multiqlti — host-dev workflow
#
# Infra (Postgres + Redis) runs in Docker; the multiqlti SERVER runs on the host
# so the `claude` (anthropic CLI mode) and `agy` (antigravity) providers — which
# are host-installed binaries — are reachable. Running the server inside the
# Linux container fails: it can't see the host PATH, and `agy` is a macOS-native
# binary that won't execute there.
#
# Full manual: docs/DEPLOYMENT_HOST.md
#
# Typical flow:   make infra-up   →   make dev
# ─────────────────────────────────────────────────────────────────────────────

SHELL   := /bin/bash
COMPOSE := docker compose
INFRA   := postgres redis

.DEFAULT_GOAL := help

.PHONY: help doctor infra-up infra-down infra-restart infra-logs ps dev run start build clean nuke

help: ## Show this help
	@echo "multiqlti — infra in Docker, server on host. Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

doctor: ## Check host prerequisites (claude, agy, node) and infra ports
	@command -v claude >/dev/null 2>&1 && echo "claude     : $$(claude --version 2>/dev/null)" || echo "claude     : MISSING (anthropic CLI provider will fail)"
	@command -v agy    >/dev/null 2>&1 && echo "agy        : $$(agy --version 2>/dev/null)"    || echo "agy        : MISSING (antigravity provider will fail)"
	@command -v node   >/dev/null 2>&1 && echo "node       : $$(node -v)"                      || echo "node       : MISSING"
	@command -v docker >/dev/null 2>&1 && (docker info >/dev/null 2>&1 && echo "docker     : daemon up" || echo "docker     : daemon DOWN") || echo "docker     : MISSING"
	@nc -z localhost 5432 2>/dev/null && echo "pg :5432   : open"    || echo "pg :5432   : closed  (run 'make infra-up')"
	@nc -z localhost 6379 2>/dev/null && echo "redis :6379: open"    || echo "redis :6379: closed  (run 'make infra-up')"

infra-up: ## Start ONLY the infra (Postgres + Redis) in Docker
	$(COMPOSE) up -d $(INFRA)

infra-down: ## Stop the infra containers (data volumes are preserved)
	$(COMPOSE) stop $(INFRA)

infra-restart: infra-down infra-up ## Restart the infra containers

infra-logs: ## Tail the infra container logs
	$(COMPOSE) logs -f $(INFRA)

ps: ## Show container status
	$(COMPOSE) ps

dev: ## Run the server on the host in dev mode (hot reload) — needs `make infra-up`
	./scripts/dev-host.sh dev

run: dev ## Alias for `dev`

start: ## Build + run the production bundle on the host — needs `make infra-up`
	./scripts/dev-host.sh start

build: ## Build the production bundle only (no run)
	npm run build

clean: ## Stop and remove infra containers (volumes/data preserved)
	$(COMPOSE) down

nuke: ## Stop and remove infra containers AND delete data volumes (DESTRUCTIVE)
	$(COMPOSE) down -v
