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
| `make test-scripts` | `scripts/tests/`: the repo tooling, e.g. the reviewer App token and review scripts (#70), with the backend's locked pytest plus the token script's pinned dependencies. No network or real key: GitHub, `uv` and `gh` are faked |
| `make test-server` | `infra/server/tests/run.sh`: runs the Droplet setup script `infra/server/bootstrap.sh` (#25) in a fresh `ubuntu:24.04` container three times. Checks packages, Docker and Compose, unattended-upgrades config, the `deploy` user (docker, no sudo), file permissions and the sshd config, then makes real SSH logins: the CI key runs only its forced command, root and keys in `~deploy/.ssh` are refused, the admin user still gets in. The second run must change nothing; the third must flag a deploy key without a forced command. Needs Docker and network (apt); about 30 s. No systemd in a container, so service management is the one part only tested on the Droplet |
| `make test-infra` | `infra/tests/check_config.sh` (#27): renders `infra/compose.edge.yml` and `infra/compose.prod.yml` as prod and dev with dummy secrets (`docker compose config`) and checks that they refuse to render without `APP_TAG` or `POSTGRES_PASSWORD`. Checks the collector picks the right exporters, runs `otelcol validate` on both collector configs, and runs `caddy validate`, `caddy fmt` and `caddy adapt` on the Caddyfile. Then `scripts/check_prod_compose.py` checks the deploy rules: every container has a memory limit, the 2 GiB budget holds, dev stays below prod, only Caddy publishes ports, `COOKIE_SECURE=1`, `MIGRATE_ON_START=0`, proxy headers are trusted only from Caddy's address, and Caddy routes each host to its own environment. Needs Docker; about 10 s |
| `make test-prod-stack` | `infra/tests/prod_stack.sh` (#27): starts the real edge, prod and dev projects under test names (`FOCUS_TEST_PREFIX`, default `focus-smoke`) on the app image (built first unless `APP_TAG` names a local one). Caddy runs the real Caddyfile with its internal CA on `127.0.0.1:18080/18443`. Checks the one-shot migration, health, HTTPS and the frontend for both hosts, the http to https redirect, and per-host routing (with dev's app stopped, dev answers 502 and prod 200). Also checks that proxy headers are trusted from Caddy only, and that dev's collector forwards traces with basic auth and the right environment and version to a fake Grafana Cloud gateway (`infra/tests/fake_otlp.py`). Removes everything it started, volumes included; refuses to run with the real project names or where `/opt/focus` exists. Not part of `make test` (like `test-e2e`); CI runs it. Needs Docker; about 2 minutes with the image built |
| `make lint-backend` | `ruff check`, `ruff format --check`, `mypy` (strict) |
| `make lint-frontend` | `eslint`, `prettier --check`, `tsc -b` (strict) |
| `make lint-scripts` | `ruff check`, `ruff format --check`, `mypy` (strict) on `scripts/*.py`, `scripts/tests/` and `infra/tests/*.py`, with the backend's tools and config. `create_backlog.py` (the one-off board seeding script) is excluded |
| `make lint-shell` | `shellcheck` (pinned `shellcheck-py`, run through `uvx`) on every tracked `*.sh` |

Add `JUNIT_DIR=reports` to any `test-*` target except `test-e2e`, `test-server`, `test-infra` and `test-prod-stack` to also write a JUnit XML report to `reports/<suite>.xml` (git-ignored). Playwright end-to-end tests join `make test` with #23.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request and every push to `main`. A newer push to the same PR cancels the older run. Each job is a required status check on `main` ([infra/github/README.md](../infra/github/README.md)):

| Job (check name) | Runs | Notes |
|---|---|---|
| `Lint and type-check` | `make lint-backend`, `make lint-frontend`, `make lint-scripts`, `make lint-shell` | |
| `Backend unit tests` | `make test-backend-unit`, then `make test-scripts` and `make test-server` | The script and server bootstrap tests ride in this job so the five required check names stay the same |
| `Backend integration tests` | `make test-backend-integration` against a `postgres:17-alpine` service | Connects as `focus`, a role with `CREATEDB` but not superuser. **Fails if any test skipped**, since a skip means the database was never reached (`scripts/check_junit.py --no-skips`) |
| `Frontend unit tests` | `make test-frontend` | |
| `End-to-end (Compose stack)` | `make up`, `make check-stack`, then `make test-e2e` when `frontend/playwright.config.*` exists | Until #23 lands, Playwright doesn't run. The job then posts a "Playwright not run" warning and job summary, and only checks the stack: health, frontend, telemetry and no query strings or cookies in telemetry. `PLAYWRIGHT_BASE_URL` is `http://localhost:8000` |

Two more jobs aren't required checks (#27, [deployment.md → Images](deployment.md#images-and-production-compose-27)):

| Job | Runs | Notes |
|---|---|---|
| `Image build and production stack smoke` | `make test-infra`, `docker build` of the app image tagged with the commit SHA, then `make test-prod-stack` on it | Every PR and push. On `main` it also saves the tested image as a one-day artifact. Uploads `test-reports-prod-stack` (every container's logs) |
| `Publish image to GHCR` | Loads that artifact and pushes `ghcr.io/ybenzine/ineedtofocus:<sha>` | Only on push to `main`, and only after the five required jobs and the image job passed on that commit (`needs:`). The only job with `packages: write` (`GITHUB_TOKEN`, no stored secret); it checks out no code |

**Reports.** Each test job uploads a `test-reports-<job>` artifact (14 days): JUnit XML. For end-to-end, the artifact holds `docker compose ps` and the stack's logs, plus `playwright-report/` and `test-results/` once Playwright runs. Each test job also writes a pass/fail/skip table, with skip reasons, to the run's summary page. Coverage isn't collected yet: it needs `pytest-cov` and `@vitest/coverage-v8` in the locked dependencies.

**Actions** are pinned to commit SHAs (with the version in a comment). The workflow token is read-only (`contents: read`), and checkouts don't keep the token. CI uses no stored secrets: the publish job alone gets `packages: write` on its `GITHUB_TOKEN`.

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
