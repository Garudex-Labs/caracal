# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0
#
# Caracal self-hosting operator interface: run and maintain a deployment
# from this repository with Docker Compose. Run `make help` for the commands.
#
# Contributor commands (test, lint, release, ...) live in Makefile.dev,
# included below; `make help-dev` lists them.
#
# Options (append VAR=value to a command):
#   OBS=prometheus|grafana  up/rebuild/reset: include monitoring (grafana implies prometheus)
#   S="svc ..."             logs: filter to services; rebuild: build only those images
#   NOCACHE=1               reset: rebuild images without the Docker layer cache
#   FORCE=1                 reset/purge: skip the confirmation prompt

.PHONY: up down status logs rebuild migrate reset purge help _host-dirs

.DEFAULT_GOAL := help

# ── Compose wiring ───────────────────────────────────────

COMPOSE_BASE := -f docker-compose.yml
COMPOSE_OBS  := $(COMPOSE_BASE) -f docker-compose.observability.yml

ifeq ($(OBS),grafana)
  COMPOSE := COMPOSE_PROFILES=grafana docker compose $(COMPOSE_OBS)
else ifeq ($(OBS),prometheus)
  COMPOSE := docker compose $(COMPOSE_OBS)
else ifeq ($(strip $(OBS)),)
  COMPOSE := docker compose $(COMPOSE_BASE)
else
  $(error invalid OBS='$(OBS)': use OBS=prometheus or OBS=grafana)
endif

# down/logs address the full service set so monitoring is never left behind.
COMPOSE_ALL := COMPOSE_PROFILES=grafana docker compose $(COMPOSE_OBS)

# Base-file commands see the optional prometheus/grafana containers as orphans; ignore them.
export COMPOSE_IGNORE_ORPHANS := 1

# Rebuilds leave nginx with stale upstream IPs; restart the lb first, then wait.
define wait_healthy
	cd infra/docker && $(COMPOSE) restart caracal-lb
	@echo "Waiting for API to be healthy..."
	@until curl -fsS -o /dev/null "http://localhost:$${LB_HOST_PORT:-80}/health" >/dev/null 2>&1; do sleep 1; done
	@echo "Waiting for web frontend to be healthy..."
	@until curl -fsS -o /dev/null "http://localhost:$${WEB_HOST_PORT:-8000}/" >/dev/null 2>&1; do sleep 1; done
	@echo "API and web frontend are healthy."
endef

# Pre-create bind-mount sources so the Docker daemon doesn't create them root-owned
# (breaks CLI writes to ~/.caracal). On Linux, an ACL lets the container's appuser
# (uid 1001, see infra/docker/Dockerfile.api) write dev.log for `caracal ops logs`;
# macOS has no setfacl but Docker Desktop maps container uids to the host user anyway.
_host-dirs:
	@mkdir -p "$(HOME)/.caracal/logs"
	@command -v setfacl >/dev/null 2>&1 && setfacl -m u:1001:rwx "$(HOME)/.caracal/logs" 2>/dev/null || true

##@ Operate

up: _host-dirs  ## Build local images, start the stack, and wait for API/web health
	cd infra/docker && $(COMPOSE) up --build -d --wait --wait-timeout 300
	$(wait_healthy)

down:  ## Stop the stack, monitoring included
	cd infra/docker && $(COMPOSE_ALL) down

status:  ## Show service states and API health
	cd infra/docker && $(COMPOSE_ALL) ps
	@curl -fsS -o /dev/null "http://localhost:$${LB_HOST_PORT:-80}/health" >/dev/null 2>&1 \
		&& echo "API: healthy" || echo "API: not responding"

logs:  ## Tail service logs (S="svc ..." filters)
	cd infra/docker && $(COMPOSE_ALL) logs -f --tail=50 $(S)

rebuild: _host-dirs  ## Rebuild images and restart (S="svc ..." limits the build; OBS= as above)
ifdef S
	cd infra/docker && $(COMPOSE) build $(S)
	cd infra/docker && $(COMPOSE) up -d --no-build --wait --wait-timeout 300
else
	cd infra/docker && $(COMPOSE) up --build -d --wait --wait-timeout 300
endif
	$(wait_healthy)

##@ Database

migrate:  ## Apply pending Postgres and ClickHouse migrations
	cd infra/docker && docker compose $(COMPOSE_BASE) run --rm caracal-init

##@ Destructive

reset: _host-dirs  ## DELETE ALL DATA: wipe volumes, rebuild, restart (FORCE=1 skips prompt; NOCACHE=1; OBS=)
ifndef FORCE
	@printf "This deletes ALL Caracal data: Postgres, ClickHouse, Redis, and Grafana volumes.\nType 'yes' to continue: "; \
	read ans && [ "$$ans" = yes ] || { echo "Aborted."; exit 1; }
endif
	cd infra/docker && $(COMPOSE_ALL) down -v
ifdef NOCACHE
	cd infra/docker && $(COMPOSE) build --no-cache
	cd infra/docker && $(COMPOSE) up -d --no-build --wait --wait-timeout 300
else
	cd infra/docker && $(COMPOSE) up --build -d --wait --wait-timeout 300
endif
	$(wait_healthy)
	@echo "All data has been reset."

purge:  ## REMOVE EVERYTHING: containers, volumes, networks, and locally built images (FORCE=1 skips prompt)
ifndef FORCE
	@printf "This removes ALL Caracal containers, data volumes, networks, and locally built images.\nType 'yes' to continue: "; \
	read ans && [ "$$ans" = yes ] || { echo "Aborted."; exit 1; }
endif
	cd infra/docker && $(COMPOSE_ALL) down -v --remove-orphans --rmi local
	@echo "Stack purged: containers, volumes, networks, and local images removed."

##@ Help

help:  ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Caracal self-hosting commands (run from the repo root):\n"} \
		/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' Makefile
	@printf '\nOptions: OBS=prometheus|grafana  S="svc ..."  NOCACHE=1  FORCE=1\n'
	@printf 'Contributing to Caracal? `make help-dev` lists the development commands.\n'

# Contributor commands (optional at deploy time; the file ships with the repo).
-include Makefile.dev
