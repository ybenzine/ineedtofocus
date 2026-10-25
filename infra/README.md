# infra

Deployment and runtime configuration. The local development stack is `compose.yaml` at the repo root (so `docker compose up` works from there); everything for the server lives here as its issues land:

| Path | What | Issue |
|---|---|---|
| `server/bootstrap.sh` | Droplet setup script: Docker Engine + Compose, unattended security upgrades, SSH hardening, the `deploy` user, `/opt/focus` layout ([deployment.md → Server setup](../_docs/deployment.md#server-setup-25)) | #25 |
| `server/install.sh` | Installs `infra/` at a commit on `main`, root-owned, into `/opt/focus/infra`, plus the forced command; starts and updates the edge. Run by Yacine with sudo, never by CI ([deployment.md → Infra on the server](../_docs/deployment.md#infra-on-the-server-installsh)) | #28 |
| `server/focus-ci.sh` | The forced command every CI deploy key is pinned to (`/opt/focus/bin/focus-ci <profile>`). Profile `dev`: `deploy <sha> sha256:<digest>`, `rollback [<sha>]`, `status`. Profile `prod`: `deploy` (only a sha and digest dev ran successfully and didn't roll back from), `status`, and the read-only `candidate [<sha>]`. Profile `rollback-prod` (the prod rollback key): `rollback [<sha>]` and `status` only. `rollback` restores a known-good release by its recorded digest, without migrating. A deploy whose checks fail after the start reverts to the release before it. Nothing else; clean environment, deploy lock, release record ([deployment.md → Deploy to dev](../_docs/deployment.md#deploy-to-dev-28), [Deploy to prod](../_docs/deployment.md#deploy-to-prod-29), [Rollback](../_docs/deployment.md#rollback-rollbackyml)) | #28, #29, #30 |
| `server/tests/` | `make test-server`: bootstrap in an Ubuntu container, then the installer and the forced command (dev, prod and prod rollback keys) behind the real sshd with a fake docker that models missing images, including deliberately broken images for the automatic revert | #25, #28, #29, #30, #170 |
| `compose.prod.yml` | The deployed environments: one file run as the `focus-prod` and `focus-dev` Compose projects. Each has its own app (image `ghcr.io/ybenzine/ineedtofocus:<sha>`), Postgres with a named volume, and OpenTelemetry Collector, all with memory, process and privilege limits (the app and the collector on a read-only root filesystem) | #27, #117 |
| `env/prod.env`, `env/dev.env` | Committed, non-secret settings per environment: memory limits, OOM score, CPU weight, edge network, Caddy's address for proxy trust. Secrets stay in `/opt/focus/<env>/.env` on the server | #27 |
| `compose.sh` | `APP_TAG=<sha> infra/compose.sh prod\|dev <compose args>`: runs Compose for one environment with the right files in the right order. `server/focus-ci.sh` calls it with a clean environment | #27 |
| `compose.edge.yml`, `caddy/Caddyfile` | The shared edge (`focus-edge`): one Caddy with automatic HTTPS, routing `ineedtofoc.us` to prod and `dev.ineedtofoc.us` to dev. It owns one edge network per environment | #27 |
| `otel-collector/` | Collector config: OTLP in, Grafana Cloud out (`export.grafana-cloud.yaml`) once the server `.env` has the `GRAFANA_CLOUD_*` values (#32), accept-and-drop (`export.yaml`) until then | #27, #32 |
| `tests/` | `check_config.sh` (`make test-infra`: config validation and deploy rules) and `prod_stack.sh` (`make test-prod-stack`: the whole stack, smoke-tested) | #27 |
| `app/` | The app image's entrypoint (migrate, then serve); `migration_info.py`, which focus-ci feeds to a release's container to read its alembic head and contract migrations (rollback floor) | #4, #165 |
| `grafana/` (planned) | Exported dashboards and alert rules | #32, #33 |
| `github/` | GitHub repository settings kept as code: branch protection on `main` ([README](github/README.md)) | #5 |

How the pieces fit, and how to run them on the server: [_docs/deployment.md → Images and production Compose](../_docs/deployment.md#images-and-production-compose-27).

See [_docs/deployment.md](../_docs/deployment.md) and [_docs/tech_stack.md §2–4](../_docs/tech_stack.md).
