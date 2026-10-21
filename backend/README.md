# Backend

FastAPI app (Python 3.12, managed with [uv](https://docs.astral.sh/uv/)).

## Run

```sh
make up                  # from the repo root: Postgres (and Grafana) via Docker Compose
cd backend
uv sync
uv run alembic upgrade head                              # or `make migrate` from the root
uv run uvicorn app.main:app_factory --factory --reload   # http://localhost:8000
```

Settings come from environment variables (documented in the root `.env.example`):
`DATABASE_URL` (async URL, `postgresql+asyncpg://...`), `LOG_LEVEL`, `FRONTEND_DIST`
(built frontend, default `../frontend/dist`; ignored when absent) and
`READINESS_TIMEOUT_SECONDS`.

- `GET /healthz`: process is up. `GET /readyz`: database reachable (503 otherwise).
- Interactive API docs: `/docs`. If `frontend/dist` exists it is served from `/`.

## Develop

```sh
uv run pytest            # tests (tests/unit; tests/integration needs the db from `make up`)
uv run ruff check .      # lint
uv run ruff format .     # format
uv run mypy              # type-check (strict)
```

From the repo root, `make test` / `make lint` / `make fmt` run these for you. Integration tests skip with a reason when no database is reachable.
