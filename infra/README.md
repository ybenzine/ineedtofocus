# infra

Deployment and runtime configuration. The local development stack is `compose.yaml` at the repo root (so `docker compose up` works from there); everything for the server lives here as its issues land:

| Path | What | Issue |
|---|---|---|
| `server/` | Droplet setup script `bootstrap.sh`: Docker Engine + Compose, unattended security upgrades, SSH hardening, the `deploy` user, `/opt/focus` layout ([deployment.md → Server setup](../_docs/deployment.md#server-setup-25)); tested by `make test-server` | #25 |
| `compose.prod.yml` | The deployed environments: one file run as the `focus-prod` and `focus-dev` Compose projects. Each has its own app (image `ghcr.io/ybenzine/ineedtofocus:<sha>`), Postgres with a named volume, and OpenTelemetry Collector, all with memory limits | #27 |
| `env/prod.env`, `env/dev.env` | Committed, non-secret settings per environment: memory limits, OOM score, CPU weight, edge network, Caddy's address for proxy trust. Secrets stay in `/opt/focus/<env>/.env` on the server | #27 |
| `compose.sh` | `APP_TAG=<sha> infra/compose.sh prod\|dev <compose args>`: runs Compose for one environment with the right files in the right order. The deploy and rollback scripts (#28–#30) are meant to call it | #27 |
| `compose.edge.yml`, `caddy/Caddyfile` | The shared edge (`focus-edge`): one Caddy with automatic HTTPS, routing `ineedtofoc.us` to prod and `dev.ineedtofoc.us` to dev. It owns one edge network per environment | #27 |
| `otel-collector/` | Collector config: OTLP in, Grafana Cloud out (`export.grafana-cloud.yaml`) once the server `.env` has the `GRAFANA_CLOUD_*` values (#32), accept-and-drop (`export.yaml`) until then | #27, #32 |
| `tests/` | `check_config.sh` (`make test-infra`: config validation and deploy rules) and `prod_stack.sh` (`make test-prod-stack`: the whole stack, smoke-tested) | #27 |
| `app/` | The app image's entrypoint (migrate, then serve) | #4 |
| `grafana/` (planned) | Exported dashboards and alert rules | #32, #33 |
| `github/` | GitHub repository settings kept as code: branch protection on `main` ([README](github/README.md)) | #5 |

How the pieces fit, and how to run them on the server: [_docs/deployment.md → Images and production Compose](../_docs/deployment.md#images-and-production-compose-27).

See [_docs/deployment.md](../_docs/deployment.md) and [_docs/tech_stack.md §2–4](../_docs/tech_stack.md).
