# Testing

> **Status:** commands and CI are in place (#1, #5); the Playwright suites came with #23.

## One command

`make test` runs everything below, locally and in CI. `make lint` runs the linters and type checks.

| Command | Runs |
|---|---|
| `make test-backend` | `uv run pytest` in `backend/` (unit + integration) |
| `make test-backend-unit` | `backend/tests/unit/` only |
| `make test-backend-integration` | `backend/tests/integration/` only, with `-rs` (prints why anything skipped) |
| `make test-frontend` | `vitest run` in `frontend/` |
| Frontend dev server | `npm --prefix frontend run dev` serves the app on port 5173 and proxies `/api` to the backend on `http://localhost:8000` (`server.proxy` in `vite.config.ts`), so the session cookie stays first-party. Start the backend first (`make up`, or run it from `backend/`; local Compose sets `COOKIE_SECURE=0`, which plain-http sign-in needs). The proxy applies to the dev server only, not to tests or the production build |
| `make test-e2e` | Playwright (`frontend/e2e/*.spec.ts`, config `frontend/playwright.config.ts`) against whatever answers on the base URL (so check it is your stack): `make up` first. A default local stack allows 10 sign-ups an hour per client and each test signs up, so start it with `SIGNUP_MAX_PER_CLIENT=1000` for local runs. `PLAYWRIGHT_BASE_URL` sets the app URL (default `http://localhost:8000`). Fake clock (`page.clock`), never real waiting. Each test signs up its own user, so raise `SIGNUP_MAX_PER_CLIENT` in the stack's environment for repeated runs (CI sets 1000; the default is 10 an hour). Set `E2E_COMPOSE_PROJECT` if the stack runs under another Compose project name (the log-privacy test reads `docker compose logs app`; it skips unless the Compose project's app publishes the port the tests use, or without Docker). To keep your own stack beside another, run `docker compose -p focus-e2e up -d --build --wait` with `APP_PORT`, `POSTGRES_PORT`, `GRAFANA_PORT`, `OTLP_GRPC_PORT` and `OTLP_HTTP_PORT` changed. Install the browser once with `npm --prefix frontend exec --no -- playwright install chromium` |
| `make test-scripts` | `scripts/tests/`: the repo tooling, e.g. the reviewer App token and review scripts (#70), with the backend's locked pytest plus the token script's pinned dependencies. No network or real key: GitHub, `uv` and `gh` are faked |
| `make test-server` | `infra/server/tests/run.sh`: runs the Droplet setup script `infra/server/bootstrap.sh` (#25) in a fresh `ubuntu:24.04` container three times. Checks packages, Docker and Compose, unattended-upgrades config, the `deploy` user (docker, no sudo), file permissions and the sshd config, then makes real SSH logins: the CI key runs only its forced command, root and keys in `~deploy/.ssh` are refused, the admin user still gets in. The second run must change nothing; the third must flag a deploy key without a forced command. Then, on that bootstrapped container, `focus_ci.sh` tests the deploy side (#28) against a fake `docker` that records every call and its environment: `install.sh` refuses non-root, malformed shas, commits not on `main` and trees with symlinks, writes the full diff and installs nothing without a typed `yes` on a terminal (driven through `script`), installs root-owned files the `deploy` user can't change, and recreates Caddy and the collectors on a change. The forced command `focus-ci`, behind the real sshd with a real CI key, refuses about 30 malformed or hostile requests (shells, scp, sftp, injection, case, spacing, length, an unknown profile) before any docker call. It deploys in order (pull by digest, label check, migrate, up, running-image and `/readyz` checks) with only `PATH`, `HOME` and `APP_TAG` reaching docker, records the release, rolls back without migrating, stops and logs at each failing step, and waits for the deploy lock. The prod key (#29) gets the same hostile requests plus `candidate` variants. It can't roll back or touch dev, and the dev key can't touch prod. `candidate` reads dev's records without a docker call. A prod deploy needs dev to have run that exact sha and digest. It re-points a `:<sha>` that dev moved at prod's digest before `up`, and it records, logs, waits for the lock and stops on a failing step like dev's. A failed migration (an older release on a newer schema) leaves prod's record and running app unchanged. Needs Docker and network (apt); about 1 min. No systemd in a container, so service management is the one part only tested on the Droplet |
| `make test-infra` | `infra/tests/check_config.sh` (#27): renders `infra/compose.edge.yml` and `infra/compose.prod.yml` as prod and dev with dummy secrets (`docker compose config`) and checks that they refuse to render without `APP_TAG` or `POSTGRES_PASSWORD`. Checks the collector picks the right exporters, runs `otelcol validate` on both collector configs, and runs `caddy validate`, `caddy fmt` and `caddy adapt` on the Caddyfile. Then `scripts/check_prod_compose.py` checks the deploy rules: every container has a memory limit, the 2 GiB budget holds, dev stays below prod, only Caddy publishes ports, Caddy's fixed addresses sit outside the networks' `ip_range`, `COOKIE_SECURE=1`, `MIGRATE_ON_START=0`, proxy headers are trusted only from Caddy's address, and Caddy routes each host to its own environment. Needs Docker; about 10 s |
| `make test-prod-stack` | `infra/tests/prod_stack.sh` (#27): starts the real edge, prod and dev projects under test names (`FOCUS_TEST_PREFIX`, default `focus-smoke`) on the app image (built first unless `APP_TAG` names a local one). Caddy runs the real Caddyfile with its internal CA on `127.0.0.1:18080/18443`. Checks the one-shot migration, health, HTTPS and the frontend for both hosts, the http to https redirect, and per-host routing (with dev's app stopped, dev answers 502 and prod 200). Restarts both apps before Caddy, as after a reboot, and checks Caddy still starts. Signs up and signs in through Caddy and checks the session cookie is `Secure`, `HttpOnly` and `SameSite=Lax` (#8). Also checks that proxy headers are trusted from Caddy only, and that dev's collector forwards traces with basic auth and the right environment and version to a fake Grafana Cloud gateway (`infra/tests/fake_otlp.py`). Removes everything it started, volumes included; refuses to run with the real project names or where `/opt/focus` exists. Not part of `make test` (like `test-e2e`); CI runs it. Needs Docker; about 2 minutes with the image built |
| `make lint-backend` | `ruff check`, `ruff format --check`, `mypy` (strict) |
| `make lint-frontend` | `eslint`, `prettier --check`, `tsc -b` (strict) |
| `make lint-scripts` | `ruff check`, `ruff format --check`, `mypy` (strict) on `scripts/*.py`, `scripts/tests/` and `infra/tests/*.py`, with the backend's tools and config. `create_backlog.py` (the one-off board seeding script) is excluded |
| `make lint-shell` | `shellcheck` (pinned `shellcheck-py`, run through `uvx`) on every tracked `*.sh` |
| `make lint-workflows` | `actionlint` (pinned `actionlint-py`, through `uvx`) on `.github/workflows/`, with the pinned ShellCheck on every `run:` script |

Add `JUNIT_DIR=reports` to any `test-*` target except `test-e2e`, `test-server`, `test-infra` and `test-prod-stack` to also write a JUnit XML report to `reports/<suite>.xml` (git-ignored). `make test` also runs the e2e suite, but only if a stack answers at `${PLAYWRIGHT_BASE_URL:-http://localhost:8000}/healthz`; otherwise it prints `SKIPPED e2e: no stack at …` and continues. With `CI` set it fails instead of skipping. `make test-e2e` is always strict.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request and every push to `main`. A newer push to the same PR cancels the older run. Each job is a required status check on `main` ([infra/github/README.md](../infra/github/README.md)):

| Job (check name) | Runs | Notes |
|---|---|---|
| `Lint and type-check` | `make lint-backend`, `make lint-frontend`, `make lint-scripts`, `make lint-shell`, `make lint-workflows` | |
| `Backend unit tests` | `make test-backend-unit`, then `make test-scripts` and `make test-server` | The script and server bootstrap tests ride in this job so the five required check names stay the same |
| `Backend integration tests` | `make test-backend-integration` against a `postgres:17-alpine` service | Connects as `focus`, a role with `CREATEDB` and `pg_signal_backend` but not superuser (`pg_signal_backend` lets `DROP DATABASE ... WITH (FORCE)` end an autovacuum worker on a test database; #88). **Fails if any test skipped**, since a skip means the database was never reached (`scripts/check_junit.py --no-skips`) |
| `Frontend unit tests` | `make test-frontend` | |
| `End-to-end (Compose stack)` | `make up`, `make check-stack` (health, frontend, sign-up over plain http with the session cookie not `Secure`, telemetry, no query strings or cookies in telemetry), then `make test-e2e` | Playwright runs the suites in `frontend/e2e/` against the same stack. `PLAYWRIGHT_BASE_URL` is `http://localhost:8000`; `SIGNUP_MAX_PER_CLIENT` is raised to 1000 so every test can sign up |

Three more jobs aren't required checks (#27, #28, [deployment.md → Images](deployment.md#images-and-production-compose-27)):

| Job | Runs | Notes |
|---|---|---|
| `Image build and production stack smoke` | `make test-infra`, `docker build` of the app image tagged with the commit SHA, then `make test-prod-stack` on it | Every PR and push. On `main` it also saves the tested image as a one-day artifact. Uploads `test-reports-prod-stack` (every container's logs) |
| `Publish image to GHCR` | Loads that artifact and pushes `ghcr.io/ybenzine/ineedtofocus:<sha>` | Only on push to `main`, and only after the five required jobs and the image job passed on that commit (`needs:`). The only job with `packages: write` (`GITHUB_TOKEN`, no stored secret); it checks out no code. Outputs the pushed digest |
| `Deploy to dev` | `ssh … "deploy <sha> sha256:<digest>"` through the forced command, reads the record back, then `scripts/smoke_deploy.py https://dev.ineedtofoc.us` | `needs: publish`, environment `dev`. Skips with a notice, green, while the `dev` environment's secrets aren't set ([deployment.md → Deploy to dev](deployment.md#deploy-to-dev-28)). `scripts/tests/test_ci_workflow.py` pins its gate, environment, concurrency group and secrets |

The prod deploy is its own workflow, `.github/workflows/deploy-prod.yml` (#29, [deployment.md → Deploy to prod](deployment.md#deploy-to-prod-29)), started by hand only. `scripts/tests/test_ci_workflow.py` pins it to `workflow_dispatch` alone, with the `production` environment, its own concurrency group, secrets only in the deploy job and requests the `prod` profile accepts. It runs the plan step with a fake `gh`, including a tag whose dev deployment never passed its smoke tests, and the resolve step with a fake `ssh`. It also checks that the key is deleted before the smoke test runs repository code. For every workflow, it checks that a job reading a secret other than `GITHUB_TOKEN` runs in an environment and that actions are pinned by commit sha.

**Reports.** Each test job uploads a `test-reports-<job>` artifact (14 days): JUnit XML. For end-to-end, the artifact holds `docker compose ps` and the stack's logs, plus `playwright-report/` and `test-results/` once Playwright runs. Each test job also writes a pass/fail/skip table, with skip reasons, to the run's summary page. Coverage isn't collected yet: it needs `pytest-cov` and `@vitest/coverage-v8` in the locked dependencies.

**Actions** are pinned to commit SHAs (with the version in a comment). The workflow token is read-only (`contents: read`), and checkouts don't keep the token. CI uses no stored secrets: the publish job alone gets `packages: write` on its `GITHUB_TOKEN`.

## Layers

| Layer | Tool | Lives in | Covers |
|---|---|---|---|
| Backend unit | pytest | `backend/tests/unit/` | Pure logic: validation, history bucketing, time-zone and week-start rules |
| Backend integration | pytest + real Postgres | `backend/tests/integration/` | API endpoints end to end against the database; user isolation; idempotent sync |
| Frontend unit | Vitest + Testing Library | `frontend/src/**/*.test.ts(x)` | Timer engine with a fake clock, components, sync queue |
| End-to-end | Playwright | `frontend/e2e/` | The key user journey through the real stack (Compose): `journey.spec.ts` (sign up, countdown, Pomodoro, archive, restore, delete), `sync.spec.ts` (offline finish then sync, AC1.4 two devices, tag filter, week start), `layout.spec.ts` (no sideways scroll at 360 px, centred at 1280 px), `privacy.spec.ts` (no goal, email or password in backend logs) |
| Accessibility | axe in Playwright (#24) | `frontend/e2e/` | No serious violations on main screens |

## Rules

- Every acceptance criterion that describes behavior has at least one test; name tests after the AC where practical (`test_ac13_4_retry_does_not_duplicate`).
- Time-dependent logic uses a fake clock — no real waiting in tests.
- Integration tests use a disposable database; never a shared one.
- Telemetry privacy has its own test (see [observability.md](observability.md)).

## Database for integration tests

`make test-backend` does not start Postgres. Integration tests use the Postgres **server** at `DATABASE_URL` (default: the compose `db` service on localhost, started by `make up`) but never its database: `backend/tests/integration/conftest.py` creates a uniquely named `focus_test_<random>` database per test, runs the Alembic migrations or the test against it, and drops it afterwards (`DROP DATABASE ... WITH (FORCE)`). The dev database is never read or written. The tests skip with a clear reason when the server is unreachable. The role needs the `CREATEDB` privilege (the compose superuser has it). CI provides a Postgres service with a `CREATEDB`, `pg_signal_backend`, non-superuser role and fails the job if any integration test skips (see [CI](#ci)).

Migration tests (`tests/integration/test_migrations.py`) cover upgrade, downgrade to base, repeated upgrade, a single head, drift between the models and the migrations (`compare_metadata` must be empty), and the schema constraints. `tests/unit/test_migration_safety.py` enforces the expand/contract rule (see [architecture.md](architecture.md#data-model)).
