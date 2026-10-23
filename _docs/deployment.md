# Deployment

> **Status: in progress.** Server setup is scripted (#25) and the images and production Compose are defined (#27); the rest is filled in by the DevOps agent with #26, #28–#30. The plan is in [tech_stack.md §2–3](tech_stack.md).

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

The default doesn't suit rollbacks: an older image started against a database that a newer image migrated fails with `Can't locate revision …` and never serves. Migrations are expand-only (`backend/tests/unit/test_migration_safety.py`), so the older app runs fine on the newer schema once the step is skipped. Deploys therefore run migrations as their own one-shot step (`infra/compose.sh <env> run --rm app alembic upgrade head`), and `infra/compose.prod.yml` runs the app with `MIGRATE_ON_START=0` ([Running it on the server](#running-it-on-the-server)). That way a rollback only swaps the image tag.

## Server setup (#25)

One DigitalOcean Droplet runs both environments ([tech_stack.md §2](tech_stack.md#2-environments-and-hosting)): Basic 2 GiB / 1 vCPU, Ubuntu 24.04 LTS, NYC, IPv4 `159.223.188.176`. A DigitalOcean Cloud Firewall allows only 22, 80 and 443.

### Done by hand in DigitalOcean (Yacine)

- Created the Droplet with his SSH key, and the Cloud Firewall (inbound 22, 80, 443 only).
- Root SSH login is disabled; he logs in as `yacine` (sudo) with his own key. That key stays his: it's never added to GitHub or to the `deploy` user.
- Created `/opt/focus/prod/.env` and `/opt/focus/dev/.env` (variables in `.env.example`; real values only on the server).

### Scripted: `infra/server/bootstrap.sh`

The script does everything else. It needs root, and root can't log in over SSH, so copy it over and run it with sudo:

```bash
scp infra/server/bootstrap.sh yacine@159.223.188.176:/tmp/focus-bootstrap.sh
ssh -t yacine@159.223.188.176 'sudo bash /tmp/focus-bootstrap.sh'
```

`-t` gives sudo a terminal for its password prompt. If `yacine` has passwordless sudo, piping works too: `ssh yacine@159.223.188.176 'sudo bash -s' < infra/server/bootstrap.sh`. Don't combine the pipe with `-t`: sudo would read the script's first line as the password.

What it does, in order:

| Step | Result |
|---|---|
| Checks | Refuses to run unless it's root on Ubuntu 24.04, or if Ubuntu's `docker.io`/`podman-docker` is installed (they conflict with `docker-ce`) |
| Base packages | Installs any of `ca-certificates curl gnupg openssh-server unattended-upgrades` that are missing |
| Docker Engine + Compose plugin | Adds Docker's apt repo (`/etc/apt/sources.list.d/docker.sources`), with its signing key checked against the published fingerprint `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`. Installs `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`. `/etc/docker/daemon.json` rotates container logs (3 × 10 MB per container) and turns on `live-restore`, so containers keep running while dockerd restarts or is upgraded |
| Unattended security upgrades | `/etc/apt/apt.conf.d/20auto-upgrades` refreshes package lists and runs `unattended-upgrade` daily. Ubuntu's own `50unattended-upgrades` limits that to the `-security` pocket (and ESM). `52focus-unattended-upgrades` turns automatic reboots off and removes unused kernels. Enables `unattended-upgrades.service` and the `apt-daily` timers |
| `deploy` user | For CI only. No usable password (`*`), shell `/bin/bash` (needed to run forced commands), member of `docker`, **no sudo**: the script removes it from `sudo`/`admin` and stops if a sudoers rule names it. Its keys live in `/etc/ssh/authorized_keys/deploy`, owned by `root:deploy`, mode 640, so the account can't add keys of its own. The script creates that file once, empty apart from a comment showing the format, and never changes it afterwards. It warns about any key line without `restrict,command=…` |
| SSH hardening | `/etc/ssh/sshd_config.d/00-focus-hardening.conf`: `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`. Named `00-` because the first value wins, so it beats cloud-init's `50-cloud-init.conf`. A `Match User deploy` block reads keys from `/etc/ssh/authorized_keys/%u` (not `~deploy/.ssh`) and turns off PTYs, forwarding, tunnels and `~/.ssh/rc`. The new file is checked with `sshd -t` before sshd reloads; if the check fails, the previous file is put back and the script stops. Open sessions aren't affected |
| `/opt/focus` layout | `/opt/focus` (root, 755); `/opt/focus/bin` (root, 755) for the forced-command scripts (#28–#30), root-owned so `deploy` can't change what its own keys run; `/opt/focus/prod` and `/opt/focus/dev` (`deploy`, 750) with their `.env` files set to `deploy`, 600. The `.env` contents are never read or changed; a missing one is a warning |

The `docker` group is root-equivalent. That's acceptable only because no `deploy` key can open a shell: each one is pinned to a root-owned forced command.

**Re-running is safe.** The script only writes files whose content differs, installs only missing packages (it never upgrades installed ones), and leaves the `.env` contents and the deploy keys alone. A second run on a configured server changes nothing. Re-run it after changing it in the repo.

### Verify

Keep the current SSH session open and check from a **new** terminal that you can still log in (`ssh yacine@159.223.188.176`). Then:

```bash
id deploy                                             # groups: deploy docker (no sudo)
sudo -l -U deploy                                     # "deploy is not allowed to run sudo"
docker --version && docker compose version
systemctl is-active docker unattended-upgrades        # active, active
apt-config dump | grep -E 'Periodic::(Update-Package-Lists|Unattended-Upgrade) '   # "1" each
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '   # all "no"
sudo stat -c '%n %a %U:%G' /etc/ssh/authorized_keys/deploy /opt/focus/{prod,dev}/.env   # 640 root:deploy; 600 deploy:deploy
ssh root@159.223.188.176                              # from your machine: Permission denied (publickey)
```

### CI keys (#28–#30)

Each GitHub environment gets its own key pair. The private key goes into that environment's secrets; the public key goes on one line of `/etc/ssh/authorized_keys/deploy` (edit with `sudo`), always restricted to a forced command in `/opt/focus/bin`:

```
restrict,command="/opt/focus/bin/<command>" ssh-ed25519 AAAA... focus-ci-<environment>
```

`restrict` turns off PTYs and forwarding for that key; `command=` makes sshd run that script whatever the client asks for (the client's request is in `$SSH_ORIGINAL_COMMAND`). The scripts and keys themselves are part of #28 (dev), #29 (prod) and #30 (rollback).

### Upkeep

- **Security updates** install themselves daily. Docker's packages come from Docker's repo, which unattended-upgrades doesn't touch: upgrade them by hand at a quiet time with `sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin` (`live-restore` keeps the containers up).
- **Reboots** aren't automatic, because prod and dev share the server. When a kernel or libc update needs one, `/var/run/reboot-required` exists and the login banner says so (the script's summary warns too). Reboot at a quiet time with `sudo reboot`; containers restart through their restart policy (#27).

## Images and production Compose (#27)

### Layout on the Droplet

Three Compose projects ([tech_stack.md §2](tech_stack.md#2-environments-and-hosting)). Ports 80 and 443 reach only Caddy; nothing else publishes a port.

```
                             :80, :443
                                 |
                 focus-edge   caddy  (infra/compose.edge.yml)
                  172.16.10.2 /     \ 172.16.20.2
          network focus-edge_prod   focus-edge_dev
                             /       \
        focus-prod   app (focus-prod-app)   focus-dev   app (focus-dev-app)
                     db, otel-collector                 db, otel-collector
                     volume focus-prod_db-data          volume focus-dev_db-data
```

| File | Role |
|---|---|
| `infra/compose.edge.yml` + `infra/caddy/Caddyfile` | Project `focus-edge`: one Caddy. Automatic HTTPS from Let's Encrypt for `ineedtofoc.us` and `dev.ineedtofoc.us`; certificates persist in the `caddy-data` volume. http redirects to https. HTTP/1.1 and HTTP/2 only, since the firewall doesn't open 443/udp. Owns both edge networks, so start it first |
| `infra/compose.prod.yml` | One file, run as `focus-prod` and as `focus-dev`. Each project has an app, Postgres 17 with a named volume, and an OpenTelemetry Collector. Only the app joins its environment's edge network, under the alias Caddy routes to. Dev's app can't reach prod's |
| `infra/env/prod.env`, `infra/env/dev.env` | Committed, non-secret settings per environment: memory limits, OOM score, CPU weight, Postgres `shared_buffers`, edge network, Caddy's address |
| `/opt/focus/<env>/.env` (server only) | That environment's secrets: `POSTGRES_PASSWORD` and, from #32, the `GRAFANA_CLOUD_*` values ([.env.example](../.env.example), "Deployed environments") |
| `infra/compose.sh` | `APP_TAG=<sha> infra/compose.sh prod\|dev <compose args>`: passes `-f infra/compose.prod.yml --env-file /opt/focus/<env>/.env --env-file infra/env/<env>.env`. The committed file comes last, so its values win over anything in the server file |

Compose refuses to start an environment without `APP_TAG`, `POSTGRES_PASSWORD` or any committed setting. All containers use `restart: unless-stopped`, so they come back after a reboot.

### Memory: dev can't starve prod

| Container | prod | dev |
|---|---|---|
| app | 320 MiB | 256 MiB |
| Postgres (`shared_buffers`) | 256 MiB (64 MB) | 128 MiB (32 MB) |
| OpenTelemetry Collector | 96 MiB | 96 MiB |
| Caddy (shared) | 96 MiB | |

The limits add up to 1,248 MiB. Adding a one-shot migration container (up to 320 MiB) gives 1,568 MiB, under the 1,600 MiB budget that leaves about 350 MiB of the 2 GiB Droplet to the kernel, dockerd, containerd and sshd. So the limits never overcommit the host. Dev's containers also get `oom_score_adj: 500`, so the kernel kills them first if memory runs out anyway, and a quarter of prod's CPU weight (`cpu_shares` 256 against 1024). The collectors run with `GOMEMLIMIT` and a `memory_limiter` at 80% of their limit. `make test-infra` fails if the limits break these rules (`scripts/check_prod_compose.py`).

### Image build and publish

One image (root `Dockerfile`, multi-stage: Vite build, locked uv dependencies, slim non-root runtime) serves the API and the built frontend. `.github/workflows/ci.yml` has two jobs for it besides the five required checks:

- **`image`** (every PR and push) runs `make test-infra`, builds the image as `ghcr.io/ybenzine/ineedtofocus:<sha>`, and runs `make test-prod-stack` on it: the real edge, prod and dev projects, with Caddy on its internal CA ([testing.md](testing.md)). On `main` it keeps the tested image as a one-day artifact.
- **`publish`** (push to `main` only) pushes that same image, tagged with the commit SHA only (no `latest`). It `needs:` the five required jobs and `image`, so only a commit that passed all of CI is published. It's the only job with `packages: write`, using `GITHUB_TOKEN` (no stored secret), and it checks out no code. Pull requests, forks included, never push, and no tag or release trigger publishes anything.

**Dev deploy hook (#28):** add a `deploy-dev` job with `needs: publish`, or a workflow triggered by `workflow_run` on `CI` that checks `conclusion == 'success'` and deploys `github.event.workflow_run.head_sha`. Either way, a red `main` never reaches dev.

### Running it on the server

The server needs this repo's `infra/` directory. How it gets there, and how it is kept root-owned so a deploy key can't change what runs, is for #28. These are the steps the deploy and rollback scripts (#28–#30) will run, in this order:

```bash
docker compose -f infra/compose.edge.yml up -d --wait          # once, and after Caddyfile changes
export APP_TAG=<commit sha>
infra/compose.sh dev pull app                                   # public package: no login needed
infra/compose.sh dev run --rm app alembic upgrade head          # one-shot migration
infra/compose.sh dev up -d --wait                               # app starts with MIGRATE_ON_START=0
curl -fsS https://dev.ineedtofoc.us/healthz && curl -fsS https://dev.ineedtofoc.us/readyz
```

A rollback is the same `up -d --wait` with the previous tag and no migration step, because migrations are expand-only (see [App image and migrations](#app-image-and-migrations)). To reload Caddy after a Caddyfile change without dropping connections: `docker compose -f infra/compose.edge.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`.

### App settings fixed by the Compose file

- `COOKIE_SECURE=1`: the session cookie is always `Secure` (#8). It isn't read from the server `.env`, so a `COOKIE_SECURE=0` copied there from the local defaults has no effect. The smoke test signs in through Caddy and checks `Secure; HttpOnly; SameSite=Lax`.
- `MIGRATE_ON_START=0`: deploys migrate as their own step.
- `uvicorn --proxy-headers` (image CMD) with `FORWARDED_ALLOW_IPS` set to Caddy's fixed address on that environment's edge network (`172.16.10.2` prod, `172.16.20.2` dev), never `*`. The app therefore takes `X-Forwarded-For`/`-Proto` only from Caddy, and Caddy overwrites whatever a client sends. The sign-in rate limiter sees the real client address, and a request that doesn't come through Caddy can't spoof one. The smoke test checks both.
- `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>,service.version=<sha>`, so telemetry shows which deploy produced it.

### Telemetry to Grafana Cloud

Each environment's app sends OTLP to its own collector (`infra/otel-collector/config.yaml`). The collector adds `deployment.environment.name` and forwards to Grafana Cloud over OTLP/HTTP with basic auth. It does that once `GRAFANA_CLOUD_OTLP_ENDPOINT`, `GRAFANA_CLOUD_INSTANCE_ID` and `GRAFANA_CLOUD_OTLP_TOKEN` are in `/opt/focus/<env>/.env`, which #32 does. While the endpoint is empty, the collector accepts the data and drops it, so deploys don't depend on Grafana Cloud. The token is never in git or in GitHub secrets. After changing these values, recreate the collector: `APP_TAG=<current tag> infra/compose.sh <env> up -d otel-collector`. Whether one collector per environment stays, or a shared one replaces it, is #32's call.

### Human steps (Yacine)

1. **After the first image is published** (the first push to `main` after this lands), make the package public. A new package in a personal account starts out private, so the server couldn't pull it without a token. On github.com, go to your profile → **Packages** → `ineedtofocus` → **Package settings**. Under **Danger Zone**, choose **Change visibility** → **Public**, then type `ineedtofocus` to confirm. If it already shows Public, there's nothing to do. The repository is public already. Under **Manage Actions access** on the same page, `ybenzine/ineedtofocus` should be listed: the workflow that created the package gets access automatically. If it isn't listed, add it with the **Write** role.
2. **Before the first deploy (#28)**, put `POSTGRES_PASSWORD=<openssl rand -hex 32>` in both `/opt/focus/prod/.env` and `/opt/focus/dev/.env`, with a different value in each. Keep the files at mode 600, owner `deploy`. Anything else copied from `.env.example`'s local sections has no effect there.
3. **With #32**, add the three `GRAFANA_CLOUD_*` values to both files.

## Sections to write

- DNS (Route 53) — #26
- Deploy to dev — #28
- Deploy to prod — #29
- Health checks, auto-revert and rollback — #30
- Credential separation — prod key and secrets only in the `production` environment; dev and rollback keys restricted by SSH forced commands (see [process.md](process.md#human-gates)) — #28–#30
