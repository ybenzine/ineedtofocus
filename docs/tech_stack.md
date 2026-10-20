# I Need To Focus — Tech Stack

Status: agreed technical plan for the MVP described in [product_decisions.md](product_decisions.md).

Production: https://ineedtofoc.us · Dev: https://dev.ineedtofoc.us

## 1. Tech stack

| Layer | Choice |
|---|---|
| Backend | Python, FastAPI, SQLAlchemy, Alembic migrations, served by Uvicorn |
| Database | PostgreSQL |
| Frontend | React + TypeScript (Vite), installable web app (vite-plugin-pwa service worker) |
| Offline storage | IndexedDB via Dexie; sessions get a client-generated UUID so sync is idempotent |
| Auth | Email + password, argon2 hashing, secure HTTP-only session cookie (frontend and API on the same origin) |
| Audio | Web Audio API for the gapless rain loop and chimes; YouTube IFrame Player API for YouTube |
| Tests | pytest (unit + integration against a real Postgres), Vitest + Testing Library (frontend), Playwright (end-to-end); all run with `make test` |
| Containers | Docker + Docker Compose; one command (`make up` / `docker compose up`) starts app, database and local observability stack |
| Observability | OpenTelemetry (traces + metrics), structured JSON logs carrying the trace ID; locally `grafana/otel-lgtm`, deployed Grafana Cloud (free tier) |
| CI/CD | GitHub Actions; images in GitHub Container Registry (GHCR) |
| Coding agents | Claude Code — subagents for the build team, headless Claude Code in GitHub Actions for the on-call responder |
| Native stretch | Capacitor wrapping the same React app (background audio, local notifications) |

## 2. Environments and hosting

- **Server:** one DigitalOcean Droplet, Basic 2 GiB / 1 vCPU ($12/month, optional weekly backups +$2.40), Ubuntu 24.04 LTS, NYC region.
- **Layout on the Droplet:** two Docker Compose projects, `focus-prod` and `focus-dev`, each with its own app container and its own Postgres container and volume. One shared Caddy container terminates HTTPS (automatic Let's Encrypt certificates) and routes by host name. An OpenTelemetry Collector container forwards telemetry to Grafana Cloud. Every container has a memory limit so dev cannot starve prod.
- **Security:** DigitalOcean Cloud Firewall allows only 22 (SSH, key-only), 80 and 443. Secrets live in per-environment `.env` files on the server and in GitHub environment secrets, never in the repo.
- **Domain:** `ineedtofoc.us` registered at Gandi, DNS hosted on AWS Route 53.

| Record (Route 53) | Type | Value | TTL |
|---|---|---|---|
| `ineedtofoc.us` | A | Droplet IPv4 | 300 |
| `dev.ineedtofoc.us` | A | Droplet IPv4 | 300 |
| `ineedtofoc.us` (optional) | CAA | `0 issue "letsencrypt.org"` | 3600 |

Prerequisite: the domain's nameservers at Gandi must be the four Route 53 nameservers of the hosted zone.

## 3. CI/CD and rollback

- **CI (every pull request and push):** lint, type-check, backend unit + integration tests, frontend tests, Playwright end-to-end tests against the Compose stack.
- **CD to dev (automatic):** on merge to `main`, build one image tagged with the commit SHA, push to GHCR, deploy to `focus-dev`, run smoke tests against `https://dev.ineedtofoc.us`.
- **Deploy to prod (manual):** a `workflow_dispatch` workflow takes an image tag (default: the tag currently on dev) and requires approval through the GitHub `production` environment.
- **Deploy script (both environments):** records the current tag, pulls the new image, runs migrations, restarts the app, checks `/healthz` (app) and `/readyz` (database). If the checks fail it automatically redeploys the previous tag.
- **Rollback:** a manual `rollback` workflow redeploys the last known-good tag for an environment. The on-call agent uses the same workflow.
- **Migrations:** backward-compatible only (add columns/tables first, remove later), so rolling back the app never requires a database downgrade.

## 4. Observability and alerting

- **Instrumented journey:** save a finished session (including offline sync batches) and load history ([product_decisions.md §3](product_decisions.md)).
- **Signals:** traces for every request (FastAPI + SQLAlchemy instrumentation); metrics for session saves (count by outcome, latency) and history loads (count by outcome, latency); JSON logs with `trace_id` and `span_id` on every line so logs, traces and metrics link up in Grafana.
- **No customer data in telemetry:** emails, passwords, cookies, session goals and YouTube links are never sent to telemetry. Users are referenced only by an opaque internal ID. Enforced by an attribute allowlist and covered by a test.
- **Where to look:** locally in Grafana from `grafana/otel-lgtm`; deployed in Grafana Cloud (dashboards for the key journey per environment).
- **Alert on user impact:** fires when the session-save error rate exceeds 5% over 5 minutes (with a minimum number of requests), or when history loads' p95 latency exceeds 2 s. Not on CPU or memory.
- **Alert trigger for the demo:** a fault-injection setting, off by default and only changeable by the operator, makes a percentage of session saves fail; a small traffic script generates realistic load so the alert fires.
- **Alert routing:** Grafana alert → webhook → GitHub `repository_dispatch` (through a small relay if Grafana's payload can't call GitHub directly) → on-call agent workflow.

## 5. Agent team and on-call responder

- **Build team (Claude Code subagents):** product/spec, backend, frontend, QA/test, DevOps, and reviewer. Work is tracked as GitHub Issues in a public repo; each issue carries acceptance criteria from [product_decisions.md §4](product_decisions.md), and agents link their branches, PRs and test results to the issue. Process and roles are documented in `AGENTS.md` and the docs it links to.
- **On-call agent (headless Claude Code in GitHub Actions):** woken by the alert. It opens or updates an incident issue, reads the relevant traces, logs and metrics through a read-only Grafana token, and follows the runbook: if a recent deploy caused the problem, it runs the `rollback` workflow; otherwise it opens a fix PR with a regression test. It then checks that the alert resolves and writes an incident summary on the issue.
- **Guardrails:** the on-call agent cannot push to `main` or deploy arbitrary code to prod; it can only roll back to a known-good tag or propose a PR for review.
