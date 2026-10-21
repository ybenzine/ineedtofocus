# AGENTS.md

Entry point for every coding agent (and human) working in this repo. Keep this file short; details live in the linked docs.

## Project

**I Need To Focus** — a mobile-first, installable web app for focus sessions: countdown, Pomodoro and unlimited timers, rain or YouTube background audio, tags and goals, and a history of focus time by day, week, month, all time or custom range. Built for the AI Dev Tools Zoomcamp: one app taken from spec to production with an agent team, CI/CD, observability and an on-call agent.

- Production: https://ineedtofoc.us · Dev: https://dev.ineedtofoc.us
- Task board: https://github.com/users/ybenzine/projects/2 (GitHub Issues in this repo)

## Read before you start

| Doc | What it is | Read when |
|---|---|---|
| [_docs/product_decisions.md](_docs/product_decisions.md) | Requirements and acceptance criteria (`F1`–`F13`, `ACx.y`) — **source of truth for scope** | Always |
| [_docs/tech_stack.md](_docs/tech_stack.md) | Stack, hosting, CI/CD, observability, on-call plan — **source of truth for technology** | Always |
| [_docs/process.md](_docs/process.md) | Issue → branch → PR → review → merge workflow, definition of done, tracker rules | Always |
| [_docs/agents.md](_docs/agents.md) | The agent team, ownership, hand-offs | Always |
| [_docs/architecture.md](_docs/architecture.md) | Components, data model, API contract | Writing code |
| [_docs/testing.md](_docs/testing.md) | Test layers, commands, what to test | Writing code or tests |
| [_docs/deployment.md](_docs/deployment.md) | Environments, deploy, rollback | Touching CI/CD or infra |
| [_docs/observability.md](_docs/observability.md) | Metrics, traces, logs, alerts, telemetry privacy | Touching instrumentation |
| [_docs/runbooks/](_docs/runbooks/) | Incident runbooks | On call |

## Repository layout

```
backend/              FastAPI app, SQLAlchemy models, Alembic migrations, pytest tests
frontend/             React + TypeScript (Vite) installable web app, Vitest + Playwright tests
infra/                Prod/dev Compose, Caddy, OpenTelemetry Collector, Grafana exports, server setup
scripts/              Repo tooling (backlog publishing, board helpers, traffic generator)
_docs/                Project documentation (kept separate from code)
.claude/agents/       Claude Code subagent definitions for the agent team
.github/              Workflows, PR template
compose.yaml          Local stack (`make up` / `docker compose up -d` from the repo root)
Makefile              Every entry point below
.env.example          Every environment variable, with local defaults (copy to `.env`)
```

Folders fill in as their issues land.

## Commands

All entry points go through `make` (`make help` lists them). Needs Docker with Compose v2, [uv](https://docs.astral.sh/uv/) and Node.js ≥ 22.

| Command | Does |
|---|---|
| `make install` | Install backend (uv) and frontend (npm) dependencies; the other targets do this on demand |
| `make up` | Start the full local stack (app, Postgres, Grafana/OTel) with Docker Compose |
| `make down` | Stop it (keeps the database volume) |
| `make test` | Run every test suite: backend unit + integration, frontend unit, Playwright end-to-end |
| `make lint` | Linters and type checks for backend (ruff, mypy) and frontend (ESLint, Prettier, tsc) |
| `make fmt` | Auto-format |
| `make hooks` | Install the pre-commit hooks (ruff, ESLint, Prettier, hygiene checks) |

## Conventions

- **Work only from an issue.** One issue per branch and per PR. Branch: `<agent>/<issue>-<slug>`, e.g. `backend/10-sessions-api`.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`), referencing the issue (`Refs #10`).
- **Never push to `main`.** Everything lands through a squash-merged PR that says `Closes #<n>`.
- **Run git from the repo root** (`cd` into the repo), not `git -C <path>` — the permission rules in `.claude/settings.json` only recognise the plain form.
- **Acceptance criteria are the contract.** If an AC is wrong, missing or ambiguous, ask the product manager agent on the issue — it decides or escalates — don't silently change scope.
- **Python:** 3.12, type hints everywhere, `ruff` + `mypy`, `pytest`. **TypeScript:** `strict`, ESLint + Prettier, Vitest.
- **Time:** store UTC in the database; convert to the user's time zone only for display and history grouping.
- **Migrations:** backward-compatible only (expand first, contract later).
- **Secrets:** never in git. Use `.env` (ignored) and document variables in `.env.example`.
- **Telemetry privacy:** never send emails, passwords, cookies, session goals or YouTube links to logs, traces or metrics. See [_docs/observability.md](_docs/observability.md).
- **Tests come with the change.** A PR without tests for new behavior is not done.

## Humans in the loop

Yacine is the product owner. The team works through the backlog on its own (`/work-backlog`) and involves him only at the [human gates](_docs/process.md#human-gates): production deploys, `owner:human` tasks (DigitalOcean, DNS, Grafana Cloud, secrets), decisions beyond agreed scope, cost, irreversible actions, and repeated failure. For those, agents post `⛔ Needs Yacine:` with the exact ask on the issue and keep working on other issues.
