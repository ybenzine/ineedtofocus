# Testing

> **Status: outline.** Commands and suites are filled in by #1, #5 and #23.

## One command

`make test` runs everything below, locally and in CI. `make lint` runs the linters and type checks.

| Command | Runs |
|---|---|
| `make test-backend` | `uv run pytest` in `backend/` (unit + integration) |
| `make test-frontend` | `vitest run` in `frontend/` |
| `make lint-backend` | `ruff check`, `ruff format --check`, `mypy` (strict) |
| `make lint-frontend` | `eslint`, `prettier --check`, `tsc -b` (strict) |

Playwright end-to-end tests join `make test` with #23.

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

`make test-backend` does not start Postgres. Integration tests use the Postgres **server** at `DATABASE_URL` (default: the compose `db` service on localhost, started by `make up`) but never its database: `backend/tests/integration/conftest.py` creates a uniquely named `focus_test_<random>` database per test, runs the Alembic migrations or the test against it, and drops it afterwards (`DROP DATABASE ... WITH (FORCE)`). The dev database is never read or written. The tests skip with a clear reason when the server is unreachable. CI must provide a Postgres service (tracked with the CI issue); the role needs the `CREATEDB` privilege (the compose superuser has it).

Migration tests (`tests/integration/test_migrations.py`) cover upgrade, downgrade to base, repeated upgrade, a single head, drift between the models and the migrations (`compare_metadata` must be empty), and the schema constraints. `tests/unit/test_migration_safety.py` enforces the expand/contract rule (see [architecture.md](architecture.md#data-model)).
