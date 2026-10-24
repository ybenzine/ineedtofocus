# Deployment

> **Status: in progress.** Server setup is scripted (#25), the images and production Compose are defined (#27), merges to `main` deploy to dev (#28), prod deploys are a manual, approved workflow (#29), and a deploy that fails its checks reverts by itself, with a `rollback` workflow for dev and prod (#30). The plan is in [tech_stack.md §2–3](tech_stack.md).

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

`restrict` turns off PTYs and forwarding for that key; `command=` makes sshd run that script whatever the client asks for (the client's request is in `$SSH_ORIGINAL_COMMAND`). The profile is fixed by this root-owned line, so a key can never pick another one. The `dev` profile is #28's ([Deploy to dev](#deploy-to-dev-28)), `prod` is #29's ([Deploy to prod](#deploy-to-prod-29)), and `rollback-prod` is the prod rollback key's (#30, [Rollback](#rollback-rollbackyml)).

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

A rollback is the same `up -d --wait` with a known-good release and no migration step, because migrations are expand-only (see [App image and migrations](#app-image-and-migrations) and [Rollback](#rollback-rollbackyml)). The edge (`compose.edge.yml`) is started and updated by `install.sh`, never by a deploy key, because prod shares it.

### App settings fixed by the Compose file

- `COOKIE_SECURE=1`: the session cookie is always `Secure` and named `__Host-focus_session` (`Path=/`, no `Domain`; #8, #77). It isn't read from the server `.env`, so a `COOKIE_SECURE=0` copied there from the local defaults has no effect. The smoke test signs in through Caddy and checks `Secure; HttpOnly; SameSite=Lax`.
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
| Deploy | server, `focus-ci dev` | `ssh deploy@159.223.188.176 "deploy <sha> sha256:<digest>"`: waits for the deploy lock, notes the current release, pulls by digest, checks the image's `org.opencontainers.image.revision` label is `<sha>`, tags it `:<sha>`, migrates (`run --rm`), starts (`up -d --wait`, the `/healthz` healthcheck), checks that the app container runs exactly that image and that `/healthz` and `/readyz` answer inside it, then records the release. If the start or a check fails, it starts the release that ran before again and fails ([Automatic revert](#automatic-revert)) |
| Record | runner | `ssh … status` reads the record back; the job fails if it doesn't show this tag and digest |
| Smoke | runner | `scripts/smoke_deploy.py https://dev.ineedtofoc.us`: `/healthz` and `/readyz` answer `{"status":"ok"}`, `/` serves the frontend, `http://` redirects to `https://`, the certificate verifies. Retried for up to 90 s |
| Summary | runner | Tag, image digest, server time of the deploy, rollback target, infra revision, smoke results |

A failed step stops the deploy and exits non-zero, which turns the job red. The record keeps the last successful release, and the attempt is logged with the step that failed. A failure at the start (after `up`) also puts the previous release back ([Automatic revert](#automatic-revert)). To undo a deploy that passed its checks, run the [rollback workflow](#rollback-rollbackyml).

### The forced command: `focus-ci`

`/opt/focus/bin/focus-ci <profile>` (source `infra/server/focus-ci.sh`) accepts exactly these requests in `$SSH_ORIGINAL_COMMAND`, matched whole, in the C locale:

| Request | Profile `dev` | Profile `prod` (#29) | Profile `rollback-prod` (#30) | Does |
|---|---|---|---|---|
| `deploy <40 lowercase hex> sha256:<64 lowercase hex>` | yes | yes, only a sha and digest dev ran successfully and didn't roll back from | no | The deploy above, on that profile's environment, with the [automatic revert](#automatic-revert) |
| `rollback`, `rollback <40 lowercase hex>`, either followed by ` expect sha256:<64 lowercase hex>` | yes (dev) | no | yes (prod) | Starts a [known-good release](#known-good-releases) again by its recorded digest, no migration, same checks. Rolling back again goes further back, not forward. With `expect`, only if the current release is that digest (checked under the lock). Prints `result from_tag=… from_digest=… tag=… digest=…` |
| `status` | yes | yes | yes (prod) | Prints that environment's record |
| `candidate` or `candidate <40 lowercase hex>` | no | yes | no | Read-only: the tag and digest of dev's current release, or the last promotable digest of that sha dev ran ([Deploy to prod](#deploy-to-prod-29)) |

Anything else gets exit status 2 and `focus-ci: refused`, before anything runs: another verb, a verb the profile doesn't have, extra or malformed arguments, a shell, scp or sftp, a newline, or an unknown profile. Requests are logged to syslog (`journalctl -t focus-ci`). Every `docker` and `compose.sh` call runs under `env -i` with only `PATH`, `HOME` and `APP_TAG`, so nothing from the SSH session (such as `LC_*`, which sshd accepts) can override `infra/env/<env>.env`.

**Serialization.** Every deploy and rollback takes `flock /opt/focus/deploy.lock` (waits up to 15 minutes), across environments, and holds it through an automatic revert. `install.sh` takes the same lock. The memory budget counts one migration container at a time ([Memory](#memory-dev-cant-starve-prod)). In GitHub, `deploy-dev` has its own concurrency group (`deploy-dev`, no cancelling of the running deploy). Deploys of different environments don't share one group: GitHub cancels a *pending* job when another one joins the group, so a dev deploy queued behind a prod deploy would cancel a pending prod rollback. The server lock is what orders them. When merges queue up, the group keeps only the newest pending deploy: an intermediate commit's `Deploy to dev` shows as cancelled and dev goes straight to the newest commit. That's intended.

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

`/opt/focus/dev/releases.log` has one line per attempt: `time=… env=dev action=deploy|rollback|revert outcome=ok|failed tag=… digest=… previous_tag=… previous_digest=… infra=… [step=…]`. A rollback's ok line adds the release it left (`from_tag=… from_digest=…`). An automatic revert's line adds what failed (`failed_action=… failed_tag=… failed_digest=…`). The log is what [known-good](#known-good-releases) is computed from, so it's never edited by hand. It's read strictly. A word that isn't `<lowercase key>=<value>`, or a key that appears twice, stops every deploy, rollback and `candidate` that reads the log, with `releases.log line <n> is malformed (<why>)`. That fails closed and loudly, never by reading the line loosely. Such a line comes from a write cut short (a full disk) or a hand edit. Yacine looks at it read-only (`sudo sed -n '<n>p' /opt/focus/<env>/releases.log`), then moves it out, and the next request works again. Blank lines are skipped. A last line without a newline still counts, and the next line written starts on a new line.

### Credentials

| Where | What | Who sets it |
|---|---|---|
| GitHub environment `dev` (deployment branches: `main` only, no reviewer) | `DEPLOY_SSH_KEY`: the private half of the `focus-ci-dev` key. `DEPLOY_KNOWN_HOSTS`: the Droplet's host key line | Yacine |
| `/etc/ssh/authorized_keys/deploy` | `restrict,command="/opt/focus/bin/focus-ci dev" ssh-ed25519 … focus-ci-dev` | Yacine (sudo) |

Nothing is stored at repo level. The key can only run the `dev` profile: deploy, roll back or read dev's release. Even if it leaked, it can't open a shell, touch prod's project or change the compose files. What the image checks do and don't guarantee:

- `deploy` pulls only from `ghcr.io/ybenzine/ineedtofocus`, by digest, so the bytes deployed and recorded are the ones requested. A re-pushed tag can't swap them.
- The revision label check only proves the image *claims* to be built from `<sha>`. Anyone able to push to that package can set any label, and any workflow run in this repo that asks for `packages: write` can push there, including runs on PR branches. So the checks don't prove an image was built on `main`. That guarantee comes from the workflow: `deploy-dev` deploys only the digest `publish` pushed for a `main` commit that passed CI. The key itself is held only by the `main`-only `dev` environment.
- An image runs as dev's app, with the root-installed `compose.prod.yml`: no volumes, ports, Docker socket, privileges or host network, on dev's own networks and database. Host disk and process limits come with #117.

**The local `:<sha>` tag is host-wide.** Both environments' Compose projects resolve `ghcr.io/ybenzine/ineedtofocus:<sha>` from the same local image store, and `focus-ci` moves that tag (`docker tag …@<digest> …:<sha>`) on every deploy and rollback. `focus-ci` therefore never trusts an existing local tag. It re-tags from the digest it was given or has recorded, under the lock, and then checks the running container's image. Anything else that starts an app container must do the same. The prod deploy (#29), the automatic revert and `rollback` (#30) do, through the same code. Any manual `compose.sh … up` must too ([break-glass](#break-glass-on-the-server)).

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
- **Roll dev back:** `gh workflow run rollback.yml -f env=dev` ([Rollback](#rollback-rollbackyml)).

## Deploy to prod (#29)

Prod deploys are manual and approved by Yacine. `.github/workflows/deploy-prod.yml` (workflow `deploy-prod`) starts only from **Actions** → **deploy-prod** → **Run workflow**, on branch `main`, with one optional input, `tag`. No push, tag or release starts it: the reviewer App can create tags (#70). The gate is the `production` environment's required approval.

**Until #127, that gate doesn't hold against agents.** Agents run `gh` logged in as Yacine, who is the environment's required reviewer and a repo administrator, so a command that reaches GitHub as him can both start a run and approve it. #127 is the fix: agents get a credential that can't approve deployments. Until then, `.claude/settings.json` denies the obvious commands (#126). The rules stay afterwards as a second line.

| Path | Rule |
|---|---|
| Start by file or workflow name: `gh workflow run deploy-prod` or `deploy-prod.yml`, also quoted, as a path or after flags | Denied: `gh workflow run deploy-prod*` and `gh workflow run *deploy-prod*`. The workflow's `name:` is `deploy-prod`, so starting it by name matches too |
| Start by numeric workflow ID: `gh workflow run <id>` | Denied: `gh workflow run 0*` … `gh workflow run 9*`, one rule per first digit |
| Start through the API: `…/actions/workflows/<id>/dispatches` | Denied: `gh api *dispatches*` |
| Approve a waiting run: `gh api -X POST …/actions/runs/<id>/pending_deployments` with `state=approved` | Denied: `gh api *pending_deployments*`. Reading a run's pending deployments is denied too; the run page shows them |
| Approve through GraphQL: the `approveDeployments` mutation | Denied when the query is in the command: `gh api *approveDeployments*` |
| Re-run a past run: `gh run rerun <id>`, `gh api …/runs/<id>/rerun` | **Not denied**, on purpose (below) |
| Roll back: `gh workflow run rollback.yml …` (#30) | Allowed. `scripts/tests/test_claude_settings.py` checks that the rules above are present and that no deny or ask rule matches a rollback command, so the on-call agent never stalls |

**Re-runs are left open.** A run ID doesn't say which workflow it belongs to, so no rule can tell a `deploy-prod` re-run from a CI re-run, and agents re-run CI routinely. A re-run of `deploy-prod` still can't reach prod on its own: a full re-run re-runs `plan`, which picks dev's current release, and its `deploy` job waits for the `production` approval again. Approving it is what the `pending_deployments` and `approveDeployments` rules deny, which breaks the re-run-then-approve chain. A re-run reaches prod only if Yacine approves it on the run page, so read its plan summary first.

**What the rules don't catch.** Like every rule in that file, they match command text, so they prevent mistakes, not determined misuse. A numeric ID after a flag (`gh workflow run --ref main <id>`) or in quotes gets through: a rule such as `gh workflow run * 1*` would also match a rollback tag, which is a commit sha. So does a GraphQL query read from a file (`-F query=@file`), and any command run through an allowed wrapper (`uv run`, `npx`, `python`, `node`, `docker exec`), `bash -c`, `env` or an absolute path to `gh`. Until #127 lands, the approval is a gate against people and leaked tokens other than Yacine's, and against agents' mistakes, but not against an agent set on getting past it.

**Prod gets what dev ran.** Leave `tag` empty to deploy the release dev runs now, or give a full commit sha (40 lowercase hex) that dev ran successfully at some point. "Successfully" means two things. The `plan` job requires a `dev` GitHub deployment of that sha that reached `success`, so `deploy-dev` passed its smoke tests. The server requires an ok line in dev's `releases.log`, so focus-ci's checks passed. An explicit sha lets you deploy, for example, a release dev ran before newer merges reached it. Going back is a rollback, not a deploy (#30): a deploy migrates, and an older image can't run `alembic upgrade head` on a schema a newer one migrated. That deploy stops at the `migrate` step with nothing changed. Either way the workflow deploys a digest, never a registry tag. That digest is read from dev's own records on the server. It's normally the one `publish` pushed and `deploy-dev` deployed; [Credentials](#credentials-1) covers when it might not be. The server checks it again before deploying: `focus-ci prod` refuses a sha and digest that have no successful line in `/opt/focus/dev/releases.log`, or that dev rolled back from since ([Known-good releases](#known-good-releases)). So a tag re-pushed to the registry, or a digest nobody deployed to dev, can't reach prod.

| Step | Where | What |
|---|---|---|
| Plan | job `plan`, runner, no credentials | Checks the input: empty, or 40 lowercase hex. Empty means dev's newest successful GitHub deployment. Checks that the commit is on `main` (compare API), that a `CI` run on `main` passed for it, and that a `dev` deployment of it reached `success` (dev's smoke tests passed). Writes the commit to the summary and passes the sha on. Yacine approves that one commit |
| Approval | job `deploy`, environment `production` | Waits for Yacine: the run page shows **Review deployments**. Read the plan's summary, then tick `production` → **Approve and deploy**, or **Reject**. The environment's branch rule only lets runs from `main` in |
| Gate | runner | Neither `DEPLOY_SSH_KEY` nor `DEPLOY_KNOWN_HOSTS` in `production`: skips with a notice, green, nothing changes on prod. Only one of them: fails red. Both: deploys |
| Resolve | runner, `focus-ci prod`: `candidate` | Empty input: `candidate`, dev's current release. If dev's record doesn't show the planned sha, the job stops and deploys nothing, since that's not what was approved. Either dev moved after the plan (a newer deploy, or a rollback), or dev's latest deploy passed the server checks but failed its smoke tests, so the plan skipped it. A sha: `candidate <sha>`, the last digest of that commit dev ran successfully. Read-only: no docker call, no lock, no write. A dev key put in `production` by mistake can't run it, so the job stops here |
| Deploy | server, `focus-ci prod`: `deploy <sha> sha256:<digest>` | Under the deploy lock: the `promote` check above, then the same steps as dev on `focus-prod`. It pulls by digest when the host doesn't have it and checks the revision label. It re-tags the host-wide `:<sha>` from the digest, which dev's deploys may have moved. Then it migrates, runs `up -d --wait`, checks that the app container runs exactly that digest and that `/healthz` and `/readyz` answer, and records the release. If the start or a check fails, it starts prod's previous release again and fails ([Automatic revert](#automatic-revert)) |
| Record | runner | `status` reads `/opt/focus/prod/release` back; the job fails unless it shows `env=prod` and this tag and digest. Then the key is deleted from the runner, before any repository code runs |
| Smoke | runner | `scripts/smoke_deploy.py https://ineedtofoc.us`, the same checks as dev's |
| Summary | runner | Tag, image digest, when dev ran it, when prod got it, rollback target (the previous tag), infra revision, smoke results |

The prod record and log have the same format as dev's ([The release record](#the-release-record)), in `/opt/focus/prod/`. A failed step stops the deploy and turns the job red. The record keeps the last good release, and the attempt is logged with the step that failed (`step=promote` when dev never ran it, or rolled back from it). A failure after `up` also puts prod's previous release back ([Automatic revert](#automatic-revert)).

**One prod deploy at a time.** The `deploy` job has its own concurrency group, `deploy-prod`, which never cancels a running deploy. A second run waits; a third one replaces the waiting second one, so the newest request wins. Reject runs you won't approve rather than leaving them waiting, since a waiting run can hold the group. The group isn't shared with `deploy-dev` or #30's `rollback.yml`, because GitHub cancels a *pending* job when another one joins its group. Deploys of both environments are ordered on the server by `/opt/focus/deploy.lock` instead.

### Credentials

| Where | What | Who sets it |
|---|---|---|
| GitHub environment `production` (required reviewer: Yacine; deployment branches: `main` only; administrators can't bypass) | `DEPLOY_SSH_KEY`: the private half of the `focus-ci-prod` key. `DEPLOY_KNOWN_HOSTS`: the Droplet's host key line (the same line as dev's) | Yacine |
| `/etc/ssh/authorized_keys/deploy` | `restrict,command="/opt/focus/bin/focus-ci prod" ssh-ed25519 … focus-ci-prod` | Yacine (sudo) |

Nothing is stored at repo level, and the `plan` job holds no credential. Every job that reads a secret other than `GITHUB_TOKEN` runs in an environment (`scripts/tests/test_ci_workflow.py` checks every workflow). Only a job of an approved run, on `main`, can read the prod key. Until #127, an agent's `gh` can still approve that run as Yacine; #126's rules deny only the obvious commands (see the table above). Until #127, a workflow edit merged by an agent can reach the prod key without Yacine. Even then, the key can only run `focus-ci prod`, whose limits hold whatever the workflow says.

The prod key itself sits on the runner's disk only from **Set up the deploy key** to just after **Read the server's release record**. It's deleted before `scripts/smoke_deploy.py`, the first repository code the job runs, and again in the final `always()` step.

What each key can do:

- **Prod key** (`focus-ci prod`): deploy to prod a release dev ran successfully (and didn't roll back from), read prod's record, and read dev's record and log (`candidate`). It can't deploy or roll back dev, roll prod back (the [rollback key](#credentials-2) does that), open a shell or change the compose files. If it leaked, the worst it could do is redeploy to prod a release dev once ran (an older one stops at `migrate` once prod's schema is newer). That's not new code, but only as long as dev runs only `publish`'s images, and the server doesn't enforce that (next point).
- **What the approval binds: a commit, not bytes.** Yacine approves a commit. The digest comes from dev's `releases.log`, which records whatever the dev key asked for. The dev key is usable without a reviewer by any `dev`-environment job on `main`. Any run that asks for `packages: write` can push an image labelled with any commit, PR-branch runs included. So an agent-merged workflow change could deploy to dev an image built outside `publish` and labelled with commit X. Approving X for prod would then deploy those bytes. Build provenance attestations from `publish`, verified before the prod deploy, close this: #128.
- **Dev key** (`focus-ci dev`): can't do anything on prod. `candidate` is refused, and its `deploy`, `rollback` and `status` act only on `focus-dev` and `/opt/focus/dev/`.

`make test-server` checks both directions behind the real sshd, along with hostile requests, the promotion check, the re-tagging of a `:<sha>` that dev moved, the lock, the clean environment and the record.

### One-time setup (Yacine)

Dev must be deployed first ([Deploy to dev → One-time setup](#one-time-setup-yacine)), since prod takes its releases from dev.

**Wait for #126 before the key.** Step 1 and the environment settings in step 5 can be done any time. Steps 2–4, the secrets in step 5, and steps 6–8 wait until #126 is merged, so the interim deny rules for starting and approving prod deploys are in place (re-runs aren't denied, and don't need to be: see the table at the top of this section). #127 is recommended first too: it's the actual fix. Without the secrets, the deploy job skips and nothing reaches prod.

1. **Install `infra/` at the merge commit of #29**, which updates `focus-ci`: `ssh -t yacine@159.223.188.176 'sudo /opt/focus/infra/server/install.sh <merge sha>'`. The diff shows `server/focus-ci.sh` and `server/install.sh`. Read it, then type `yes`.
2. **Create the key pair** on your machine, for CI only: `ssh-keygen -t ed25519 -N '' -C focus-ci-prod -f /tmp/focus-ci-prod`
3. **Authorize it**, pinned to the prod profile:
   `ssh -t yacine@159.223.188.176 "echo 'restrict,command=\"/opt/focus/bin/focus-ci prod\" $(cat /tmp/focus-ci-prod.pub)' | sudo tee -a /etc/ssh/authorized_keys/deploy > /dev/null"`
   Then `ssh yacine@159.223.188.176 "sudo stat -c '%a %U:%G' /etc/ssh/authorized_keys/deploy; sudo grep -c 'focus-ci prod' /etc/ssh/authorized_keys/deploy"` should print `640 root:deploy` and `1`.
4. **Get the host key line** as for dev: `ssh yacine@159.223.188.176 'printf "159.223.188.176 %s\n" "$(cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"'`
5. **Set up the `production` environment** before adding any secret: repo **Settings** → **Environments** → `production`, or **New environment** → `production` if it isn't listed.
   - **Required reviewers**: tick it, add `ybenzine`, and leave **Prevent self-review** unticked, since you start the runs yourself.
   - **Allow administrators to bypass configured protection rules**: untick it. Agents use your `gh` login, which is an administrator.
   - **Wait timer**: off.
   - **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → Ref type **Branch** (not Tag) → name pattern `main` → **Add rule**.
   - **Save protection rules**.
   - **Environment secrets** (only once #126 is merged, see above) → **Add environment secret**, twice: `DEPLOY_SSH_KEY`, the whole of `/tmp/focus-ci-prod` (`-----BEGIN OPENSSH PRIVATE KEY-----` to `-----END …-----`), and `DEPLOY_KNOWN_HOSTS`, the line from step 4. Not as repository secrets.
6. **Delete the local key files**: `rm /tmp/focus-ci-prod /tmp/focus-ci-prod.pub`.
7. **Check**, read-only:
   `gh api repos/ybenzine/ineedtofocus/environments/production --jq '{reviewers: [.protection_rules[] | select(.type == "required_reviewers") | .reviewers[].reviewer.login], branches: .deployment_branch_policy, admins_bypass: .can_admins_bypass}'`
   should print `{"admins_bypass":false,"branches":{"custom_branch_policies":true,"protected_branches":false},"reviewers":["ybenzine"]}`.
   `gh api repos/ybenzine/ineedtofocus/environments/production/deployment-branch-policies --jq '.branch_policies[] | {name, type}'` should print only `{"name":"main","type":"branch"}`, and `gh secret list` (repository secrets) should list no `DEPLOY_*`.
8. **First deploy:** **Actions** → **deploy-prod** → **Run workflow** → branch `main`, `tag` empty → **Run workflow**. When `plan` is done, read its summary, then **Review deployments** → `production` → **Approve and deploy**. The job should go green with the release and passing smoke tests in its summary, and `https://ineedtofoc.us/healthz` should answer `{"status":"ok"}`.

### Upkeep

- **Rotate the key:** repeat steps 2–6, then remove the old `focus-ci-prod` line from `/etc/ssh/authorized_keys/deploy`.
- **Roll prod back:** `gh workflow run rollback.yml -f env=prod`, no approval needed ([Rollback](#rollback-rollbackyml)). A `deploy` of an older release isn't a rollback: it fails at `migrate` once prod's schema is newer.

## Health checks and automatic revert (#30)

### What a deploy checks

`focus-ci`'s `deploy`, the same code for dev and prod, under the deploy lock:

1. **Note the current release** (the record's `tag` and `digest`): the one to go back to. Work out the next rollback target from the log ([Known-good releases](#known-good-releases)).
2. **Pull** the new image by digest, check its revision label, re-tag `:<sha>` from the digest.
3. **Migrate** as a one-shot container (`run --rm … alembic upgrade head`).
4. **Start** with `up -d --wait`, which waits for the `/healthz` healthcheck (`--wait-timeout 180`). Then check that the app container runs exactly that digest, and that `GET /healthz` (the process) and `GET /readyz` (the database) answer inside it, three tries each, 2 s apart.
5. **Record** the release (`release`, plus an ok line in `releases.log`).

### Automatic revert

A failure before the start (`promote`, `pull`, `migrate`) leaves the running app alone. The old container is never stopped, and a failed migration rolls back in its transaction, so there's nothing to revert. The deploy fails, the record is unchanged, and the attempt is logged with its step.

A failure at the start (not healthy within the timeout, the wrong image, `/healthz` or `/readyz` not answering) means the app may now run the new release unhealthy. So, still under the lock, `focus-ci` starts **the release that ran before** again:

- by its recorded digest, re-tagged `:<sha>` from it (dev or prod may have moved that tag), pulled if the host no longer has it;
- without migrating: the older release runs on the newer schema ([Schema compatibility](#schema-compatibility));
- with the same checks (running image, `/healthz`, `/readyz`).

The deploy and the revert finish even if the SSH client goes away meanwhile (a cancelled job, a lost runner). `focus-ci` ignores HUP and PIPE, and its output reaches the client through forwarders that drop it once the client is gone, so no write can stop it between `up` and the revert. `make test-server` kills the client during a broken build's start and checks the revert still runs and is logged.

Then the deploy **fails anyway** (exit 1), so the `Deploy to dev` or `Deploy to prod` job goes red. Its summary says the server started the previous release again. The record is unchanged, since it still names the release that runs. The log has two lines: `action=deploy outcome=failed step=start` for the new release, then `action=revert outcome=ok` (or `failed`) for the one restored, with `failed_tag` and `failed_digest`. A failed release has no ok line, so it never becomes a rollback target and prod never takes it from dev.

If the revert fails too (for example the database is down, so no release passes `/readyz`), the deploy says `reverting to <tag> failed too`: the environment may be down ([runbook](runbooks/rollback.md)). The first deploy of an environment has nothing to revert to. A redeploy of the current digest that fails has nothing *else* to go back to: roll back instead.

The smoke tests that run afterwards from the runner (`scripts/smoke_deploy.py`, through Caddy) don't trigger a revert. When they fail after the server's own checks passed, the cause is usually the edge (Caddy, DNS, the certificate), and undoing the release wouldn't fix it. A release that failed its smoke tests on dev is never offered to prod (deploy-prod's plan requires a dev deployment that reached `success`). To undo it anyway, run the [rollback workflow](#rollback-rollbackyml).

`make test-server` runs this with deliberately broken images: one never turns healthy, one has no `/readyz`, and one is broken on prod only. Each deploy fails, the release before it runs again by its own digest without migrating, and a probe checks the lock is held through both starts.

### Known-good releases

Every `outcome=ok` line in an environment's `releases.log` is a release that ran there and passed every check: a deploy, a rollback or an automatic revert. A rollback's ok line also names the release it **left** (`from_digest`). That release is then *rolled back from* until a later ok line for the same digest, for example when someone deploys it again on purpose.

A **known-good release** of an environment is a release (tag and digest) with an ok line there that isn't rolled back from. Concretely:

- `rollback` restores the newest known-good release other than the current one. A rollback revokes the release it left, so rolling back again goes one further back, never forward to it.
- `rollback <sha>` restores the newest known-good release of that commit, by the digest recorded for it. The server refuses a sha with no known-good release there: one that never passed the checks, failed and was reverted, only ran on the other environment, was rolled back from, or is the current release.
- After every deploy or rollback, the record's `previous_tag`/`previous_digest` is the next rollback target, worked out the same way. The workflow summaries show it.

**Not promotable once dev rolled back from it** (#125 review). Prod takes only releases dev ran, and a release dev rolled back from is one we decided was bad. `focus-ci prod` refuses it in `candidate` (read-only) and in `promote` (under the lock, before any docker call) with `dev rolled back from <sha> <digest>, so it is not promotable`. It becomes promotable again only when dev runs that digest again with an ok line. deploy-prod's `plan` job can't see this (it reads GitHub deployments, which a rollback doesn't change), so a run that picked such a release stops at `Resolve` or `Deploy`, after the approval but before anything changes on prod.

### Schema compatibility

Neither a rollback nor a revert runs a migration, and nothing ever undoes one. That's safe because migrations are **expand-only** ([AGENTS.md](../AGENTS.md#conventions), `backend/tests/unit/test_migration_safety.py`). A known-good release migrated this database or ran on it. While every later migration only added to the schema (new tables, new nullable or defaulted columns), the older code runs on today's schema. AGENTS.md also allows contract migrations later ("expand first, contract later"; the safety test lets one through with a `# contract-migration:` comment). After one, a release that still needs the removed shape would fail. Today nothing retires such releases as rollback targets: **#165 adds a rollback floor**, so that a contract deploy makes the releases before it non-targets. It must land before the first contract migration. The app container doesn't migrate on start (`MIGRATE_ON_START=0`), so an older image doesn't fail with `Can't locate revision …`. A migration that breaks this rule breaks rollback, which is why the migration safety test exists. A bad migration isn't something a rollback fixes: fix forward.

## Rollback (`rollback.yml`)

`.github/workflows/rollback.yml` (workflow `rollback`) restores a known-good release on dev or prod. It needs **no approval**, so the on-call agent can run it at any hour ([process.md → Human gates](process.md#human-gates)). It can't deploy anything new: the key it uses can only start a release that already passed the checks on that environment. The step-by-step procedure, for people and the on-call agent, is the [rollback runbook](runbooks/rollback.md).

```bash
gh workflow run rollback.yml -f env=prod                 # the last known-good release
gh workflow run rollback.yml -f env=prod -f tag=<sha>    # a known-good release of <sha>
```

Or **Actions** → **rollback** → **Run workflow** → branch `main`, then choose `env` and, optionally, a `tag`.

**Inputs:** `env`, a choice of `dev` or `prod`, and `tag`, empty or a full commit sha. There's no free-text input. The permission rules match the whole command text, so a reason such as `-f reason="deploy-prod broke saves"` would hit #126's deny rule (`gh workflow run *deploy-prod*`) and stall an unattended run. Keep `rollback.yml` straight after `gh workflow run`. `gh workflow run --ref main rollback.yml …` matches no allow rule and prompts. `gh workflow run` dispatches on the default branch, `main`, already. `scripts/tests/test_claude_settings.py` checks the on-call agent's exact commands against the rules.

| Step | Where | What |
|---|---|---|
| Check the request | runner, no secret | Run from `main`; `env` is `dev` or `prod`; `tag` is empty or 40 lowercase hex |
| Environment | job | `env=dev` → environment `dev` (its deploy key, `focus-ci dev`). `env=prod` → environment `rollback` (the prod rollback key, `focus-ci rollback-prod`). Never `production`. `deployment: false`: the job reads the environment's secrets, and its branch rule still applies, but no GitHub deployment is created. deploy-prod's plan reads dev's deployments as "what dev runs", and a rollback run's deployment would carry main's head, not the release it restored |
| Gate | runner | Both `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` set, or the job **fails red**. Unlike a deploy, a rollback that can't run never skips green, so it can't be mistaken for one that happened |
| Read what runs now | server: `status` (and `candidate` for prod) | The record must name that environment, so a key in the wrong environment stops here, before anything changes. For prod, the key must also be refused `candidate` (exit 2). Only the rollback profile refuses it, so a prod *deploy* key put in `rollback` by mistake fails red (that refusal shows in syslog as `refused: candidate isn't allowed`) |
| Roll back | server: `rollback [<sha>] expect <digest just read>` | Under the deploy lock: if the current release isn't that digest (a deploy or rollback ran in between), it refuses and nothing changes. Then the [known-good](#known-good-releases) target, pulled by its recorded digest if the host lacks it, label checked, re-tagged `:<sha>`, `up -d --wait`, running image, `/healthz`, `/readyz`. No migration. If the target fails its checks, the release it left starts again ([Automatic revert](#automatic-revert)) and the job fails |
| Record | runner: `status` | The server's `result` line gives what it left and what runs now. The record must show `action=rollback` with that digest, and `tag` when one was given. Then the key is deleted, before any repository code runs |
| Smoke | runner | `scripts/smoke_deploy.py` against https://ineedtofoc.us or https://dev.ineedtofoc.us |
| Summary | runner | From (the release left) and To (what runs now), both from the server's `result` line, written under the lock, plus the next rollback target, infra revision and smoke results. For dev: the release left is no longer promotable |

**Concurrency:** one rollback per environment at a time (`rollback-dev`, `rollback-prod`). A running one is never cancelled. GitHub keeps one *pending* run per group: a second dispatch while one waits replaces it, which drops a duplicate step back. The groups are separate from `deploy-dev` and `deploy-prod`, for the reason under [Serialization](#the-forced-command-focus-ci): the server lock orders them.

**After a prod rollback**, prod runs an older release and dev may still run the bad one. The fix goes through the usual path: a PR, a merge that deploys it to dev, then an approved prod deploy. Roll dev back too if the bad release blocks work there.

### Credentials

| Where | What | Who sets it |
|---|---|---|
| GitHub environment `rollback` (no required reviewer; deployment branches: `main` only) | `DEPLOY_SSH_KEY`: the private half of the `focus-ci-rollback` key. `DEPLOY_KNOWN_HOSTS`: the Droplet's host key line (the same line as dev's and prod's) | Yacine |
| `/etc/ssh/authorized_keys/deploy` | `restrict,command="/opt/focus/bin/focus-ci rollback-prod" ssh-ed25519 … focus-ci-rollback` | Yacine (sudo) |
| GitHub environment `dev` | Nothing new: the dev key's profile already has `rollback` ([Deploy to dev → Credentials](#credentials)) | |

Nothing is stored at repo level. The environment has no reviewer on purpose, so rolling prod back works at any hour without Yacine. The key is what limits it:

| Key (profile) | deploy | rollback | status | candidate | Environment it acts on |
|---|---|---|---|---|---|
| dev (`dev`) | yes | yes | yes | no | dev only |
| prod (`prod`) | yes, a release dev ran and didn't roll back from | no | yes | yes (reads dev) | prod |
| prod rollback (`rollback-prod`) | no | yes, prod's own known-good releases | yes | no | prod only |

- **Prod rollback key** (`focus-ci rollback-prod`): `rollback`, `rollback <sha>` and `status` on prod, nothing else. The client never names a digest: the target comes from prod's own `releases.log`, so the key can only start bytes prod already ran and checked. It can't deploy, migrate, read or change dev, open a shell or change the compose files. If it leaked, the worst it could do is roll prod back to an older known-good release, or step back through several. That's an outage-sized nuisance, fixed by an approved deploy, but never new code.
- An agent-merged edit of `rollback.yml` can't do more: the key's limits hold whatever the workflow says, and the `rollback` environment accepts only `main`.

`make test-server` checks all three keys behind the real sshd. The rollback key gets the hostile requests plus `deploy` and `candidate`. It's checked to restore only prod's known-good releases (not dev's, not a failed one, not one rolled back from, not the current one) and to leave dev's record, log and container alone. The dev key's rollback touches no prod file, and the prod key still can't roll back.

### One-time setup (Yacine)

Dev's rollback needs only step 1 (once dev is set up, [Deploy to dev → One-time setup](#one-time-setup-yacine)). Prod's needs all of them. Agents can't do these: they're secrets, environments and the server.

1. **Install `infra/` at the merge commit of #30**, which changes `focus-ci` (the revert, `rollback <sha>`, the `rollback-prod` profile): `ssh -t yacine@159.223.188.176 'sudo /opt/focus/infra/server/install.sh <merge sha>'`. The diff shows `server/focus-ci.sh`, `server/install.sh` and `server/tests/`. Read it, then type `yes`. (Not installed yet? Use the first-time form in [install.sh](#infra-on-the-server-installsh).)
2. **Create the key pair** on your machine, for CI only: `ssh-keygen -t ed25519 -N '' -C focus-ci-rollback -f /tmp/focus-ci-rollback`
3. **Authorize it**, pinned to the rollback profile:
   `ssh -t yacine@159.223.188.176 "echo 'restrict,command=\"/opt/focus/bin/focus-ci rollback-prod\" $(cat /tmp/focus-ci-rollback.pub)' | sudo tee -a /etc/ssh/authorized_keys/deploy > /dev/null"`
   Then `ssh yacine@159.223.188.176 "sudo stat -c '%a %U:%G' /etc/ssh/authorized_keys/deploy; sudo grep -c 'focus-ci rollback-prod' /etc/ssh/authorized_keys/deploy"` should print `640 root:deploy` and `1`.
4. **Try the key, read-only**, before it goes to GitHub:
   `ssh -i /tmp/focus-ci-rollback -o IdentitiesOnly=yes deploy@159.223.188.176 status` prints prod's record (or says none is recorded yet), and
   `ssh -i /tmp/focus-ci-rollback -o IdentitiesOnly=yes deploy@159.223.188.176 candidate` answers `focus-ci: refused: candidate isn't allowed for profile rollback-prod`. Don't run `rollback` to try it: that would roll prod back.
5. **Get the host key line** as for dev: `ssh yacine@159.223.188.176 'printf "159.223.188.176 %s\n" "$(cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"'`
6. **Create the `rollback` environment**: repo **Settings** → **Environments** → **New environment** → name `rollback` → **Configure environment**.
   - **Required reviewers**: leave unticked. On-call must be able to roll back without anyone.
   - **Wait timer**: off.
   - **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → Ref type **Branch** (not Tag) → name pattern `main` → **Add rule**.
   - **Environment secrets** → **Add environment secret**, twice: `DEPLOY_SSH_KEY`, the whole of `/tmp/focus-ci-rollback` (`-----BEGIN OPENSSH PRIVATE KEY-----` to `-----END …-----`), and `DEPLOY_KNOWN_HOSTS`, the line from step 5. Not as repository secrets, and not in `production`.
7. **Delete the local key files**: `rm /tmp/focus-ci-rollback /tmp/focus-ci-rollback.pub`.
8. **Check**, read-only:
   `gh api repos/ybenzine/ineedtofocus/environments/rollback --jq '{reviewers: [.protection_rules[]? | select(.type == "required_reviewers")], branches: .deployment_branch_policy}'` should print `{"branches":{"custom_branch_policies":true,"protected_branches":false},"reviewers":[]}`.
   `gh api repos/ybenzine/ineedtofocus/environments/rollback/deployment-branch-policies --jq '.branch_policies[] | {name, type}'` should print only `{"name":"main","type":"branch"}`. `gh secret list` (repository secrets) should list no `DEPLOY_*`.

9. **Check that the branch rule holds without a deployment** (`deployment: false`), once, with harmless dev input. **Yacine** creates the throwaway branch with `rollback.yml` on it (`git push origin origin/main:refs/heads/check/rollback-branch-rule`) and deletes it afterwards. Agents can't delete branches (`.claude/settings.json` denies it), so they don't create this one. The lead or Yacine then only dispatches the run: `gh workflow run rollback.yml --ref check/rollback-branch-rule -f env=dev`. Expected: the run fails before any step runs, rejected by the `dev` environment's branch rule ("… is not allowed to deploy to dev due to environment protection rules"). If its job starts and reaches **Check the request** (which fails with "Not main"), the rule isn't enforced for `deployment: false`: stop, don't add the `rollback` secrets, and open an issue (drop `deployment: false`, or keep rollback runs out of deploy-prod's plan another way). Yacine deletes the branch afterwards: `git push origin --delete check/rollback-branch-rule`. Do this in the same session as the [demonstration](#demonstration).

The first real prod rollback is the check of the whole path. Until then, the workflow fails red for `env=prod` with "the rollback environment has no DEPLOY_SSH_KEY and DEPLOY_KNOWN_HOSTS".

### Break-glass on the server

If GitHub Actions is down, Yacine can run on the server exactly what a key would run, with the same checks, lock and record:

```bash
sudo -u deploy env -i SSH_ORIGINAL_COMMAND=status /opt/focus/bin/focus-ci rollback-prod
sudo -u deploy env -i SSH_ORIGINAL_COMMAND=rollback /opt/focus/bin/focus-ci rollback-prod      # prod
sudo -u deploy env -i SSH_ORIGINAL_COMMAND=rollback /opt/focus/bin/focus-ci dev                # dev
```

Don't start an app container with `compose.sh … up` by hand: the local `:<sha>` tag may point at other bytes, nothing would check the result, and the record wouldn't know. Use the forced command.

### Demonstration

AC: "Rollback demonstrated once with a deliberately broken build". **Status: not yet run.** It needs dev's one-time setup ([Deploy to dev](#one-time-setup-yacine), #28) and step 1 above. The lead runs it then and records it on #30 (links to the runs and the before and after state).

**Automatic revert.** Tested in `make test-server` with deliberately broken images (above). It can't be shown on dev through a merge, and that's by design. CI's `image` job runs the same health and readiness checks on the image (`make test-prod-stack`: migrate, `up --wait`, `/healthz`, `/readyz`), and `publish` needs it. So a build that fails them is never published and never reaches the server. On the server it guards against what CI can't reproduce: dev's or prod's own data and history, and the host.

**The rollback workflow, with a deliberately broken build on dev.** A build that reaches dev passed every check, so the breakage has to be one no check looks at. The demo uses a visible one:

1. Note what dev runs: the `Deploy to dev` summary of the latest CI run on `main` (tag `G`). Rolling back from the demo build needs only `G`. If dev ran a known-good release before `G`, the rollback's "Next rollback target" shows it; otherwise it's empty. Yacine saves the log's tail: `sudo tail -n 5 /opt/focus/dev/releases.log`.
2. Open a PR **`demo(#30): deliberately broken build for the rollback demo`** (`Refs #30`, not `Closes`) whose only change makes every page show a banner reading "Deliberately broken build (#30 rollback demo)". It passes CI, gets reviewed as a demo and is merged. `deploy-dev` deploys it as `B`, and its summary shows `B` with rollback target `G`. https://dev.ineedtofoc.us shows the banner.
3. Roll dev back exactly as on-call would: `gh workflow run rollback.yml -f env=dev`. Then `gh run list --workflow rollback.yml --limit 1 --json databaseId,createdAt,status,conclusion,url` and `gh run watch <databaseId> --exit-status`.
4. Check: the run is green, and its summary shows From `B`, To `G`, smoke tests passed, and "`B` is marked as rolled back from on dev". https://dev.ineedtofoc.us no longer shows the banner. Then Yacine, on the server and read-only:
   - `sudo tail -n 5 /opt/focus/dev/releases.log` ends with `action=deploy outcome=ok tag=B …`, then `action=rollback outcome=ok tag=G … from_tag=B …`;
   - `sudo -u deploy env -i SSH_ORIGINAL_COMMAND="candidate <B sha>" /opt/focus/bin/focus-ci prod` is refused (exit 1) with `dev rolled back from every release of <B> it ran, so none is promotable`. That shows prod can't take `B`, without any prod deploy.
5. Revert the demo on `main` with a PR (`git revert` of the demo commit, `Refs #30`). Merging it deploys the next release to dev as usual.
6. Record it on #30: the demo PR, the `Deploy to dev` run of `B`, the rollback run and its summary, the `candidate` refusal, the revert PR, dev's release before and after, and the `releases.log` tail before and after. Also record the result of the branch-rule check (one-time setup, step 9). #30 isn't accepted until this record is posted.
