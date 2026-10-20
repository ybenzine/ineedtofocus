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
infra/                Docker Compose (local + prod), Caddy, OpenTelemetry Collector, Grafana exports, server setup
scripts/              Repo tooling (backlog publishing, board helpers, traffic generator)
_docs/                Project documentation (kept separate from code)
.claude/agents/       Claude Code subagent definitions for the agent team
.github/              Workflows, PR template
```

Folders appear as their issues land (#1 scaffolds them).

## Commands

All entry points go through `make` (introduced by #1):

| Command | Does |
|---|---|
| `make up` | Start the full local stack (app, Postgres, Grafana/OTel) with Docker Compose |
| `make down` | Stop it |
| `make test` | Run every test suite: backend unit + integration, frontend unit, Playwright end-to-end |
| `make lint` | Linters and type checks for backend and frontend |
| `make fmt` | Auto-format |

## Conventions

- **Work only from an issue.** One issue per branch and per PR. Branch: `<agent>/<issue>-<slug>`, e.g. `backend/10-sessions-api`.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`), referencing the issue (`Refs #10`).
- **Never push to `main`.** Everything lands through a squash-merged PR that says `Closes #<n>`.
- **Acceptance criteria are the contract.** If an AC is wrong or missing, stop and ask the spec agent to update `product_decisions.md` and the issue — don't silently change scope.
- **Python:** 3.12, type hints everywhere, `ruff` + `mypy`, `pytest`. **TypeScript:** `strict`, ESLint + Prettier, Vitest.
- **Time:** store UTC in the database; convert to the user's time zone only for display and history grouping.
- **Migrations:** backward-compatible only (expand first, contract later).
- **Secrets:** never in git. Use `.env` (ignored) and document variables in `.env.example`.
- **Telemetry privacy:** never send emails, passwords, cookies, session goals or YouTube links to logs, traces or metrics. See [_docs/observability.md](_docs/observability.md).
- **Tests come with the change.** A PR without tests for new behavior is not done.

## Humans in the loop

Yacine is the product owner. Issues labeled `owner:human` (DigitalOcean, DNS, Grafana Cloud, secrets) need him: agents prepare exact instructions on the issue and wait. Production deploys require his approval.
