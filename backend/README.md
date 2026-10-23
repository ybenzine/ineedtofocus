# Backend

FastAPI app (Python 3.12, managed with [uv](https://docs.astral.sh/uv/)).

## Run

```sh
docker compose up -d db  # from the repo root: just Postgres (`make up` also runs the app on :8000)
cd backend
uv sync
uv run alembic upgrade head                              # or `make migrate` from the root
COOKIE_SECURE=0 uv run uvicorn app.main:app_factory --factory --reload   # http://localhost:8000
```

Settings come from environment variables only (documented in the root `.env.example`); the
app never reads a `.env` file, so set them in the shell as above. They are `DATABASE_URL`
(async URL, `postgresql+asyncpg://...`), `LOG_LEVEL`, `FRONTEND_DIST` (built frontend,
default `../frontend/dist`; ignored when absent), `READINESS_TIMEOUT_SECONDS`,
`COOKIE_SECURE`, `SESSION_TTL_DAYS` and the `SIGNIN_*` and `SIGNUP_*` rate limits. `COOKIE_SECURE`
defaults to on, which plain http can't use (browsers and curl drop `Secure` cookies), so a
local host run needs `COOKIE_SECURE=0` to sign in; `compose.yaml` sets it for `make up`.

- `GET /healthz`: process is up. `GET /readyz`: database reachable (503 otherwise).
- Interactive API docs: `/docs`. If `frontend/dist` exists it is served from `/`.
- Telemetry: the container image runs `opentelemetry-instrument uvicorn ...`, configured by the
  standard `OTEL_*` env vars (see `compose.yaml`); FastAPI's built-in telemetry then traces and
  meters requests. `app/telemetry.py` holds its settings (no `/healthz` traces) and a span
  processor that redacts query strings. Run directly with `uvicorn`, the app sends no telemetry.

## Develop

```sh
uv run pytest            # tests (tests/unit; tests/integration needs the db from `make up`)
uv run ruff check .      # lint
uv run ruff format .     # format
uv run mypy              # type-check (strict)
```

From the repo root, `make test` / `make lint` / `make fmt` run these for you. Integration tests skip with a reason when no database is reachable.
