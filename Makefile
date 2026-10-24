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
	test-backend-integration test-frontend test-e2e test-e2e-if-up test-scripts test-server test-infra test-prod-stack \
	migrate lint lint-backend \
	lint-frontend lint-scripts lint-shell lint-workflows openapi fmt fmt-backend fmt-frontend hooks

# Set JUNIT_DIR (e.g. `make test-backend-unit JUNIT_DIR=reports`) to also write JUnit
# XML reports there. CI does this and uploads them as workflow artifacts.
JUNIT_DIR ?=
junit_xml = $(abspath $(JUNIT_DIR))/$(1).xml
pytest_junit = $(if $(JUNIT_DIR),--junitxml=$(call junit_xml,$(1)))
vitest_junit = $(if $(JUNIT_DIR),--reporter=default --reporter=junit --outputFile.junit=$(call junit_xml,$(1)))

# Repo tooling in scripts/ is linted and tested with the backend's locked ruff, mypy and pytest
# (backend/uv.lock, same config as the backend), plus the exact dependency pins in
# scripts/reviewer_token.py's inline metadata. Paths are relative to backend/.
SCRIPTS_RUN := $(UV) run --with-requirements ../scripts/reviewer_token.py
# create_backlog.py seeded the board once (2026-10-20) and is kept only as a record; not linted.
SCRIPTS_LINT_EXCLUDE := create_backlog.py
# Python test helpers under infra/ (the smoke test's fake OTLP gateway), linted like scripts/.
INFRA_PY := ../infra/tests
# ShellCheck, pinned, run through uv (shellcheck-py ships the official binary).
SHELLCHECK := uvx --from shellcheck-py==0.11.0.1 shellcheck
# actionlint, pinned, through uv (actionlint-py ships the official binary). The pinned
# ShellCheck rides along so actionlint also checks every `run:` script.
ACTIONLINT := uvx --from actionlint-py==1.7.12.25 --with shellcheck-py==0.11.0.1 actionlint

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

openapi: backend/.venv ## Regenerate _docs/api/openapi.json (commit it with any API change)
	$(UV) run python -m app.openapi_export

# --- Tests --------------------------------------------------------------------

test: test-backend test-frontend test-scripts test-server test-infra test-e2e-if-up ## Run every test suite (e2e runs if a stack answers; fails in CI otherwise)

test-backend: backend/.venv ## Backend tests, unit + integration (pytest)
	$(UV) run pytest

test-backend-unit: backend/.venv ## Backend unit tests only
	$(UV) run pytest tests/unit $(call pytest_junit,backend-unit)

test-backend-integration: backend/.venv ## Backend integration tests only (Postgres at DATABASE_URL)
	$(UV) run pytest tests/integration -rs $(call pytest_junit,backend-integration)

test-frontend: frontend/node_modules ## Frontend unit tests (Vitest)
	$(NPM) test -- $(call vitest_junit,frontend-unit)

test-scripts: backend/.venv ## Repo script tests (scripts/tests, pytest; e.g. the reviewer App, #70)
	$(SCRIPTS_RUN) pytest -p no:cacheprovider ../scripts/tests $(call pytest_junit,scripts)

test-server: ## Server bootstrap (#25), installer and deploy forced command (#28, #29) in an Ubuntu 24.04 container (needs Docker)
	infra/server/tests/run.sh

test-infra: ## Validate the production Compose, Caddy and Collector configs against the deploy rules (#27; needs Docker)
	infra/tests/check_config.sh

test-prod-stack: ## Smoke-test the production stack: Caddy + prod + dev (#27; needs Docker; APP_TAG=<tag> skips the build)
	infra/tests/prod_stack.sh

# Inside `make test`: run e2e when a stack answers on the base URL, otherwise skip loudly
# (fail when CI is set). `make test-e2e` itself is always strict.
test-e2e-if-up:
	@url="$${PLAYWRIGHT_BASE_URL:-http://localhost:8000}"; \
	if curl -fsS --max-time 3 "$$url/healthz" > /dev/null 2>&1; then \
		$(MAKE) test-e2e; \
	elif [ -n "$${CI:-}" ]; then \
		echo "FAILED e2e: no stack at $$url (CI is set). Run make up first." >&2; exit 1; \
	else \
		echo "SKIPPED e2e: no stack at $$url. Run make up, then make test-e2e." >&2; \
	fi

test-e2e: frontend/node_modules ## Playwright end-to-end tests against the running stack (`make up` first)
	@if ! compgen -G 'frontend/playwright.config.*' > /dev/null; then \
		echo 'frontend/playwright.config.* is missing.' >&2; \
		exit 1; \
	fi
	$(NPM) exec --no -- playwright test --config frontend/playwright.config.ts

# --- Lint and format ----------------------------------------------------------

lint: lint-backend lint-frontend lint-scripts lint-shell lint-workflows ## Run all linters and type checks

lint-backend: backend/.venv ## ruff check, ruff format --check, mypy
	$(UV) run ruff check .
	$(UV) run ruff format --check .
	$(UV) run mypy

lint-frontend: frontend/node_modules ## eslint, prettier --check, tsc
	$(NPM) run lint

lint-scripts: backend/.venv ## ruff check, ruff format --check, mypy (strict) on scripts/*.py and infra/tests/*.py
	$(SCRIPTS_RUN) ruff check --config pyproject.toml --extend-exclude $(SCRIPTS_LINT_EXCLUDE) ../scripts $(INFRA_PY)
	$(SCRIPTS_RUN) ruff format --config pyproject.toml --extend-exclude $(SCRIPTS_LINT_EXCLUDE) --check ../scripts $(INFRA_PY)
	$(SCRIPTS_RUN) mypy --config-file pyproject.toml --exclude '$(SCRIPTS_LINT_EXCLUDE)$$' ../scripts $(INFRA_PY)

lint-shell: ## shellcheck on every tracked shell script (*.sh)
	git ls-files -z '*.sh' | xargs -0 $(SHELLCHECK)

lint-workflows: ## actionlint (with shellcheck on run: steps) on .github/workflows
	$(ACTIONLINT)

fmt: fmt-backend fmt-frontend ## Auto-format everything

fmt-backend: backend/.venv
	$(UV) run ruff check --fix .
	$(UV) run ruff format .

fmt-frontend: frontend/node_modules
	$(NPM) run fmt

hooks: install ## Install the git pre-commit hooks (.pre-commit-config.yaml)
	uvx pre-commit install
