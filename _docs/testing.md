# Testing

> **Status:** commands and CI are in place (#1, #5). Playwright suites are added by #23.

## One command

`make test` runs everything below, locally and in CI. `make lint` runs the linters and type checks.

| Command | Runs |
|---|---|
| `make test-backend` | `uv run pytest` in `backend/` (unit + integration) |
| `make test-backend-unit` | `backend/tests/unit/` only |
| `make test-backend-integration` | `backend/tests/integration/` only, with `-rs` (prints why anything skipped) |
| `make test-frontend` | `vitest run` in `frontend/` |
| `make test-e2e` | Playwright against the running stack (`make up` first); fails until #23 adds the suites |
| `make lint-backend` | `ruff check`, `ruff format --check`, `mypy` (strict) |
| `make lint-frontend` | `eslint`, `prettier --check`, `tsc -b` (strict) |

Add `JUNIT_DIR=reports` to any `test-*` target except `test-e2e` to also write a JUnit XML report to `reports/<suite>.xml` (git-ignored). Playwright end-to-end tests join `make test` with #23.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request and every push to `main`. A newer push to the same PR cancels the older run. Each job is a required status check on `main` ([infra/github/README.md](../infra/github/README.md)):

| Job (check name) | Runs | Notes |
|---|---|---|
| `Lint and type-check` | `make lint-backend`, `make lint-frontend` | |
| `Backend unit tests` | `make test-backend-unit` | |
| `Backend integration tests` | `make test-backend-integration` against a `postgres:17-alpine` service | Connects as `focus`, a role with `CREATEDB` but not superuser. **Fails if any test skipped**, since a skip means the database was never reached (`scripts/check_junit.py --no-skips`) |
| `Frontend unit tests` | `make test-frontend` | |
| `End-to-end (Compose stack)` | `make up`, `make check-stack`, then `make test-e2e` when `frontend/playwright.config.*` exists | Until #23 lands, Playwright doesn't run. The job then posts a "Playwright not run" warning and job summary, and only checks the stack: health, frontend, telemetry and no query strings or cookies in telemetry. `PLAYWRIGHT_BASE_URL` is `http://localhost:8000` |

**Reports.** Each test job uploads a `test-reports-<job>` artifact (14 days): JUnit XML. For end-to-end, the artifact holds `docker compose ps` and the stack's logs, plus `playwright-report/` and `test-results/` once Playwright runs. Each test job also writes a pass/fail/skip table, with skip reasons, to the run's summary page. Coverage isn't collected yet: it needs `pytest-cov` and `@vitest/coverage-v8` in the locked dependencies.

**Actions** are pinned to commit SHAs (with the version in a comment). The workflow token is read-only (`contents: read`), and checkouts don't keep the token. CI uses no secrets.

## Layers

| Layer | Tool | Lives in | Covers |
|---|---|---|---|
| Backend unit | pytest | `backend/tests/unit/` | Pure logic: validation, history bucketing, time-zone and week-start rules |
| Backend integration | pytest + real Postgres | `backend/tests/integration/` | API endpoints end to end against the database; user isolation; idempotent sync |
| Frontend unit | Vitest + Testing Library | `frontend/src/**/*.test.ts(x)` | Timer engine with a fake clock, components, sync queue |
| End-to-end | Playwright | `frontend/e2e/` | The key user journey through the real stack (Compose) |
| Accessibility | axe in Playwright | `frontend/e2e/` | No serious violations on main screens |

## Rules

- Every acceptance criterion that describes behavior has at least one test; name tests after the AC where practical (`test_ac13_4_retry_does_not_duplicate`).
- Time-dependent logic uses a fake clock — no real waiting in tests.
- Integration tests use a disposable database; never a shared one.
- Telemetry privacy has its own test (see [observability.md](observability.md)).

## Database for integration tests

`make test-backend` does not start Postgres. Integration tests use the Postgres **server** at `DATABASE_URL` (default: the compose `db` service on localhost, started by `make up`) but never its database: `backend/tests/integration/conftest.py` creates a uniquely named `focus_test_<random>` database per test, runs the Alembic migrations or the test against it, and drops it afterwards (`DROP DATABASE ... WITH (FORCE)`). The dev database is never read or written. The tests skip with a clear reason when the server is unreachable. The role needs the `CREATEDB` privilege (the compose superuser has it). CI provides a Postgres service with a `CREATEDB`, non-superuser role and fails the job if any integration test skips (see [CI](#ci)).

Migration tests (`tests/integration/test_migrations.py`) cover upgrade, downgrade to base, repeated upgrade, a single head, drift between the models and the migrations (`compare_metadata` must be empty), and the schema constraints. `tests/unit/test_migration_safety.py` enforces the expand/contract rule (see [architecture.md](architecture.md#data-model)).
