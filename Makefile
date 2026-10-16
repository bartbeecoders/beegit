# BeeGit developer entry points. `make help` lists them.
SHELL := /usr/bin/env bash
# Docker if its daemon is reachable, else Podman (needs `systemctl --user start podman.socket`).
CONTAINER ?= $(shell docker info >/dev/null 2>&1 && echo docker || echo podman)
COMPOSE := $(CONTAINER) compose -f docker/compose.dev.yml
# The server container reads dev/state as your user: rootless Podman maps your uid to root.
export BEEGIT_UID := $(if $(filter podman,$(CONTAINER)),0,$(shell id -u))
export BEEGIT_GID := $(if $(filter podman,$(CONTAINER)),0,$(shell id -g))
IMAGE ?= beegit
TAG ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

.PHONY: help build release test check check-full fmt secrets dev-backends dev-up dev-down \
        web-install web-dev web-test web-e2e \
        dev-reset dev-logs run-server smoke image k3s-secrets k3s-deploy k3s-status

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

build: ## Debug build of the whole workspace
	cargo build --workspace

release: ## Release build of the four binaries
	cargo build --release --bin beegit-server --bin beegit --bin beegit-daemon --bin beegit-import

test: ## Hermetic test suite (no Docker needed)
	cargo test --workspace

check: ## fmt + build + test + clippy + layer check
	scripts/check.sh

check-full: ## check plus the long ignored tests
	scripts/check.sh --full

fmt: ## Format the code
	cargo fmt --all

secrets: ## Generate local TLS/CA, signing key, admin secret and ACL into dev/state
	dev/gen-secrets.sh

dev-backends: secrets ## Start CockroachDB + MinIO only
	$(COMPOSE) up -d --wait cockroach minio

dev-up: secrets ## Start backends + beegit-server container (https://localhost:7443)
	$(COMPOSE) --profile server up -d --build --wait

dev-down: ## Stop the local stack (keeps data)
	$(COMPOSE) --profile server down

dev-reset: ## Stop the local stack and delete its data volumes
	$(COMPOSE) --profile server down -v

dev-logs: ## Follow beegit-server logs
	$(COMPOSE) --profile server logs -f beegit-server

run-server: dev-backends release ## Run beegit-server natively against the Docker backends
	source dev/env.sh && target/release/beegit-server config/beegit-server.toml

smoke: ## End-to-end smoke test against the running local server
	dev/smoke.sh

image: ## Build the container image $(IMAGE):$(TAG)
	$(CONTAINER) build -t $(IMAGE):$(TAG) -t $(IMAGE):latest .

web-install: ## Install the web UI's npm dependencies
	cd web && npm install --no-audit --no-fund

web-dev: web-install ## Web UI on http://localhost:5173 against the local server (scripts/start.sh)
	cd web && npm run dev

web-test: ## Web UI type check and unit tests
	cd web && npm run typecheck && npm test

web-e2e: ## Web UI end-to-end tests against BEEGIT_E2E_URL (default: npm run dev)
	cd web && npx playwright test

k3s-secrets: ## Generate production secrets into deploy/k3s/state
	scripts/deploy-k3s.sh secrets

k3s-deploy: ## Build, push to ACR and deploy to the K3s VPS (see docs/deployment-k3s.md)
	scripts/deploy-k3s.sh all

k3s-status: ## Show the BeeGit pods on the K3s VPS
	scripts/deploy-k3s.sh status
