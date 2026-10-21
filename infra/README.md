# infra

Deployment and runtime configuration. The local development stack is `compose.yaml` at the repo root (so `docker compose up` works from there); everything for the server lives here as its issues land:

| Path (planned) | What | Issue |
|---|---|---|
| `server/` | Droplet setup: deploy user, firewall, Docker | #25 |
| `compose.prod.yaml` | `focus-prod` / `focus-dev` Compose projects (app + Postgres, memory limits) | #27 |
| `caddy/` | Shared Caddy reverse proxy, HTTPS for both host names | #27 |
| `otel-collector/` | OpenTelemetry Collector forwarding to Grafana Cloud | #31, #32 |
| `grafana/` | Exported dashboards and alert rules | #32, #33 |

See [_docs/deployment.md](../_docs/deployment.md) and [_docs/tech_stack.md §2–4](../_docs/tech_stack.md).
