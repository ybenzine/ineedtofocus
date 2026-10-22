# Deployment

> **Status: outline.** Filled in by the DevOps agent with #25–#30. The plan is in [tech_stack.md §2–3](tech_stack.md).

## Environments

| Env | URL | Deployed | Compose project |
|---|---|---|---|
| Local | http://localhost:8000 | `make up` | `focus-local` |
| Dev | https://dev.ineedtofoc.us | Automatically on merge to `main` | `focus-dev` |
| Prod | https://ineedtofoc.us | Manual workflow run with Yacine's approval | `focus-prod` |

## App image and migrations

One image (root `Dockerfile`, #4) serves the API and the built frontend. Its entrypoint (`infra/app/entrypoint.sh`) runs `alembic upgrade head` and then starts the server. A failed migration exits non-zero, so the container never serves on a schema it doesn't expect.

| `MIGRATE_ON_START` | Behaviour | Use |
|---|---|---|
| `1` (default) | Migrate, then start | Local stack (`make up`) |
| `0` | Skip migrations and start (logs that it skipped) | Deploys and rollbacks |

The default doesn't suit rollbacks: an older image started against a database that a newer image migrated fails with `Can't locate revision …` and never serves. Migrations are expand-only (`backend/tests/unit/test_migration_safety.py`), so the older app runs fine on the newer schema once the step is skipped. Deploys (#27–#30) should therefore run migrations as their own one-shot step, e.g. `docker compose run --rm app alembic upgrade head`, and run the app with `MIGRATE_ON_START=0`. That way a rollback only swaps the image tag.

## Sections to write

- Server setup (Droplet, firewall, deploy user) — #25
- DNS (Route 53) — #26
- Images and production Compose — #27
- Deploy to dev — #28
- Deploy to prod — #29
- Health checks, auto-revert and rollback — #30
- Credential separation — prod key and secrets only in the `production` environment; dev and rollback keys restricted by SSH forced commands (see [process.md](process.md#human-gates)) — #28–#30
