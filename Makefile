# Single entry point for local work and CI. Run `make help` for the list.
#
# Needs: Docker (with Compose v2), uv, Node.js >= 22 with npm.

.DEFAULT_GOAL := help
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

UV      := uv --directory backend
NPM     := npm --prefix frontend
COMPOSE := docker compose

.PHONY: help install up down logs check-stack test test-backend test-frontend \
	migrate lint lint-backend lint-frontend fmt fmt-backend fmt-frontend hooks

help: ## List the available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- Dependencies -------------------------------------------------------------

install: backend/.venv frontend/node_modules ## Install backend and frontend dependencies

backend/.venv: backend/pyproject.toml backend/uv.lock
	$(UV) sync --locked
	@touch $@

frontend/node_modules: frontend/package.json frontend/package-lock.json
	$(NPM) ci
	@touch $@

# --- Local stack --------------------------------------------------------------

up: ## Build and start the local stack, wait until it is healthy (compose.yaml)
	$(COMPOSE) up -d --build --wait
	@echo "App:     http://localhost:8000 (or the APP_PORT set in .env)"
	@echo "Grafana: http://localhost:3000 (or the GRAFANA_PORT set in .env)"

down: ## Stop the local stack (keeps the database volume)
	$(COMPOSE) down

logs: ## Follow the local stack's logs
	$(COMPOSE) logs -f

check-stack: ## Check the running stack: health, frontend, telemetry in Grafana
	python3 scripts/check_local_stack.py

migrate: backend/.venv ## Apply database migrations (alembic upgrade head) to DATABASE_URL
	$(UV) run alembic upgrade head

# --- Tests --------------------------------------------------------------------

test: test-backend test-frontend ## Run every test suite

test-backend: backend/.venv ## Backend tests (pytest)
	$(UV) run pytest

test-frontend: frontend/node_modules ## Frontend unit tests (Vitest)
	$(NPM) test

# --- Lint and format ----------------------------------------------------------

lint: lint-backend lint-frontend ## Run all linters and type checks

lint-backend: backend/.venv ## ruff check, ruff format --check, mypy
	$(UV) run ruff check .
	$(UV) run ruff format --check .
	$(UV) run mypy

lint-frontend: frontend/node_modules ## eslint, prettier --check, tsc
	$(NPM) run lint

fmt: fmt-backend fmt-frontend ## Auto-format everything

fmt-backend: backend/.venv
	$(UV) run ruff check --fix .
	$(UV) run ruff format .

fmt-frontend: frontend/node_modules
	$(NPM) run fmt

hooks: ## Install the git pre-commit hooks (.pre-commit-config.yaml)
	uvx pre-commit install
