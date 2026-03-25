SHELL := /bin/bash

.PHONY: help ensure-uv check-tools deps deps-dev infra-up infra-down infra-logs infra-status setup-user setup-dev

# Auto-detect Docker Compose command.
DOCKER_COMPOSE := $(shell if docker compose version >/dev/null 2>&1; then echo "docker compose"; elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; else echo ""; fi)

help:
	@echo "Caracal local setup targets"
	@echo ""
	@echo "  make setup-user  End-user setup (deps + infra + CLI install)"
	@echo "  make setup-dev   Developer setup (dev deps + infra + CLI install)"
	@echo ""
	@echo "After setup, run directly: caracal or caracal-flow"
	@echo ""
	@echo "Optional utility targets:"
	@echo "  make deps        Install runtime Python deps from uv.lock"
	@echo "  make deps-dev    Install runtime + dev deps from uv.lock"
	@echo "  make infra-up    Start PostgreSQL + Redis and wait for health"
	@echo "  make infra-down  Stop infra containers"
	@echo "  make infra-logs  Tail PostgreSQL + Redis logs"
	@echo "  make infra-status Show infra container status"

ensure-uv:
	@if ! command -v uv >/dev/null 2>&1; then \
		echo "uv not found. Installing uv..."; \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
		export PATH="$$HOME/.local/bin:$$HOME/.cargo/bin:$$PATH"; \
	fi; \
	if ! command -v uv >/dev/null 2>&1; then \
		echo "uv installation succeeded but uv is not on PATH."; \
		echo "Add $$HOME/.local/bin or $$HOME/.cargo/bin to PATH, then re-run make."; \
		exit 1; \
	fi

check-tools: ensure-uv
	@if ! command -v docker >/dev/null 2>&1; then \
		echo "docker is not installed. Install Docker Engine first."; \
		exit 1; \
	fi
	@if [ -z "$(DOCKER_COMPOSE)" ]; then \
		echo "docker compose is not available. Install Docker Compose plugin or docker-compose."; \
		exit 1; \
	fi
deps: check-tools
	uv sync --locked

deps-dev: check-tools
	uv sync --locked --extra dev

infra-up: check-tools
	$(DOCKER_COMPOSE) up -d postgres redis
	@echo "Waiting for PostgreSQL and Redis health checks..."
	@for i in $$(seq 1 30); do \
		PG_STATUS=$$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' caracal-postgres 2>/dev/null || echo "missing"); \
		REDIS_STATUS=$$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' caracal-redis 2>/dev/null || echo "missing"); \
		if [ "$$PG_STATUS" = "healthy" ] && [ "$$REDIS_STATUS" = "healthy" ]; then \
			echo "Infrastructure is healthy."; \
			exit 0; \
		fi; \
		echo "  postgres=$$PG_STATUS redis=$$REDIS_STATUS (attempt $$i/30)"; \
		sleep 2; \
	done; \
	echo "Timed out waiting for infrastructure to become healthy."; \
	exit 1

infra-down: check-tools
	$(DOCKER_COMPOSE) stop postgres redis

infra-logs: check-tools
	$(DOCKER_COMPOSE) logs -f postgres redis

infra-status: check-tools
	$(DOCKER_COMPOSE) ps postgres redis

setup-user: deps infra-up
	uv tool install --force --from . caracal-core
	@echo "Setup complete. Run: caracal or caracal-flow"

setup-dev: deps-dev infra-up
	uv tool install --force --from . caracal-core
	@echo "Developer setup complete. Run: caracal or caracal-flow"
