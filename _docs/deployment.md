# Deployment

> **Status: outline.** Filled in by the DevOps agent with #25–#30. The plan is in [tech_stack.md §2–3](tech_stack.md).

## Environments

| Env | URL | Deployed | Compose project |
|---|---|---|---|
| Local | http://localhost:8000 | `make up` | `focus-local` |
| Dev | https://dev.ineedtofoc.us | Automatically on merge to `main` | `focus-dev` |
| Prod | https://ineedtofoc.us | Manual workflow run with Yacine's approval | `focus-prod` |

## Sections to write

- Server setup (Droplet, firewall, deploy user) — #25
- DNS (Route 53) — #26
- Images and production Compose — #27
- Deploy to dev — #28
- Deploy to prod — #29
- Health checks, auto-revert and rollback — #30
- Credential separation — prod key and secrets only in the `production` environment; dev and rollback keys restricted by SSH forced commands (see [process.md](process.md#human-gates)) — #28–#30
