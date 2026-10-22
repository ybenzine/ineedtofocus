# Single entry point for local work and CI. Run `make help` for the list.
#
# Needs: Docker (with Compose v2), uv, Node.js >= 22 with npm.

.DEFAULT_GOAL := help
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

UV      := uv --directory backend
NPM     := npm --prefix frontend
COMPOSE := docker compose

.PHONY: help install up down logs check-stack test test-backend test-backend-unit \
	test-backend-integration test-frontend test-e2e migrate lint lint-backend lint-frontend \
	fmt fmt-backend fmt-frontend hooks

# Set JUNIT_DIR (e.g. `make test-backend-unit JUNIT_DIR=reports`) to also write JUnit
# XML reports there. CI does this and uploads them as workflow artifacts.
JUNIT_DIR ?=
junit_xml = $(abspath $(JUNIT_DIR))/$(1).xml
pytest_junit = $(if $(JUNIT_DIR),--junitxml=$(call junit_xml,$(1)))
vitest_junit = $(if $(JUNIT_DIR),--reporter=default --reporter=junit --outputFile.junit=$(call junit_xml,$(1)))

help: ## List the available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-25s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

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

test-backend: backend/.venv ## Backend tests, unit + integration (pytest)
	$(UV) run pytest

test-backend-unit: backend/.venv ## Backend unit tests only
	$(UV) run pytest tests/unit $(call pytest_junit,backend-unit)

test-backend-integration: backend/.venv ## Backend integration tests only (Postgres at DATABASE_URL)
	$(UV) run pytest tests/integration -rs $(call pytest_junit,backend-integration)

test-frontend: frontend/node_modules ## Frontend unit tests (Vitest)
	$(NPM) test -- $(call vitest_junit,frontend-unit)

test-e2e: frontend/node_modules ## Playwright end-to-end tests against the running stack (`make up` first)
	@if ! compgen -G 'frontend/playwright.config.*' > /dev/null; then \
		echo 'No Playwright suites yet: frontend/playwright.config.* lands with #23.' >&2; \
		exit 1; \
	fi
	$(NPM) exec --no -- playwright test

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

hooks: install ## Install the git pre-commit hooks (.pre-commit-config.yaml)
	uvx pre-commit install
