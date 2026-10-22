# I Need To Focus

A calm, mobile-friendly focus timer: countdown, Pomodoro and unlimited modes, rain or YouTube in the background, and a history of where your focus time went — by day, week, month, all time or any range, filtered by tag.

Built for the AI Dev Tools Zoomcamp project: one app taken from spec to production with an agent team, CI/CD, observability and an on-call agent.

- **Production:** https://ineedtofoc.us
- **Dev:** https://dev.ineedtofoc.us
- **Task board:** https://github.com/users/ybenzine/projects/2
- **Product decisions and acceptance criteria:** [_docs/product_decisions.md](_docs/product_decisions.md)
- **Tech stack and delivery plan:** [_docs/tech_stack.md](_docs/tech_stack.md)
- **Backlog source:** [_docs/backlog/backlog.yaml](_docs/backlog/backlog.yaml), published to GitHub Issues with [scripts/create_backlog.py](scripts/create_backlog.py)

## Run it locally

Needs Docker with Compose v2. For tests and linters, also [uv](https://docs.astral.sh/uv/) and Node.js 24 (see the `Makefile` header).

```sh
cp .env.example .env    # optional: change ports or local credentials
make up                 # build the app image, start everything, wait until healthy
```

`make up` runs `docker compose up -d --build --wait` (`compose.yaml`) and starts:

| Service | What | Where |
|---|---|---|
| `app` | FastAPI API plus the built frontend, one image (`Dockerfile`) | http://localhost:8000 · `GET /healthz` (process), `GET /readyz` (database) |
| `db` | PostgreSQL 17; data in the named volume `db-data` | `localhost:5432`, user/password/db `focus` |
| `lgtm` | Grafana with Tempo, Prometheus and Loki (`grafana/otel-lgtm`) | http://localhost:3000 (no login) · OTLP on 4317/4318 |

- **Start order:** the app container starts only once Postgres passes its health check (`pg_isready`). It first applies the database migrations (`alembic upgrade head`), then starts the server, and Compose marks it healthy when `GET /healthz` answers. If a migration fails, the server doesn't start and `make up` fails: see `docker compose logs app`. Setting `MIGRATE_ON_START=0` in `.env` skips the step (see [deployment.md](_docs/deployment.md#app-image-and-migrations)).
- **Data:** `make down` stops the stack and keeps the database. To wipe it, run `docker compose down -v`, which deletes the volume.
- **Telemetry:** the app runs under `opentelemetry-instrument` and sends traces (one per request, except `/healthz`), HTTP metrics and its JSON logs over OTLP to `lgtm`. In Grafana, open **Explore** and pick **Tempo**, **Prometheus** or **Loki**, filtering on service `ineedtofocus`. Query strings and cookies are stripped from traces. Logs sent to Grafana get the same scrubbing as stdout, which includes Postgres `DETAIL` lines with row values.
- **Check it:** `make check-stack` probes the health endpoints and the frontend. It then waits until Grafana has traces, metrics and logs from the app, and fails if a query string or cookie reached telemetry.
- **Ports taken?** Set `APP_PORT`, `POSTGRES_PORT`, `GRAFANA_PORT`, `OTLP_GRPC_PORT` or `OTLP_HTTP_PORT` in `.env`.
- **Other commands:** `make logs` (follow all logs), `make test`, `make lint`, `make help`. The backend integration tests use the `db` from `make up`.

For backend work with hot reload, run only the database with `docker compose up -d db`, then follow [backend/README.md](backend/README.md).

> Work in progress — the full README (how to run, test, deploy, and the grading-criteria map) is tracked as an issue on the board.
