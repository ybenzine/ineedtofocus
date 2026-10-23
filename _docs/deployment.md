# Deployment

> **Status: in progress.** Server setup is scripted (#25), the images and production Compose are defined (#27), and merges to `main` deploy to dev (#28). Prod deploys and rollback are filled in by the DevOps agent with #29 and #30. The plan is in [tech_stack.md §2–3](tech_stack.md).

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

Each GitHub environment gets its own key pair. The private key goes into that environment's secrets; the public key goes on one line of `/etc/ssh/authorized_keys/deploy` (edit with `sudo`), always restricted to the forced command `/opt/focus/bin/focus-ci` with a profile:

```
restrict,command="/opt/focus/bin/focus-ci <profile>" ssh-ed25519 AAAA... focus-ci-<environment>
```

`restrict` turns off PTYs and forwarding for that key; `command=` makes sshd run that script whatever the client asks for (the client's request is in `$SSH_ORIGINAL_COMMAND`). The profile is fixed by this root-owned line, so a key can never pick another one. The `dev` profile is #28's ([Deploy to dev](#deploy-to-dev-28)); #29 (prod) and #30 (rollback) add theirs.

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
| `infra/compose.edge.yml` + `infra/caddy/Caddyfile` | Project `focus-edge`: one Caddy. Automatic HTTPS from Let's Encrypt for `ineedtofoc.us` and `dev.ineedtofoc.us`; certificates persist in the `caddy-data` volume. http redirects to https. HTTP/1.1 and HTTP/2 only, since the firewall doesn't open 443/udp. Owns both edge networks, so start it first. Caddy has a fixed address in the lower half of each subnet; Docker hands the apps addresses from the upper half only (`ip_range` …128/25). An app that starts before Caddy after a reboot therefore can't take Caddy's address |
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

The server runs a root-owned copy of `infra/` in `/opt/focus/infra`, installed by Yacine with `infra/server/install.sh` ([Infra on the server](#infra-on-the-server-installsh)). The deploy keys run only the forced command `/opt/focus/bin/focus-ci`, which runs these steps for one environment ([Deploy to dev](#deploy-to-dev-28)):

```bash
docker pull ghcr.io/ybenzine/ineedtofocus@sha256:<digest>      # public package: no login needed
docker tag ghcr.io/ybenzine/ineedtofocus@sha256:<digest> ghcr.io/ybenzine/ineedtofocus:<sha>
export APP_TAG=<sha>                                            # passed with env -i, nothing else
infra/compose.sh dev run --rm --pull never app alembic upgrade head   # one-shot migration
infra/compose.sh dev up -d --wait --pull never                  # app starts with MIGRATE_ON_START=0
```

A rollback is the same `up -d --wait` with the previous release and no migration step, because migrations are expand-only (see [App image and migrations](#app-image-and-migrations)). The edge (`compose.edge.yml`) is started and updated by `install.sh`, never by a deploy key, because prod shares it.

### App settings fixed by the Compose file

- `COOKIE_SECURE=1`: the session cookie is always `Secure` (#8). It isn't read from the server `.env`, so a `COOKIE_SECURE=0` copied there from the local defaults has no effect. The smoke test signs in through Caddy and checks `Secure; HttpOnly; SameSite=Lax`.
- `MIGRATE_ON_START=0`: deploys migrate as their own step.
- `uvicorn --proxy-headers` (image CMD) with `FORWARDED_ALLOW_IPS` set to Caddy's fixed address on that environment's edge network (`172.16.10.2` prod, `172.16.20.2` dev), never `*`. The app therefore takes `X-Forwarded-For`/`-Proto` only from Caddy, and Caddy overwrites whatever a client sends. The sign-in rate limiter sees the real client address, and a request that doesn't come through Caddy can't spoof one. The smoke test checks both.
- `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>,service.version=<sha>`, so telemetry shows which deploy produced it.

### Telemetry to Grafana Cloud

Each environment's app sends OTLP to its own collector (`infra/otel-collector/config.yaml`). The collector adds `deployment.environment.name` and forwards to Grafana Cloud over OTLP/HTTP with basic auth. It does that once `GRAFANA_CLOUD_OTLP_ENDPOINT`, `GRAFANA_CLOUD_INSTANCE_ID` and `GRAFANA_CLOUD_OTLP_TOKEN` are in `/opt/focus/<env>/.env`, which #32 does. While the endpoint is empty, the collector accepts the data and drops it, so deploys don't depend on Grafana Cloud. The token is never in git or in GitHub secrets. After changing these values, recreate the collector: `APP_TAG=<current tag> infra/compose.sh <env> up -d otel-collector`. Whether one collector per environment stays, or a shared one replaces it, is #32's call.

### Human steps (Yacine)

Both steps 1 and 2 were done on 2026-10-23: the package is Public, so the server pulls anonymously, and each `.env` has its own `POSTGRES_PASSWORD`.

1. **After the first image is published** (the first push to `main` after this lands), make the package public. A new package in a personal account starts out private, so the server couldn't pull it without a token. On github.com, go to your profile → **Packages** → `ineedtofocus` → **Package settings**. Under **Danger Zone**, choose **Change visibility** → **Public**, then type `ineedtofocus` to confirm. If it already shows Public, there's nothing to do. The repository is public already. Under **Manage Actions access** on the same page, `ybenzine/ineedtofocus` should be listed: the workflow that created the package gets access automatically. If it isn't listed, add it with the **Write** role.
2. **Before the first deploy (#28)**, put `POSTGRES_PASSWORD=<openssl rand -hex 32>` in both `/opt/focus/prod/.env` and `/opt/focus/dev/.env`, with a different value in each. Keep the files at mode 600, owner `deploy`. Anything else copied from `.env.example`'s local sections has no effect there.
3. **With #32**, add the three `GRAFANA_CLOUD_*` values to both files.

## Infra on the server: `install.sh`

The deploy keys run Docker, and the `docker` group is root-equivalent. So whoever controls the compose files the keys run controls the whole host, prod included. Those files therefore change only when Yacine installs them. A merge to `main` doesn't change them, and neither does a deploy key. `infra/server/install.sh <sha>` (root, run with sudo) does it:

1. Clones `main` from GitHub over HTTPS (bare, that branch only) and checks that `<sha>` is on `main`. `infra/` at `<sha>` must hold regular files only.
2. Writes the full diff between the installed files and `infra/` at `<sha>` to `/root/focus-install-<sha>.diff` (root, 600). It lists the commits and the changed files, then asks: type `yes` to install, `diff` to page through the whole diff first, or anything else to stop with nothing changed. With no terminal (no `ssh -t`) it stops too. `--yes` skips the question, for the test harness only.
3. Under `/opt/focus/deploy.lock`, so it never swaps files under a running deploy: replaces `/opt/focus/infra` with `infra/` at `<sha>` plus a `REVISION` file, all `root:root` with nothing group- or world-writable. The previous copy stays in `/opt/focus/infra.previous`. Then it installs `infra/server/focus-ci.sh` as `/opt/focus/bin/focus-ci` (root, 755).
4. Starts or updates the edge. Caddy is recreated when the Caddyfile changed, because a running container keeps seeing the old file: a few seconds without HTTPS for both sites. When `infra/otel-collector/` changed, it also recreates each deployed environment's collector.
5. Prints the installed revision and the `sha256` of `focus-ci`.

It never touches the deploy keys, the `.env` files, the databases or the apps.

```bash
# First time (or when install.sh itself changed), like bootstrap.sh:
scp infra/server/install.sh yacine@159.223.188.176:/tmp/focus-install.sh
ssh -t yacine@159.223.188.176 'sudo bash /tmp/focus-install.sh <sha on main>'
# Afterwards:
ssh -t yacine@159.223.188.176 'sudo /opt/focus/infra/server/install.sh <sha on main>'
```

**Read the diff before typing `yes`.** Infra PRs are approved by the reviewer bot, so this prompt is the one place where you're guaranteed to see what will run as root on the host. Type `diff` at the prompt, or `sudo less /root/focus-install-<sha>.diff` from a second session.

**When to run it:** after a merge that changes `infra/` files the server uses: `compose*.yml`, `compose.sh`, `env/`, `caddy/`, `otel-collector/` or `server/focus-ci.sh`. App-only merges don't need it; they reach dev through the deploy below. Each deploy records the infra revision it ran with (`infra_revision`), so `status` shows when the server is behind.

Why not have the forced command fetch `infra/` itself? Then any merge to `main` would change, unreviewed by Yacine, what runs as root-equivalent on the host. That includes prod, which is supposed to change only with his approval ([process.md → Human gates](process.md#human-gates)). Infra changes are rare, and one command per change keeps that gate.

## Deploy to dev (#28)

Every push to `main` runs CI. Once the five required checks and `image` pass, `publish` pushes `ghcr.io/ybenzine/ineedtofocus:<sha>` and outputs its digest. Then `deploy-dev` (`.github/workflows/ci.yml`, `needs: publish`) deploys that exact digest. A red `main` never reaches dev, and a re-run that re-pushes the tag can't change what was deployed.

| Step | Where | What |
|---|---|---|
| Gate | runner | Neither `DEPLOY_SSH_KEY` nor `DEPLOY_KNOWN_HOSTS` set in the `dev` environment: skips with a notice, green (not set up yet). Only one of them set: fails red, since the environment is half configured. Both: deploys |
| Deploy | server, `focus-ci dev` | `ssh deploy@159.223.188.176 "deploy <sha> sha256:<digest>"`: waits for the deploy lock, pulls by digest, checks the image's `org.opencontainers.image.revision` label is `<sha>`, tags it `:<sha>`, migrates (`run --rm`), starts (`up -d --wait`, the `/healthz` healthcheck), checks that the app container runs exactly that image and that `/readyz` answers inside it, then records the release |
| Record | runner | `ssh … status` reads the record back; the job fails if it doesn't show this tag and digest |
| Smoke | runner | `scripts/smoke_deploy.py https://dev.ineedtofoc.us`: `/healthz` and `/readyz` answer `{"status":"ok"}`, `/` serves the frontend, `http://` redirects to `https://`, the certificate verifies. Retried for up to 90 s |
| Summary | runner | Tag, image digest, server time of the deploy, rollback target, infra revision, smoke results |

A failed step stops the deploy and exits non-zero, which turns the job red. The record keeps the last successful release, and the attempt is logged with the step that failed. If the failure came after `up`, dev may be running the new image unhealthy; automatic revert to the previous release is #30.

### The forced command: `focus-ci`

`/opt/focus/bin/focus-ci <profile>` (source `infra/server/focus-ci.sh`) accepts exactly these requests in `$SSH_ORIGINAL_COMMAND`, matched whole, in the C locale:

| Request | Profile `dev` | Does |
|---|---|---|
| `deploy <40 lowercase hex> sha256:<64 lowercase hex>` | yes | The deploy above |
| `rollback` | yes | Starts the record's previous release again by digest, no migration, same checks. Rolling back again goes further back, not forward |
| `status` | yes | Prints the record |

Anything else gets exit status 2 and `focus-ci: refused`, before anything runs: another verb, extra or malformed arguments, a shell, scp or sftp, a newline, or an unknown profile. Requests are logged to syslog (`journalctl -t focus-ci`). Every `docker` and `compose.sh` call runs under `env -i` with only `PATH`, `HOME` and `APP_TAG`, so nothing from the SSH session (such as `LC_*`, which sshd accepts) can override `infra/env/<env>.env`. #29 and #30 add profiles (prod deploy; prod rollback restricted to recorded releases) and the automatic revert in the same `case`.

**Serialization.** Every deploy and rollback takes `flock /opt/focus/deploy.lock` (waits up to 15 minutes), across environments, and `install.sh` takes the same lock. The memory budget counts one migration container at a time ([Memory](#memory-dev-cant-starve-prod)). In GitHub, `deploy-dev` has its own concurrency group (`deploy-dev`, no cancelling of the running deploy). Deploys of different environments don't share one group: GitHub cancels a *pending* job when another one joins the group, so a dev deploy queued behind a prod deploy would cancel a pending prod rollback. The server lock is what orders them. When merges queue up, the group keeps only the newest pending deploy: an intermediate commit's `Deploy to dev` shows as cancelled and dev goes straight to the newest commit. That's intended.

### The release record

`/opt/focus/dev/release` (owner `deploy`, 640), written only by `focus-ci`. `status` prints it:

```
env=dev
tag=<commit sha>
digest=sha256:<digest>
image=ghcr.io/ybenzine/ineedtofocus@sha256:<digest>
action=deploy                  # or rollback
deployed_at=2026-10-23T21:23:28Z
previous_tag=<sha>             # what `rollback` restores
previous_digest=sha256:<digest>
infra_revision=<sha>           # /opt/focus/infra/REVISION when it ran
```

`/opt/focus/dev/releases.log` has one line per attempt: `time=… env=dev action=deploy|rollback outcome=ok|failed tag=… digest=… previous_tag=… previous_digest=… infra=… [step=…]`.

### Credentials

| Where | What | Who sets it |
|---|---|---|
| GitHub environment `dev` (deployment branches: `main` only, no reviewer) | `DEPLOY_SSH_KEY`: the private half of the `focus-ci-dev` key. `DEPLOY_KNOWN_HOSTS`: the Droplet's host key line | Yacine |
| `/etc/ssh/authorized_keys/deploy` | `restrict,command="/opt/focus/bin/focus-ci dev" ssh-ed25519 … focus-ci-dev` | Yacine (sudo) |

Nothing is stored at repo level. The key can only run the `dev` profile: deploy, roll back or read dev's release. Even if it leaked, it can't open a shell, touch prod's project or change the compose files. What the image checks do and don't guarantee:

- `deploy` pulls only from `ghcr.io/ybenzine/ineedtofocus`, by digest, so the bytes deployed and recorded are the ones requested. A re-pushed tag can't swap them.
- The revision label check only proves the image *claims* to be built from `<sha>`. Anyone able to push to that package can set any label, and any workflow run in this repo that asks for `packages: write` can push there, including runs on PR branches. So the checks don't prove an image was built on `main`. That guarantee comes from the workflow: `deploy-dev` deploys only the digest `publish` pushed for a `main` commit that passed CI. The key itself is held only by the `main`-only `dev` environment.
- An image runs as dev's app, with the root-installed `compose.prod.yml`: no volumes, ports, Docker socket, privileges or host network, on dev's own networks and database. Host disk and process limits come with #117.

**The local `:<sha>` tag is host-wide.** Both environments' Compose projects resolve `ghcr.io/ybenzine/ineedtofocus:<sha>` from the same local image store, and `focus-ci` moves that tag (`docker tag …@<digest> …:<sha>`) on every deploy and rollback. `focus-ci` therefore never trusts an existing local tag. It re-tags from the digest it was given or has recorded, under the lock, and then checks the running container's image. Anything else that starts an app container must do the same: #29's prod deploy, #30's auto-revert and rollback, and any manual `compose.sh prod up` from a runbook.

The `main`-only branch policy keeps workflows on other branches from reading the key. GitHub creates the `dev` environment, with no secrets, the first time the job runs; until the secrets are added the job skips.

### One-time setup (Yacine)

1. **Install `infra/` and the forced command** on the server at the merge commit of this change ([install.sh](#infra-on-the-server-installsh), first-time form). Read the diff (on a first install it's every file), then type `yes`.
2. **Create the key pair** on your machine. It's used only by CI:
   `ssh-keygen -t ed25519 -N '' -C focus-ci-dev -f /tmp/focus-ci-dev`
3. **Authorize it on the server**, pinned to the forced command:
   `ssh -t yacine@159.223.188.176 "echo 'restrict,command=\"/opt/focus/bin/focus-ci dev\" $(cat /tmp/focus-ci-dev.pub)' | sudo tee -a /etc/ssh/authorized_keys/deploy > /dev/null"`.
   Then check that the file is still `640 root:deploy` (`sudo stat -c '%a %U:%G' /etc/ssh/authorized_keys/deploy`).
4. **Get the host key line** from your own logged-in session, not from the network:
   `ssh yacine@159.223.188.176 'printf "159.223.188.176 %s\n" "$(cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"'`
5. **Create the `dev` environment** on GitHub: repo **Settings** → **Environments** → **New environment** → `dev`, or open `dev` if CI has already created it. Under **Deployment branches and tags**, choose **Selected branches and tags**, click **Add deployment branch or tag rule**, and set **Ref type** to **Branch** (not Tag: the reviewer App can create tags, #29) with the name pattern `main`. Leave **Required reviewers** off.
   **Not `development`:** the repo already has an unrelated environment called `development` (a `rc-*` tag rule, no secrets). Don't put the secrets there. Nothing uses it, so you may want to delete it (**Environments** → `development` → **Delete environment**). Agents won't delete it.
   Then add two **Environment secrets** to `dev`: `DEPLOY_SSH_KEY`, the whole content of `/tmp/focus-ci-dev` (the private key, `-----BEGIN OPENSSH PRIVATE KEY-----` to `-----END …-----`), and `DEPLOY_KNOWN_HOSTS`, the line from step 4.
6. **Delete the local key files**: `rm /tmp/focus-ci-dev /tmp/focus-ci-dev.pub`.
7. **Check:** first, read-only, that the branch rule is right:
   `gh api repos/ybenzine/ineedtofocus/environments/dev/deployment-branch-policies --jq '.branch_policies[] | {name, type}'`
   should print only `{"name":"main","type":"branch"}`. CI now holds the only copy of the key. On **Actions**, open the latest `CI` run on `main`, open its `Deploy to dev` job (it skipped with a notice), and click **Re-run this job**: it reuses that run's published digest. The `Deploy to dev` job should go green and show the release in its summary, and `https://dev.ineedtofoc.us/healthz` should answer `{"status":"ok"}`.

### Upkeep

- **Infra changed in a merge:** run `install.sh` with the merge commit (see above), read the diff, type `yes`; the next deploy records the new `infra_revision`.
- **Host disk:** nothing prunes old app images yet. Until #117 lands, check `df -h /` and `docker system df` now and then.
- **Rotate the key:** repeat steps 2–6, then remove the old line from `/etc/ssh/authorized_keys/deploy`.
- **Roll dev back by hand** until #30's workflow exists: dev's key is only in GitHub, so use the server: `sudo -u deploy env -i SSH_ORIGINAL_COMMAND=rollback /opt/focus/bin/focus-ci dev`. That is what the key would run.

## Sections to write

- Deploy to prod — #29
- Health checks, auto-revert and rollback — #30
- Credential separation for the prod and rollback keys — #29, #30 (dev's is in [Deploy to dev → Credentials](#credentials))
