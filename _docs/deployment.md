# Deployment

> **Status: in place.** Dev and prod run on the Droplet; the first prod deploy ran on 2026-10-25. Server setup is scripted (#25), the images and production Compose are defined (#27), merges to `main` deploy to dev (#28), prod deploys are a manual, approved workflow (#29) that deploys only bytes CI attested for the approved commit (#128), and a deploy that fails its checks reverts by itself, with a `rollback` workflow for dev and prod (#30). Host resources other than memory and CPU are bounded too: old app images are pruned and every container has process, privilege and disk limits (#117). The plan is in [tech_stack.md §2–3](tech_stack.md).

## Environments

| Env | URL | Deployed | Compose project |
|---|---|---|---|
| Local | http://localhost:8000 | `make up` | `focus-local` |
| Dev | https://dev.ineedtofoc.us | Automatically on merge to `main` | `focus-dev` |
| Prod | https://ineedtofoc.us | Manual workflow run with Yacine's approval | `focus-prod` |

## Credential separation

No credential is stored at repo level. Each one lives where only the job that needs it can read it, and each environment's branch rule admits only `main`. `scripts/tests/test_ci_workflow.py` fails if a job reads a secret other than `GITHUB_TOKEN` outside a GitHub environment. `scripts/tests/test_oncall_workflow.py` pins which `oncall` step reads which secret.

| Where | Credential | Read by | Reviewer | Can't |
|---|---|---|---|---|
| GitHub environment `dev` | Dev deploy key (`focus-ci dev`), host key line | `deploy-dev` in `ci.yml`, `rollback.yml` for dev (#28, #30) | none | Touch prod ([Deploy to dev](#credentials)) |
| GitHub environment `production` | Prod deploy key (`focus-ci prod`), host key line | `deploy-prod.yml`'s `deploy` job (#29) | **Yacine**, every run | Deploy without his approval |
| GitHub environment `rollback` | Prod rollback key (`focus-ci rollback-prod`), host key line | `rollback.yml` for prod (#30) | none | Deploy anything new ([Rollback](#credentials-2)) |
| GitHub environment `oncall` | `ANTHROPIC_API_KEY` (Claude API, with a monthly spend limit) and `GRAFANA_READONLY_TOKEN` (Grafana Cloud **Viewer**) | `.github/workflows/oncall.yml` (#35): the Claude sessions, and the `wait` step for the Grafana token | none, so it works at any hour | Write to GitHub: the sessions' workflow token is read-only |
| | `REVIEWER_APP_KEY`: a separate private key of the reviewer App (#70) | `oncall.yml`'s `post-review` step only, never a session | | Push, or approve its own push ([infra/github/README.md](../infra/github/README.md#reviewer-github-app-70)) |
| | `ONCALL_APP_KEY`: the private key of the on-call App, `ineedtofocus-oncall` (#35) | `oncall.yml`'s push, PR and merge steps only, never a session | | Start, re-run or approve a workflow, or change `.github/workflows/` ([infra/github/README.md](../infra/github/README.md#on-call-github-app-35)) |
| Server, `/opt/focus/<env>/.env` (mode 600) | Grafana Cloud OTLP write token (`GRAFANA_CLOUD_OTLP_TOKEN`) | That environment's collector (#32) | n/a | Read telemetry ([observability.md → Credentials](observability.md#credentials)) |
| Grafana Cloud contact point `focus-oncall-github` | Fine-grained GitHub token, this repo, Contents write | Grafana's webhook, to send the alert dispatch (#34) | n/a | Approve or start a deploy ([observability.md → The token](observability.md#the-token)) |

The workflow token (`GITHUB_TOKEN`) is set per job with `permissions:`. Every workflow starts from `permissions: {}` or `contents: read`, and only `ci.yml`'s `publish` job can write packages or sign attestations.

### On-call workflow (#35)

`.github/workflows/oncall.yml` runs the on-call agent when an alert fires or resolves ([observability.md → On-call agent](observability.md#on-call-agent-35)). **No Claude session holds a token that can write.** The three sessions (on-call, reviewer, follow-up) get a read-only workflow token and the Claude and Grafana keys, and leave files behind: a decision, a comment, a git bundle, a review. Deterministic jobs on a fresh runner and a fresh checkout check those files (`scripts/oncall.py`) and do every write to GitHub.

| Job | Session? | Workflow token | Secrets (step) | Does |
|---|---|---|---|---|
| `alert` | no | `contents: read` | none | Check the payload |
| `incident` | no | `issues: write`, reads | none | Find the incident issue or open it, and lock it if it isn't; the daily run cap |
| `respond` | **on-call** | read-only | Claude key, Grafana token | Investigate; write `decision.json`, `comment.md` and, for a fix, commits on `oncall/<n>-<slug>` |
| `act` | no | `contents: read`, `issues: write` | `ONCALL_APP_KEY` (push and PR step) | Check the decision; post the comment and labels; push the fix branch and open the PR as the on-call App, or post it as a patch; close a resolved incident |
| `rollback` | no | `actions: write` only | none | Start `rollback.yml` once, for the alert's environment, and wait. No checkout, no repository code |
| `review` | **reviewer** | read-only | Claude key | Wait for CI; write the review body and verdict |
| `post-review` | no | `contents: read`, `pull-requests: write` (fallback comment) | `REVIEWER_APP_KEY` (post step) | Post the checked review through `scripts/reviewer-review.sh` |
| `merge` | no | `issues: write`, reads | `ONCALL_APP_KEY` (merge step) | Squash-merge on `reviewDecision` `APPROVED` and green required checks, as the on-call App (dev deploy); post the prod ask |
| `wait` | no | none | Grafana token | Wait for the alert to resolve |
| `follow-up` | **on-call** | read-only | Claude key, Grafana token | Write the report from the steps' checked results |
| `report` | no | `issues: write` | none | Post the report, or `⛔ Needs Yacine:` |

- **It can't push to `main`.** No workflow token has `contents: write`. The on-call App's pushes go to `oncall/<n>-<slug>` only, and branch protection holds against it like against every identity: the five CI checks, and an approval from someone other than the last pusher (the reviewer App), administrators included.
- **It can't put new code on prod.** No job holds a deploy key or runs in `production`. The rollback job starts `rollback.yml` only, whose key can only restore a known-good release. Nothing here can approve a deployment: the workflow token can't, and neither App has the Actions or Deployments permission.
- **A failure always says so.** The `incident`, `act` and `merge` jobs end with an `if: failure()` step that posts `⛔ Needs Yacine:` on the incident, for example after a refused push, a failed token mint or a failed `gh` call. Failures in `review`, `post-review`, `rollback` or `wait` reach the `merge` or follow-up report, and a follow-up that doesn't finish reaches `report`.
- **What reaches a write is checked.** A rollback is a decision the `act` job checks: the alert's own environment, firing, a 40-hex `tag` or none, and not when the incident already carries `oncall:rolled-back`. The `rollback` job checks it again against what the `incident` job read before any session ran. That re-check is the real boundary, because those outputs come from a job no session ran in. A fix branch is checked too: its name, its base, at most 20 files and 1000 lines, a test file, no closing keyword in its commit messages (`#n`, `owner/repo#n` or an issue URL), and no change under `.github/`, `.claude/` or `infra/github/`, to `scripts/oncall*`, to the modules `oncall.py` imports, or to `scripts/reviewer_token.py` and `reviewer-review.sh`. The check reads paths raw (`-z`, so a non-ASCII name isn't quoted past the patterns) and counts renames as a deletion plus an addition (`--no-renames`), so moving a protected file away is refused like deleting or editing it. The squash commit's subject and body are the workflow's own text. Every check runs on a fresh runner from a fresh checkout. Only the session's checked files cross to it: `decision.json`, `comment.md`, `pr.md` and `fix.bundle` as an artifact, the review's two files, the follow-up's report. No cache crosses: every `setup-uv` and `setup-node` in the workflow has caching off (`enable-cache: false`, `package-manager-cache: false`, tested). Otherwise a session could leave files in a cache that a job holding an App key restores and runs.
- **One rollback per environment and per incident.** The rollback job has a per-environment concurrency group, and skips if that environment had a successful or running rollback in the last 30 minutes. It finds its run by the run's title among runs that weren't there before the dispatch. The incident's `oncall:rolled-back` label makes `decision` refuse a second rollback for it. Only triage access can add or remove a label.
- **What a session can still leak.** A session holds the Claude API key and the Grafana token, and `.claude/settings.json` allows `python3`, so an injected session could send them out. The backstops are the Anthropic spend limit on that key and the token's Viewer role, which reads telemetry and changes nothing. A leaked key or token gets revoked and replaced in `oncall`. Neither App key is ever in a session's job.
- **What it can do to dev without a real review.** Both App keys are in `oncall`, so a run could push, approve and merge a PR to `main`, which deploys it to dev, if the reviewer session approves a bad fix. That's the price of an unattended merge to dev (AC4, AC8). Prod still waits for Yacine.
- **Cost.** Each session has a turn cap, a dollar cap and a step timeout: on-call 60 turns and USD 10, the reviewer 40 and USD 5, the follow-up 40 and USD 6. The `incident` job counts this workflow's runs for the same alert and environment in the last 24 hours: from the fifth, it starts no session and posts `⛔ Needs Yacine:` once. The Anthropic spend limit is the backstop.

## App image and migrations

One image (root `Dockerfile`, #4) serves the API and the built frontend. Its entrypoint (`infra/app/entrypoint.sh`) runs `alembic upgrade head` and then starts the server. A failed migration exits non-zero, so the container never serves on a schema it doesn't expect.

| `MIGRATE_ON_START` | Behaviour | Use |
|---|---|---|
| `1` (default) | Migrate, then start | Local stack (`make up`) |
| `0` | Skip migrations and start (logs that it skipped) | Deploys and rollbacks |

The default doesn't suit rollbacks: an older image started against a database that a newer image migrated fails with `Can't locate revision …` and never serves. Migrations are expand-only (`backend/tests/unit/test_migration_safety.py`), so the older app runs fine on the newer schema once the step is skipped. A deliberate contract migration is the exception, and the [rollback floor](#rollback-floor-165) keeps rollbacks above it. Deploys therefore run migrations as their own one-shot step (`infra/compose.sh <env> run --rm app alembic upgrade head`), and `infra/compose.prod.yml` runs the app with `MIGRATE_ON_START=0` ([Running it on the server](#running-it-on-the-server)). That way a rollback only swaps the image tag.

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
| `deploy` user | For CI only. No usable password (`*`), shell `/bin/bash` (needed to run forced commands), member of `docker`, **no sudo**: the script removes it from `sudo`/`admin` and stops if a sudoers rule names it. Its keys live in `/etc/ssh/authorized_keys/deploy`, owned by `root:deploy`, mode 640, so the account can't add keys of its own. The script creates that file once, empty apart from a comment showing the format, and never changes it afterwards. It warns about any key line that lacks `restrict` or `command="…"`, naming which one and the line number. It reads each line's options field the way sshd does: in any order (`restrict,command="…"` and `command="…",restrict` both pass), option names case-insensitive, and a comma or the word `restrict` inside the quoted command doesn't count |
| SSH hardening | `/etc/ssh/sshd_config.d/00-focus-hardening.conf`: `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`. Named `00-` because the first value wins, so it beats cloud-init's `50-cloud-init.conf`. A `Match User deploy` block reads keys from `/etc/ssh/authorized_keys/%u` (not `~deploy/.ssh`) and turns off PTYs, forwarding, tunnels and `~/.ssh/rc`. The new file is checked with `sshd -t` before sshd reloads; if the check fails, the previous file is put back and the script stops. Open sessions aren't affected |
| `/opt/focus` layout | `/opt/focus` (root, 755); `/opt/focus/bin` (root, 755) for the forced-command scripts (#28–#30), root-owned so `deploy` can't change what its own keys run; `/opt/focus/prod` and `/opt/focus/dev` (`deploy`, 750) with their `.env` files set to `deploy`, 600. The `.env` contents are never read or changed; a missing one is a warning |

The `docker` group is root-equivalent. That's acceptable only because no `deploy` key can open a shell: each one is pinned to a root-owned forced command.

**Re-running is safe.** The script only writes files whose content differs, installs only missing packages (it never upgrades installed ones), and leaves the `.env` contents and the deploy keys alone. A second run on a configured server changes nothing. Re-run it after changing it in the repo.

**It fails loudly.** If writing a managed file fails at any step (temporary file, compare, install, chmod or chown), or a directory sits where the file belongs, the script stops there with `ERROR: writing <path>: …` and exit status 2 (every `ERROR:` exits 2), so it can't report success with a file missing or left with the wrong permissions (#80). Fix the cause and run it again. Fetching Docker's signing key retries a transient failure 3 times.

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

### Dependency images (#170)

Every image but the app's is pinned by tag **and** digest, `name:tag@sha256:<digest>`: Postgres and the OpenTelemetry Collector in `compose.prod.yml`, Caddy in `compose.edge.yml`. The digest is the multi-platform index digest, so a pull can't change the bytes under a deploy, and neither can a re-pushed tag on Docker Hub. `make test-infra` fails on an image without both (`scripts/check_prod_compose.py`). `compose.yaml` and CI's Postgres service keep the plain tag (`postgres:17-alpine`), the same tag as prod.

| Image | Pinned |
|---|---|
| `postgres:17-alpine` | `sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb` (PostgreSQL 17.11 on Alpine 3.24; linux/amd64 built 2026-10-21) |
| `otel/opentelemetry-collector-contrib:0.162.0` | `sha256:39923a8e431bd1f57be82411999d389fcfe40857492e4365456d97a4c1f74be6` (linux/amd64 built 2026-09-29) |
| `caddy:2.11.4-alpine` | `sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b` (linux/amd64 built 2026-09-17) |

**Who pulls them.** Compose never pulls on the server: deploys and `install.sh` start everything with `--pull never`, so what starts is what was pulled, by digest. Before that:

- `focus-ci` (deploy, rollback and the automatic revert, under the deploy lock and with the clean environment) lists the environment's images with `compose config --images`. In the `pull` step, before any migration or start, it pulls each one other than the app's that the host lacks, by its pinned digest, then the app's by its digest as before. A failed pull stops at `pull` with `could not pull <image>, which focus-<env> needs`. Nothing has run then: the running app, the host-wide `:<sha>` tag and the record are unchanged. An image that isn't pinned is refused there too, never pulled by tag. Dev's first deploy failed at `migrate` before this (#28): Compose found no collector image and wasn't allowed to pull one.
- `install.sh`, also under the lock, pulls Caddy's image and, for each environment with a release, Postgres' and the collector's. It reads them from the new `infra/` before installing it, so a failed pull installs nothing.

**Bumping one** (a Postgres minor or Alpine rebuild, a collector or Caddy release) is a PR that changes the tag and digest together. Read the digest with `docker buildx imagetools inspect <name>:<tag>` (the `Digest:` line at the top, the index). After the merge, `install.sh` pulls the new image (Caddy is recreated then), and each environment's next deploy recreates its Postgres and collector from it. A Postgres image change restarts the database: a clean shutdown and start on the same volume, a few seconds of `/readyz` failing for the app that runs. Stay within one Postgres major: a new major can't open the old data directory and needs a dump and restore, which is its own issue. A new minor or an Alpine rebuild within a major is safe. Postgres' on-disk format is fixed within a major. The databases use the default libc collation, and musl's (Alpine's libc) is plain code point order, so a rebuild doesn't reorder text indexes.

**Pruning (#117) never touches them.** `focus-ci` removes only `ghcr.io/ybenzine/ineedtofocus` images ([Old images](#old-images-pruning-117)), so the pinned images of the installed `infra/` stay on the host. A rollback's target uses today's installed compose files, so it needs exactly those. If one goes anyway (a manual `docker image prune -a`, say), the next deploy or rollback pulls it again by digest, but only while Docker Hub answers: never run `docker image prune -a` or `docker system prune -a` on the server. After a bump, the old pinned image isn't referenced any more and stays until removed by hand (`docker image rm <name>:<tag>@sha256:<old digest>`).

### Memory: dev can't starve prod

| Container | prod | dev |
|---|---|---|
| app | 320 MiB | 256 MiB |
| Postgres (`shared_buffers`) | 256 MiB (64 MB) | 128 MiB (32 MB) |
| OpenTelemetry Collector | 96 MiB | 96 MiB |
| Caddy (shared) | 96 MiB | |

The limits add up to 1,248 MiB. Adding a one-shot migration container (up to 320 MiB) gives 1,568 MiB, under the 1,600 MiB budget that leaves about 350 MiB of the 2 GiB Droplet to the kernel, dockerd, containerd and sshd. So the limits never overcommit the host. Dev's containers also get `oom_score_adj: 500`, so the kernel kills them first if memory runs out anyway, and a quarter of prod's CPU weight (`cpu_shares` 256 against 1024). The collectors run with `GOMEMLIMIT` and a `memory_limiter` at 80% of their limit. `make test-infra` fails if the limits break these rules (`scripts/check_prod_compose.py`).

### Host resources: processes, privileges, disk (#117)

Every merge deploys agent-written code to dev, on the Droplet prod shares. Memory and CPU are bounded above; `infra/compose.prod.yml` bounds the rest, the same for prod and dev:

| Service | `pids_limit` | Capabilities | `no-new-privileges` | Root filesystem | Writes to |
|---|---|---|---|---|---|
| app | 128 | `cap_drop: [ALL]` | yes | read-only (`read_only: true`) | `/tmp`, a 16 MiB tmpfs |
| Postgres (`db`) | 128 | `cap_drop: [ALL]`, runs as `user: postgres` | yes | writable (below) | its data volume, `/var/run/postgresql` |
| OpenTelemetry Collector | 128 | `cap_drop: [ALL]` | yes | read-only | nothing |

- **Disk.** A container's writable layer has no size limit of its own: `storage_opt: size=…` needs overlay2 on XFS with project quotas, which the Droplet's ext4 root doesn't have. So the app and the collector can't write to their root filesystem at all. The app runs as uid 10001 with `PYTHONDONTWRITEBYTECODE=1` and writes only temporary files, to `/tmp`, a tmpfs of 16 MiB. A tmpfs lives in memory and counts towards the container's `mem_limit`, so a runaway write there ends in an out-of-memory kill of that container, never in a full disk. The one-shot migration container (`run --rm app alembic upgrade head`) gets the same settings.
- **Processes.** `pids_limit` counts threads too. 128 is several times what each service runs: one uvicorn process with its threads, Postgres' 40 connections plus its background workers, the collector's Go threads. A fork bomb or a thread leak in dev stops at 128 and can't exhaust the host's process table.
- **Privileges.** The app and the collector already run as non-root users; with no capability and `no-new-privileges`, nothing in them can gain one (no setuid binary works). Postgres runs as the image's `postgres` user from the start, so it needs no capability either. Started as root, its entrypoint would chown the data directory and then switch users, which needs `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID` and `SETGID`. The data directory is `postgres`'s already: the image creates it so, and on the server the root entrypoint that started Postgres until now made it so (checked by hand: a volume set up that way starts with the new settings and keeps its data).
- **The exception: Postgres' root filesystem stays writable.** Outside its volume it writes its socket and lock file (`/var/run/postgresql`), and its data, the one thing that grows, lives in the volume whatever the root filesystem is. Making it read-only would add tmpfs mounts for little.
- **Caddy** (`compose.edge.yml`, shared by both environments) isn't covered by this issue: changing it recreates Caddy, a few seconds without HTTPS for both sites. It runs no agent-written code.

`scripts/check_prod_compose.py` (`make test-infra`) fails if a service of prod or dev has no positive `pids_limit`, doesn't drop every capability, adds one back, is privileged or lacks `no-new-privileges`, or if the app or the collector isn't read-only, has a tmpfs without a size or mounts a writable volume (which would undo the disk bound). `make test-prod-stack` runs the whole stack with these settings (CI's `image` job runs it too).

**Reaching the server:** these settings, like every `infra/` change, apply once Yacine installs the merge commit with `install.sh` ([below](#infra-on-the-server-installsh)): a deploy recreates the app, and each environment's next deploy recreates its Postgres (a few seconds of `/readyz` failing, as for an image bump) and its collector.

### Image build and publish

One image (root `Dockerfile`, multi-stage: Vite build, locked uv dependencies, slim non-root runtime) serves the API and the built frontend. `.github/workflows/ci.yml` has two jobs for it besides the five required checks:

- **`image`** (every PR and push) runs `make test-infra`, builds the image as `ghcr.io/ybenzine/ineedtofocus:<sha>`, and runs `make test-prod-stack` on it: the real edge, prod and dev projects, with Caddy on its internal CA ([testing.md](testing.md)). On `main` it keeps the tested image as a one-day artifact.
- **`publish`** (push to `main` only) pushes that same image, tagged with the commit SHA only (no `latest`). It `needs:` the five required jobs and `image`, so only a commit that passed all of CI is published. It's the only job with `packages: write`, using `GITHUB_TOKEN` (no stored secret), and it checks out no code. Pull requests, forks included, never push, and no tag or release trigger publishes anything. It then attests the pushed digest ([Build provenance](#build-provenance-128)); it's also the only job, in any workflow, with `id-token: write` and `attestations: write`.

**Dev deploy hook (#28):** add a `deploy-dev` job with `needs: publish`, or a workflow triggered by `workflow_run` on `CI` that checks `conclusion == 'success'` and deploys `github.event.workflow_run.head_sha`. Either way, a red `main` never reaches dev.

### Running it on the server

The server runs a root-owned copy of `infra/` in `/opt/focus/infra`, installed by Yacine with `infra/server/install.sh` ([Infra on the server](#infra-on-the-server-installsh)). The deploy keys run only the forced command `/opt/focus/bin/focus-ci`, which runs these steps for one environment ([Deploy to dev](#deploy-to-dev-28)):

```bash
export APP_TAG=<sha>                                            # passed with env -i, nothing else
infra/compose.sh dev config --images                            # each one but the app's: pinned (#170)
docker pull postgres:17-alpine@sha256:<digest>                  # each one the host lacks, by digest
docker pull ghcr.io/ybenzine/ineedtofocus@sha256:<digest>      # public package: no login needed
docker tag ghcr.io/ybenzine/ineedtofocus@sha256:<digest> ghcr.io/ybenzine/ineedtofocus:<sha>
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

Each environment's app sends OTLP to its own collector (`infra/otel-collector/config.yaml`). The collector adds `deployment.environment.name` and forwards to Grafana Cloud over OTLP/HTTP with basic auth. It does that once `GRAFANA_CLOUD_OTLP_ENDPOINT`, `GRAFANA_CLOUD_INSTANCE_ID` and `GRAFANA_CLOUD_OTLP_TOKEN` are in `/opt/focus/<env>/.env`; both files have them since #32. While the endpoint is empty, the collector accepts the data and drops it, so deploys don't depend on Grafana Cloud. The token is never in git or in GitHub secrets. After changing these values, recreate the collector: `APP_TAG=<current tag> infra/compose.sh <env> up -d otel-collector`. One collector per environment stays (#32): the reasons, the Grafana Cloud stack, how to check both environments arrive and the dashboards are in [observability.md](observability.md#grafana-cloud-32).

### Human steps (Yacine)

Both steps 1 and 2 were done on 2026-10-23: the package is Public, so the server pulls anonymously, and each `.env` has its own `POSTGRES_PASSWORD`.

1. **After the first image is published** (the first push to `main` after this lands), make the package public. A new package in a personal account starts out private, so the server couldn't pull it without a token. On github.com, go to your profile → **Packages** → `ineedtofocus` → **Package settings**. Under **Danger Zone**, choose **Change visibility** → **Public**, then type `ineedtofocus` to confirm. If it already shows Public, there's nothing to do. The repository is public already. Under **Manage Actions access** on the same page, `ybenzine/ineedtofocus` should be listed: the workflow that created the package gets access automatically. If it isn't listed, add it with the **Write** role.
2. **Before the first deploy (#28)**, put `POSTGRES_PASSWORD=<openssl rand -hex 32>` in both `/opt/focus/prod/.env` and `/opt/focus/dev/.env`, with a different value in each. Keep the files at mode 600, owner `deploy`. Anything else copied from `.env.example`'s local sections has no effect there, except `LOG_LEVEL` and the operator-only alert trigger `FAULT_SAVE_ERROR_PERCENT` (#33, off unless set; [observability.md → Alert trigger](observability.md#alert-trigger-fault-injection)).
3. **With #32** (done 2026-10-25), add the three `GRAFANA_CLOUD_*` values to both files.

## Infra on the server: `install.sh`

The deploy keys run Docker, and the `docker` group is root-equivalent. So whoever controls the compose files the keys run controls the whole host, prod included. Those files therefore change only when Yacine installs them. A merge to `main` doesn't change them, and neither does a deploy key. `infra/server/install.sh <sha>` (root, run with sudo) does it:

1. Clones `main` from GitHub over HTTPS (bare, that branch only) and checks that `<sha>` is on `main`. `infra/` at `<sha>` must hold regular files only.
2. Writes the full diff between the installed files and `infra/` at `<sha>` to `/root/focus-install-<sha>.diff` (root, 600). It lists the commits and the changed files, then asks: type `yes` to install, `diff` to page through the whole diff first, or anything else to stop with nothing changed. With no terminal (no `ssh -t`) it stops too. `--yes` skips the question, for the test harness only.
3. Under `/opt/focus/deploy.lock`, so it never swaps files under a running deploy: first pulls, by digest, the [pinned images](#dependency-images-170) the new `infra/` starts that the host lacks. That's Caddy's, and Postgres' and the collector's for each environment with a release. A failed pull stops here with `couldn't pull <image> (…): nothing installed`. Then it replaces `/opt/focus/infra` with `infra/` at `<sha>` plus a `REVISION` file, all `root:root` with nothing group- or world-writable. The previous copy stays in `/opt/focus/infra.previous`. Then it installs `infra/server/focus-ci.sh` as `/opt/focus/bin/focus-ci` (root, 755).
4. Starts or updates the edge, with `--pull never`. Caddy is recreated when its image or the Caddyfile changed, because a running container keeps seeing the old file: a few seconds without HTTPS for both sites. When `infra/otel-collector/` changed, it also recreates each deployed environment's collector.
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
| Provenance | runner, `gh` | `gh attestation verify` on the digest, before the key is written: `publish` (ci.yml on `refs/heads/main`) must have attested exactly these bytes as built from this commit ([Build provenance](#build-provenance-128)). Otherwise the job fails and nothing reaches the server |
| Order | runner, `ssh … status`, `git` | Deploys only go forward ([Deploy order](#deploy-order-257)). If this commit is an ancestor of the one dev runs, it's older: skips with a notice, green, and dev keeps the newer one. The same commit (a re-run), a newer one or a first deploy (focus-ci's exact "no release recorded" answer) goes on. Fails red if the record has no valid tag, or if it can't place dev's commit in `main`'s history |
| Deploy | server, `focus-ci dev` | `ssh deploy@159.223.188.176 "deploy <sha> sha256:<digest>"`: waits for the deploy lock, notes the current release, pulls the [dependency images](#dependency-images-170) the host lacks, pulls the app by digest, checks the image's `org.opencontainers.image.revision` label is `<sha>`, tags it `:<sha>`, migrates (`run --rm`), starts (`up -d --wait`, the `/healthz` healthcheck), checks that the app container runs exactly that image and that `/healthz` and `/readyz` answer inside it, then records the release. If the start or a check fails, it starts the release that ran before again and fails ([Automatic revert](#automatic-revert)) |
| Record | runner | `ssh … status` reads the record back; the job fails if it doesn't show this tag and digest |
| Smoke | runner | `scripts/smoke_deploy.py https://dev.ineedtofoc.us`: `/healthz` and `/readyz` answer `{"status":"ok"}`, `/` serves the frontend, `http://` redirects to `https://`, the certificate verifies. Retried for up to 90 s |
| Summary | runner | Tag, image digest, provenance (with the CI run that built it), server time of the deploy, rollback target, infra revision, smoke results. When the provenance or order check failed, a line saying nothing was deployed and why |
| GitHub deployment | job `dev-deployment` | Only after `deploy-dev` deployed this commit and passed: creates the `dev` GitHub deployment, which deploy-prod's plan reads as what dev ran. `deploy-dev` itself runs with `deployment: false` |
| Catch-up | job `dev-catch-up`, runner, `gh api` (read-only) | After the order step decided (deployed or skipped): if `main`'s newest commit is newer and its `Deploy to dev` was cancelled, a warning "Dev is behind main" and a summary naming the job to re-run ([Deploy order](#deploy-order-257)). Never fails the run |

A failed step stops the deploy and exits non-zero, which turns the job red. The record keeps the last successful release, and the attempt is logged with the step that failed. A failure at the start (after `up`) also puts the previous release back ([Automatic revert](#automatic-revert)). To undo a deploy that passed its checks, run the [rollback workflow](#rollback-rollbackyml).

### Deploy order (#257)

A dev deploy never replaces a newer commit with an older one. Merges that land close together finish CI in any order. On 2026-10-25, three merges landed within two minutes, and the oldest one's `Deploy to dev` started last, after the newest had finished. It deployed anyway, and dev lost two merges with every job green.

So before the deploy request, the job reads dev's record (`ssh … status`) and compares commits in its checkout, which has `main`'s whole history (`fetch-depth: 0`). `main` is linear (squash merges), so "older" means an ancestor: if `git merge-base --is-ancestor <this commit> <dev's commit>` holds, the job skips with the notice "Dev deploy skipped", green, and sends nothing else. Otherwise it deploys:

- **The same commit** (a re-run of its job) deploys again, as before.
- **A newer commit** deploys. That includes a revert merged on `main`: it's a new commit, so it goes out like any fix.
- **A first deploy** deploys. Only focus-ci's exact answer for no record counts (#275): nothing on stdout and `focus-ci: no release recorded for dev yet` on stderr.
- **A record it can't read** fails red with "Dev's release unknown" and nothing deployed: `ssh … status` failed, or the record is empty, has no `tag=` line or a malformed one. Only `focus-ci` writes the record, atomically, so this means something is wrong on the server, not a first deploy.
- **A commit it can't place** (dev runs a commit missing from `main`'s history) fails red with "Deploy order unknown" and nothing deployed. See [Dev runs a commit that isn't on `main`](#dev-runs-a-commit-that-isnt-on-main) below.

The Summary of a failed check says so: "Not deployed: the order check failed, see its log (#257).", followed by the reason.

**Why in the workflow, not `focus-ci`.** Only git knows the order of commits, and the server has no clone of the repository: `/opt/focus/infra` is a copy of `infra/` at one revision. A check on the server would need git and the history there, or a call to GitHub, and every change to `focus-ci` needs Yacine to reinstall `infra/`. The check doesn't guard against a malicious client either: the dev key can already roll dev back. The workflow check is enough because only `deploy-dev` moves dev forward and its concurrency group runs one at a time. Nothing that could move dev forward runs between the check and the deploy. A dev rollback can, but it only goes back, and this commit is newer than what dev ran at the check.

**Why `cancel-in-progress` alone wouldn't fix it.** Jobs reach the `deploy-dev` group in the order their CI finishes, not in commit order. On 2026-10-25 the oldest commit's job arrived after the newest one's had finished: nothing was running or pending to cancel, and it would have deployed anyway. When jobs do overlap, `cancel-in-progress` would cancel a running *newer* deploy in favour of a late older one. A cancelled job doesn't even stop a deploy: `focus-ci` finishes it on the server. The job would just go red while the server records the release.

**What GitHub shows.** A skipped deploy is green, so with `environment: dev` GitHub would record it as a successful `dev` deployment of the older commit. deploy-prod's plan would then take that commit as "the release dev runs now", and the prod deploy would fail after approval with "Dev's record differs". So `deploy-dev` runs with `deployment: false`, like `rollback.yml`, and the small `dev-deployment` job creates the deployment once `deploy-dev` actually deployed and passed its smoke tests. A skip because the environment isn't set up creates none either.

**Deployments out of order (#275).** `dev-deployment` has no concurrency group, so commit A's can wait for a runner while commit B's whole `deploy-dev` runs. A's deployment is then created after B's, and GitHub marks B's inactive although dev runs B. So deploy-prod's plan doesn't take dev's newest deployment as "the release dev runs now". Of dev's last 30 deployments that reached success (latest status `success`, or `inactive`: superseded after one), it takes the newest *commit* on `main` (compare API). That's right because `deploy-dev` only moves dev forward: the newest commit it deployed is the one dev runs. Only a rollback moves dev back, so the plan only counts deployments created after dev's last `rollback.yml` run on `main`, whatever that run's outcome. With none since, it stops before the approval with "dev was rolled back … pass the tag explicitly", rather than offer the release dev rolled back from. Two deployments it can't order (a commit no longer on `main`) stop it too. The deploy job's resolve step still checks dev's own record, so whatever the plan picks, prod never gets a commit dev doesn't run.

**Why not the other two fixes.** Giving the plan dev's own record would need a credential before the approval: the prod key lives in `production`, and a read-only dev key would be a new environment, key and `focus-ci` profile for Yacine to set up and install. Having `dev-deployment` skip unless dev still runs its commit can't work: GitHub creates the deployment when the job starts, before any step, and a green job marks it a success. Only failing the job red would keep the deployment from succeeding, with the dev key in that job too.

**Rollback.** `rollback.yml` doesn't run this check: going back is its job, and it's unchanged. After a dev rollback, the check compares against the release dev runs then. So a commit newer than the rollback target deploys as usual, even one merged before the rollback whose CI was still running. A commit older than the rollback target is skipped. The [rollback floor](#rollback-floor-165) stays safe: dev's release is always at or above its floor, and a commit newer than it is too, so a deploy never brings back a schema a contract migration removed.

**A newer commit can still miss dev.** GitHub keeps one *pending* job per group ([Serialization](#the-forced-command-focus-ci)): the job that joins last replaces the pending one, whichever commit is newer. If an older commit's job replaces a newer one's, the newer one shows as cancelled and dev stays on an older commit until the next merge. Nothing older replaces something newer, though.

The replacing run says so (#275). Its `dev-catch-up` job looks up `main`'s newest commit. If that commit is newer than the run's own and its `Deploy to dev` was cancelled, the job writes the warning "Dev is behind main" and a summary with that job's link. Only the newest commit matters: if its deploy is still to come, dev gets there anyway. A newer commit whose CI failed isn't flagged, since a red `main` never deploys. To catch up, re-run that job: **Re-run job** on its page, or `gh run rerun --job <job id>` (in the summary). Its commit is newer, so it deploys, with its own run's `publish` digest and its own provenance check.

The job flags; it doesn't re-run anything itself. A re-run needs `actions: write` for the run's token, which no job here has. And the re-run joins the `deploy-dev` group as a pending job, where it can replace another pending deploy in turn. Re-running the newer commit's own job is the only safe catch-up: this run has only its own commit's digest and attestation, so it can't deploy `main`'s head itself.

#### Dev runs a commit that isn't on `main`

After a force-push to `main` (denied to agents) or anything else that drops dev's commit from `main`'s history, every dev deploy fails red with "Deploy order unknown": there's no telling whether a commit is newer than one git can't find. Dev keeps running that commit. To get out:

1. Pick a release dev ran that is on `main`: the newest `Tag (commit)` in an earlier `Deploy to dev` summary whose commit is still on `main` (`git merge-base --is-ancestor <sha> origin/main` after `git fetch`).
2. Roll dev back to it with the [rollback workflow](#rollback-rollbackyml): `gh workflow run rollback.yml -f env=dev -f tag=<sha>`. No approval is needed, and the server only starts a known-good release of dev above its [rollback floor](#rollback-floor-165). The [rollback runbook](runbooks/rollback.md) covers following the run and what its errors mean.
3. Re-run the red `Deploy to dev` job of `main`'s newest commit. Its commit is newer than the rollback target, so it deploys.

### The forced command: `focus-ci`

`/opt/focus/bin/focus-ci <profile>` (source `infra/server/focus-ci.sh`) accepts exactly these requests in `$SSH_ORIGINAL_COMMAND`, matched whole, in the C locale:

| Request | Profile `dev` | Profile `prod` (#29) | Profile `rollback-prod` (#30) | Does |
|---|---|---|---|---|
| `deploy <40 lowercase hex> sha256:<64 lowercase hex>` | yes | yes, only a sha and digest dev ran successfully and didn't roll back from | no | The deploy above, on that profile's environment, with the [automatic revert](#automatic-revert) |
| `rollback`, `rollback <40 lowercase hex>`, either followed by ` expect sha256:<64 lowercase hex>` | yes (dev) | no | yes (prod) | Starts a [known-good release](#known-good-releases) again by its recorded digest, no migration, same checks. Rolling back again goes further back, not forward. With `expect`, only if the current release is that digest (checked under the lock). Prints `result from_tag=… from_digest=… tag=… digest=…` |
| `status` | yes | yes | yes (prod) | Prints that environment's record |
| `candidate` or `candidate <40 lowercase hex>` | no | yes | no | Read-only: the tag and digest of dev's current release, or the last promotable digest of that sha dev ran ([Deploy to prod](#deploy-to-prod-29)) |

Anything else gets exit status 2 and `focus-ci: refused`, before anything runs: another verb, a verb the profile doesn't have, extra or malformed arguments, a shell, scp or sftp, a newline, or an unknown profile. Requests are logged to syslog (`journalctl -t focus-ci`). Every `docker` and `compose.sh` call runs under `env -i` with only `PATH`, `HOME` and `APP_TAG`, so nothing from the SSH session (such as `LC_*`, which sshd accepts) can override `infra/env/<env>.env`.

**Serialization.** Every deploy and rollback takes `flock /opt/focus/deploy.lock` (waits up to 15 minutes), across environments, and holds it through an automatic revert. `install.sh` takes the same lock. The memory budget counts one migration container at a time ([Memory](#memory-dev-cant-starve-prod)). In GitHub, `deploy-dev` has its own concurrency group (`deploy-dev`, no cancelling of the running deploy). Deploys of different environments don't share one group: GitHub cancels a *pending* job when another one joins the group, so a dev deploy queued behind a prod deploy would cancel a pending prod rollback. The server lock is what orders them. When merges queue up, the group keeps only the pending deploy that joined last: an intermediate commit's `Deploy to dev` shows as cancelled and dev goes straight to the last one. That's intended. The job that joins last is usually the newest commit's, but not always, since jobs join when their CI finishes: the [order check](#deploy-order-257) keeps an older one from replacing a newer release.

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

`/opt/focus/dev/releases.log` has one line per attempt: `time=… env=dev action=deploy|rollback|revert outcome=ok|failed tag=… digest=… previous_tag=… previous_digest=… infra=… [step=…]`. A rollback's ok line adds the release it left (`from_tag=… from_digest=…`). An automatic revert's line adds what failed (`failed_action=… failed_tag=… failed_digest=…`). A deploy's lines add, once its schema is read, the alembic head it migrates to (`schema=…`, #165). Before a deploy runs a contract migration, a floor line comes first: `action=floor outcome=set tag=… digest=… … schema=… contracts=<revision>[,<revision>…]` ([Rollback floor](#rollback-floor-165)). The log is what [known-good](#known-good-releases) is computed from, so it's never edited by hand. It's read strictly. A word that isn't `<lowercase key>=<value>`, or a key that appears twice, stops every deploy, rollback and `candidate` that reads the log, with `releases.log line <n> is malformed (<why>)`. That fails closed and loudly, never by reading the line loosely. Such a line comes from a write cut short (a full disk) or a hand edit. Yacine looks at it read-only (`sudo sed -n '<n>p' /opt/focus/<env>/releases.log`), then moves it out, and the next request works again. Blank lines are skipped. A last line without a newline still counts, and the next line written starts on a new line.

### Credentials

| Where | What | Who sets it |
|---|---|---|
| GitHub environment `dev` (deployment branches: `main` only, no reviewer) | `DEPLOY_SSH_KEY`: the private half of the `focus-ci-dev` key. `DEPLOY_KNOWN_HOSTS`: the Droplet's host key line | Yacine |
| `/etc/ssh/authorized_keys/deploy` | `restrict,command="/opt/focus/bin/focus-ci dev" ssh-ed25519 … focus-ci-dev` | Yacine (sudo) |

Nothing is stored at repo level. The key can only run the `dev` profile: deploy, roll back or read dev's release. Even if it leaked, it can't open a shell, deploy, roll back or start anything in prod's project, or change the compose files. Its deploys and rollbacks do [prune](#old-images-pruning-117) app images across both environments: focus-ci reads prod's records on the server for that, and can remove a prod release's image only outside prod's window (current, previous and newest 5 known-good), one a prod rollback would pull again by digest. What the image checks do and don't guarantee:

- `deploy` pulls only from `ghcr.io/ybenzine/ineedtofocus`, by digest, so the bytes deployed and recorded are the ones requested. A re-pushed tag can't swap them.
- The revision label check only proves the image *claims* to be built from `<sha>`. Anyone able to push to that package can set any label, and any workflow run in this repo that asks for `packages: write` can push there, including runs on PR branches. So the server's checks don't prove an image was built on `main`. `deploy-dev` proves it before asking: it deploys only the digest `publish` pushed, after verifying `publish`'s signed attestation for it ([Build provenance](#build-provenance-128)). The server doesn't check that attestation (#177), so another `dev`-environment job on `main` could still deploy unattested bytes with this key. Prod's own check is what stops those bytes there. The key itself is held only by the `main`-only `dev` environment.
- An image runs as dev's app, with the root-installed `compose.prod.yml`: no volumes, ports, Docker socket, privileges or host network, on dev's own networks and database. It can't write to its root filesystem, has no capability and at most 128 processes ([Host resources](#host-resources-processes-privileges-disk-117)), and old images are pruned ([Old images](#old-images-pruning-117)).

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
- **Host disk:** every deploy and rollback prunes old app images ([Old images](#old-images-pruning-117)). Check `df -h /` and `docker system df` now and then anyway: database volumes and container logs (3 × 10 MB per container) grow too. Never run `docker image prune -a` or `docker system prune -a`: they would remove the pinned [dependency images](#dependency-images-170), and a rollback would then depend on Docker Hub.
- **Rotate the key:** repeat steps 2–6, then remove the old line from `/etc/ssh/authorized_keys/deploy`.
- **Roll dev back:** `gh workflow run rollback.yml -f env=dev` ([Rollback](#rollback-rollbackyml)).

## Deploy to prod (#29)

Prod deploys are manual and approved by Yacine. `.github/workflows/deploy-prod.yml` (workflow `deploy-prod`) starts only from **Actions** → **deploy-prod** → **Run workflow**, on branch `main`, with one optional input, `tag`. No push, tag or release starts it: the reviewer App can create tags (#70). The gate is the `production` environment's required approval.

**The gate holds against agents (#127).** Agents run `gh` and `git push` as the machine account `merciful-poseidon` (sessions start with `claude-focus`), never as Yacine. It has write access but isn't a repo administrator and isn't a `production` reviewer, so it can start a run but can't approve one, and can't edit the environment or its reviewers. Yacine is the only reviewer, and administrators can't bypass the rule. Secret values can't be read through the API. The account can most likely overwrite the environment's secrets, though: GitHub lets collaborators with write access set them. That could break prod deploys, but not get one through, since every run still needs Yacine's approval and a replaced SSH key can't log in to the server. `.claude/settings.json` denies `gh secret set` and asks before `gh api` calls on environments (#52). Setup, the read-only checks and the residual risk (Yacine's own login on the same machine) are in [infra/github/README.md → Agent account](../infra/github/README.md#agent-account-127). As a second line, `.claude/settings.json` denies the obvious commands for starting and approving a prod deploy (#126):

| Path | Rule |
|---|---|
| Start by file or workflow name: `gh workflow run deploy-prod` or `deploy-prod.yml`, also quoted, as a path or after flags | Denied: `gh workflow run deploy-prod*` and `gh workflow run *deploy-prod*`. The workflow's `name:` is `deploy-prod`, so starting it by name matches too |
| Start by numeric workflow ID: `gh workflow run <id>` | Denied: `gh workflow run 0*` … `gh workflow run 9*`, one rule per first digit |
| Start through the API: `…/actions/workflows/<id>/dispatches` | Denied: `gh api *dispatches*` |
| Approve a waiting run: `gh api -X POST …/actions/runs/<id>/pending_deployments` with `state=approved` | Denied: `gh api *pending_deployments*`. Reading a run's pending deployments is denied too; the run page shows them |
| Approve through GraphQL: the `approveDeployments` mutation | Denied when the query is in the command: `gh api *approveDeployments*` |
| Re-run a past run: `gh run rerun <id>`, `gh api …/runs/<id>/rerun` | **Not denied**, on purpose (below) |
| Roll back: `gh workflow run rollback.yml …` (#30) | Allowed. `scripts/tests/test_claude_settings.py` checks that the rules above are present and that no deny or ask rule matches a rollback command, so the on-call agent never stalls |

**Re-runs are left open.** A run ID doesn't say which workflow it belongs to, so no rule can tell a `deploy-prod` re-run from a CI re-run, and agents re-run CI routinely. A re-run of `deploy-prod` still can't reach prod on its own: a full re-run re-runs `plan`, which picks dev's current release, and its `deploy` job waits for the `production` approval again. Approving it is what the agent account can't do (#127) and what the `pending_deployments` and `approveDeployments` rules deny, which breaks the re-run-then-approve chain. A re-run reaches prod only if Yacine approves it on the run page, so read its plan summary first.

**What the rules don't catch.** Like every rule in that file, they match command text, so they prevent mistakes, not determined misuse. A numeric ID after a flag (`gh workflow run --ref main <id>`) or in quotes gets through: a rule such as `gh workflow run * 1*` would also match a rollback tag, which is a commit sha. So does a GraphQL query read from a file (`-F query=@file`), and any command run through an allowed wrapper (`uv run`, `npx`, `python`, `node`, `docker exec`), `bash -c`, `env` or an absolute path to `gh`. The approval behind them is what holds: an agent that gets past a rule still can't approve the run with its own credential (#127).

**Prod gets what dev ran.** Leave `tag` empty to deploy the release dev runs now, or give a full commit sha (40 lowercase hex) that dev ran successfully at some point. "Successfully" means two things. The `plan` job requires a `dev` GitHub deployment of that sha that reached `success`, so `deploy-dev` passed its smoke tests. The server requires an ok line in dev's `releases.log`, so focus-ci's checks passed. An explicit sha lets you deploy, for example, a release dev ran before newer merges reached it. Going back is a rollback, not a deploy (#30): a deploy migrates, and an older image can't run `alembic upgrade head` on a schema a newer one migrated. That deploy stops at the `migrate` step with nothing changed. Either way the workflow deploys a digest, never a registry tag. That digest is read from dev's own records on the server. It's normally the one `publish` pushed and `deploy-dev` deployed. Before any deploy request, the job checks that it is: `publish` must have attested those exact bytes as built from the approved commit on `main` ([Build provenance](#build-provenance-128)). The server checks it again before deploying: `focus-ci prod` refuses a sha and digest that have no successful line in `/opt/focus/dev/releases.log`, or that dev rolled back from since ([Known-good releases](#known-good-releases)). So a tag re-pushed to the registry, or a digest nobody deployed to dev, can't reach prod.

| Step | Where | What |
|---|---|---|
| Plan | job `plan`, runner, no credentials | Checks the input: empty, or 40 lowercase hex. Empty means the release dev runs now: the newest commit among dev's GitHub deployments that reached `success` since dev's last rollback run ([Deployments out of order](#deploy-order-257)). Checks that the commit is on `main` (compare API), that a `CI` run on `main` passed for it, and that a `dev` deployment of it reached `success` (dev's smoke tests passed). Writes the commit to the summary and passes the sha on. Yacine approves that one commit |
| Approval | job `deploy`, environment `production` | Waits for Yacine: the run page shows **Review deployments**. Read the plan's summary, then tick `production` → **Approve and deploy**, or **Reject**. The environment's branch rule only lets runs from `main` in |
| Gate | runner | Neither `DEPLOY_SSH_KEY` nor `DEPLOY_KNOWN_HOSTS` in `production`: skips with a notice, green, nothing changes on prod. Only one of them: fails red. Both: deploys |
| Resolve | runner, `focus-ci prod`: `candidate` | Empty input: `candidate`, dev's current release. If dev's record doesn't show the planned sha, the job stops and deploys nothing, since that's not what was approved. Either dev moved after the plan (a newer deploy, or a rollback), or dev's latest deploy passed the server checks but failed its smoke tests, so the plan skipped it. A sha: `candidate <sha>`, the last digest of that commit dev ran successfully. Read-only: no docker call, no lock, no write. A dev key put in `production` by mistake can't run it, so the job stops here |
| Provenance | runner, `gh` | `gh attestation verify oci://ghcr.io/ybenzine/ineedtofocus@<digest> --repo ybenzine/ineedtofocus`, pinned to the signer workflow `.github/workflows/ci.yml` at the approved commit, source ref `refs/heads/main`, source digest = the approved commit, a GitHub-hosted runner and SLSA provenance ([Build provenance](#build-provenance-128)). No such attestation for that digest, or one that doesn't match: the job fails here and no `deploy` request is sent. The summary links the CI run that built the image |
| Deploy | server, `focus-ci prod`: `deploy <sha> sha256:<digest>` | Under the deploy lock: the `promote` check above, then the same steps as dev on `focus-prod`. It pulls by digest when the host doesn't have it and checks the revision label. It re-tags the host-wide `:<sha>` from the digest, which dev's deploys may have moved. Then it migrates, runs `up -d --wait`, checks that the app container runs exactly that digest and that `/healthz` and `/readyz` answer, and records the release. If the start or a check fails, it starts prod's previous release again and fails ([Automatic revert](#automatic-revert)) |
| Record | runner | `status` reads `/opt/focus/prod/release` back; the job fails unless it shows `env=prod` and this tag and digest. Then the key is deleted from the runner, before any repository code runs |
| Smoke | runner | `scripts/smoke_deploy.py https://ineedtofoc.us`, the same checks as dev's |
| Summary | runner | Tag, image digest, provenance (with the CI run that built it), when dev ran it, when prod got it, rollback target (the previous tag), infra revision, smoke results |

The prod record and log have the same format as dev's ([The release record](#the-release-record)), in `/opt/focus/prod/`. A failed step stops the deploy and turns the job red. The record keeps the last good release, and the attempt is logged with the step that failed (`step=promote` when dev never ran it, or rolled back from it). A failure after `up` also puts prod's previous release back ([Automatic revert](#automatic-revert)).

**One prod deploy at a time.** The `deploy` job has its own concurrency group, `deploy-prod`, which never cancels a running deploy. A second run waits; a third one replaces the waiting second one, so the newest request wins. Reject runs you won't approve rather than leaving them waiting, since a waiting run can hold the group. The group isn't shared with `deploy-dev` or #30's `rollback.yml`, because GitHub cancels a *pending* job when another one joins its group. Deploys of both environments are ordered on the server by `/opt/focus/deploy.lock` instead.

### Credentials

| Where | What | Who sets it |
|---|---|---|
| GitHub environment `production` (required reviewer: Yacine; deployment branches: `main` only; administrators can't bypass) | `DEPLOY_SSH_KEY`: the private half of the `focus-ci-prod` key. `DEPLOY_KNOWN_HOSTS`: the Droplet's host key line (the same line as dev's) | Yacine |
| `/etc/ssh/authorized_keys/deploy` | `restrict,command="/opt/focus/bin/focus-ci prod" ssh-ed25519 … focus-ci-prod` | Yacine (sudo) |

Nothing is stored at repo level, and the `plan` job holds no credential. Every job that reads a secret other than `GITHUB_TOKEN` runs in an environment (`scripts/tests/test_ci_workflow.py` checks every workflow). Only a job of an approved run, on `main`, can read the prod key, and only Yacine can approve it: agents' account isn't a `production` reviewer or an administrator (#127). So a workflow edit merged by an agent can't reach the prod key without Yacine either. And the key can only run `focus-ci prod`, whose limits hold whatever the workflow says.

The prod key itself sits on the runner's disk only from **Set up the deploy key** to just after **Read the server's release record**. It's deleted before `scripts/smoke_deploy.py`, the first repository code the job runs, and again in the final `always()` step.

What each key can do:

- **Prod key** (`focus-ci prod`): deploy to prod a release dev ran successfully (and didn't roll back from), read prod's record, and read dev's record and log (`candidate`). It can't deploy or roll back dev, roll prod back (the [rollback key](#credentials-2) does that), open a shell or change the compose files. If it leaked, the worst it could do is redeploy to prod a release dev once ran (an older one stops at `migrate` once prod's schema is newer). Used outside this workflow, it skips the provenance check, which runs on the runner, not the server (#177). So it brings no new code only as long as dev ran nothing but `publish`'s images: `deploy-dev` checks that, the server doesn't enforce it.
- **What the approval binds: the commit and its bytes (#128).** Yacine approves a commit. The digest still comes from dev's `releases.log`, which records whatever the dev key asked for, and an image's revision label is self-declared. But before any `deploy` request, the job verifies that digest's [build provenance](#build-provenance-128): a Sigstore-signed attestation, from this repository, that `.github/workflows/ci.yml` on `refs/heads/main` built exactly those bytes from the approved commit. Only `publish` can sign one: the check identifies `ci.yml`, not the job, so this rests on no other job getting `id-token: write` or `attestations: write` (enforced by the workflow tests in `scripts/tests/test_ci_workflow.py`). An image pushed by any other run, PR-branch runs included, or built from another commit, has no matching attestation, so the job stops before the server is asked to deploy it. Approving commit X therefore deploys only bytes `publish` built from X. This holds as long as `deploy-prod.yml` on `main` keeps the step. The check is in the workflow, so an agent-merged edit that removed it, or a leaked prod key, isn't covered. A check inside `focus-ci` would be: #177.
- **Dev key** (`focus-ci dev`): can't deploy, roll back or read anything on prod. `candidate` is refused, and its `deploy`, `rollback` and `status` act only on `focus-dev` and `/opt/focus/dev/`. The one exception is pruning after its deploys and rollbacks, which reads prod's records on the server and may remove prod's images outside prod's window ([Old images](#old-images-pruning-117)).

`make test-server` checks both directions behind the real sshd, along with hostile requests, the promotion check, the re-tagging of a `:<sha>` that dev moved, the lock, the clean environment and the record.

### One-time setup (Yacine)

Dev must be deployed first ([Deploy to dev → One-time setup](#one-time-setup-yacine)), since prod takes its releases from dev.

**Done on 2026-10-25**, after #126 (the deny rules for starting and approving prod deploys) merged; the first deploy-prod run succeeded that day. #127 (the agent account that can't approve) followed a few hours later. The steps stay as the record, and for redoing the setup (e.g. a new Droplet). Without the secrets, the deploy job skips and nothing reaches prod.

1. **Install `infra/` at the merge commit of #29**, which updates `focus-ci`: `ssh -t yacine@159.223.188.176 'sudo /opt/focus/infra/server/install.sh <merge sha>'`. The diff shows `server/focus-ci.sh` and `server/install.sh`. Read it, then type `yes`.
2. **Create the key pair** on your machine, for CI only: `ssh-keygen -t ed25519 -N '' -C focus-ci-prod -f /tmp/focus-ci-prod`
3. **Authorize it**, pinned to the prod profile:
   `ssh -t yacine@159.223.188.176 "echo 'restrict,command=\"/opt/focus/bin/focus-ci prod\" $(cat /tmp/focus-ci-prod.pub)' | sudo tee -a /etc/ssh/authorized_keys/deploy > /dev/null"`
   Then `ssh yacine@159.223.188.176 "sudo stat -c '%a %U:%G' /etc/ssh/authorized_keys/deploy; sudo grep -c 'focus-ci prod' /etc/ssh/authorized_keys/deploy"` should print `640 root:deploy` and `1`.
4. **Get the host key line** as for dev: `ssh yacine@159.223.188.176 'printf "159.223.188.176 %s\n" "$(cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"'`
5. **Set up the `production` environment** before adding any secret: repo **Settings** → **Environments** → `production`, or **New environment** → `production` if it isn't listed.
   - **Required reviewers**: tick it, add `ybenzine`, and leave **Prevent self-review** unticked, since you start the runs yourself.
   - **Allow administrators to bypass configured protection rules**: untick it. Agents' account isn't an administrator (#127), but your own login is, and a session started without `claude-focus` would use it.
   - **Wait timer**: off.
   - **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → Ref type **Branch** (not Tag) → name pattern `main` → **Add rule**.
   - **Save protection rules**.
   - **Environment secrets** → **Add environment secret**, twice: `DEPLOY_SSH_KEY`, the whole of `/tmp/focus-ci-prod` (`-----BEGIN OPENSSH PRIVATE KEY-----` to `-----END …-----`), and `DEPLOY_KNOWN_HOSTS`, the line from step 4. Not as repository secrets.
6. **Delete the local key files**: `rm /tmp/focus-ci-prod /tmp/focus-ci-prod.pub`.
7. **Check**, read-only:
   `gh api repos/ybenzine/ineedtofocus/environments/production --jq '{reviewers: [.protection_rules[] | select(.type == "required_reviewers") | .reviewers[].reviewer.login], branches: .deployment_branch_policy, admins_bypass: .can_admins_bypass}'`
   should print `{"admins_bypass":false,"branches":{"custom_branch_policies":true,"protected_branches":false},"reviewers":["ybenzine"]}`.
   `gh api repos/ybenzine/ineedtofocus/environments/production/deployment-branch-policies --jq '.branch_policies[] | {name, type}'` should print only `{"name":"main","type":"branch"}`, and `gh secret list` (repository secrets) should list no `DEPLOY_*`.
8. **First deploy:** **Actions** → **deploy-prod** → **Run workflow** → branch `main`, `tag` empty → **Run workflow**. When `plan` is done, read its summary, then **Review deployments** → `production` → **Approve and deploy**. The job should go green with the release and passing smoke tests in its summary, and `https://ineedtofoc.us/healthz` should answer `{"status":"ok"}`.

### Upkeep

- **Rotate the key:** repeat steps 2–6, then remove the old `focus-ci-prod` line from `/etc/ssh/authorized_keys/deploy`.
- **Roll prod back:** `gh workflow run rollback.yml -f env=prod`, no approval needed ([Rollback](#rollback-rollbackyml)). A `deploy` of an older release isn't a rollback: it fails at `migrate` once prod's schema is newer.

## Build provenance (#128)

A deploy names a digest, and dev's `releases.log` maps a commit to whatever digest the dev key asked for. An image's `org.opencontainers.image.revision` label says whatever its builder wrote. Build provenance ties the bytes to the commit that gets approved.

**Attest.** After the push, `publish` runs `actions/attest-build-provenance` (pinned by commit sha) on the pushed digest. GitHub signs a SLSA v1 provenance statement with a short-lived Sigstore certificate, issued for the job's OIDC token (the public-good Sigstore instance, since the repository is public). What gets checked is in the certificate, which the workflow can't write: the signing workflow and its ref (`.github/workflows/ci.yml@refs/heads/main`), the repository, the commit, the trigger and the runner type. The attestation goes to the repository's attestation store (`https://github.com/ybenzine/ineedtofocus/attestations`) and, with `push-to-registry`, to GHCR next to the image, through `publish`'s `GITHUB_TOKEN` login, which ends in the job's last step. No storage record: GitHub keeps those for organization-owned repositories only. `publish` is the only job in any workflow with `id-token: write` and `attestations: write`; `scripts/tests/test_ci_workflow.py` fails if another one asks for either.

**Verify.** `deploy-dev` and `deploy-prod` run the same step before any `deploy` request (the test keeps the two scripts identical), with the runner's own `gh`. Both jobs get `attestations: read`.

```bash
gh attestation verify "oci://ghcr.io/ybenzine/ineedtofocus@$DIGEST" \
  --repo ybenzine/ineedtofocus \
  --signer-workflow ybenzine/ineedtofocus/.github/workflows/ci.yml \
  --signer-digest "$TAG" \
  --source-ref refs/heads/main \
  --source-digest "$TAG" \
  --predicate-type https://slsa.dev/provenance/v1 \
  --deny-self-hosted-runners
```

| Pin | Refuses |
|---|---|
| The subject `oci://…@<digest>` | An attestation of other bytes |
| `--repo` | Attestations of another repository. They're fetched from this repository's store through the API and checked against the certificate |
| `--signer-workflow` | Any workflow but `ci.yml`, such as a new workflow that asks for `id-token: write` |
| `--signer-digest`, `--source-digest` (the commit being deployed) | A `ci.yml` run on another commit: an image a later run built and labelled X doesn't pass as X |
| `--source-ref refs/heads/main` | Runs on pull requests (`refs/pull/<n>/merge`), other branches and tags |
| `--predicate-type`, `--deny-self-hosted-runners` | Other kinds of statements, and attestations made on self-hosted runners |

On a refusal, gh's reason is in the step's log (`HTTP 404: Not Found` when the digest has no attestation, `expected SourceRepositoryDigest to be …` on a mismatch). The step fails with `Build provenance not verified`, and the job stops there: every later step except cleanup and the summary runs only after the earlier ones succeeded. On success the summary links the CI run that built the image, taken from the certificate. To check an image by hand, run the same command with `gh` logged in, the digest and the commit filled in.

**Decisions:**

- **Dev verifies too.** `deploy-dev` checks before it even writes its key, so when `deploy-dev` deploys, dev's `releases.log` gains only digests `publish` attested. Dev's records then never offer prod a digest prod's check would refuse, and a broken attestation shows up on the dev deploy rather than after Yacine approved a prod deploy.
- **Rollback doesn't verify.** It must work at any hour, also while GitHub's API or Sigstore is unreachable, and it only restores digests the server recorded with an ok line in that environment's log. On prod, those passed this check when they were deployed, from the first deploy after #128 on.
- **The server doesn't verify yet: #177.** It's feasible. `focus-ci` could run a pinned verifier under the lock, before the pull: `cosign verify-attestation` with the GitHub OIDC identity, `sigstore-python`, or `gh` with `--bundle-from-oci`, which reads the copy `push-to-registry` keeps in GHCR. That check would hold whatever the workflows say, against an agent-merged edit that drops the step, a `dev`-environment job that deploys without it, or a leaked prod key. It needs a new tool on the host, installed by `bootstrap.sh`, with its trust root kept current, and changes to `focus-ci.sh` and `install.sh`. So it's its own issue.
- **Images published before #128 have no attestation**, so they can't be deployed to prod (or to dev) any more. Deploy one published after this change, that is, any merge to `main` since. Rolling back to an older release still works.

**If it fails:**

- **Transient** (a GitHub API, GHCR or Sigstore hiccup in `publish`'s attest step or in a verify step): click **Re-run failed jobs** on the CI run's page. If only `deploy-dev` failed, it alone runs again, on the digest `publish` already pushed. If `publish` failed, `publish` loads the tested image from the `app-image` artifact and pushes it again. Within the artifact's retention (one day, `retention-days: 1` in `ci.yml`), that normally gives the same digest, but it isn't guaranteed: it depends on the runner's Docker compressing the layers exactly as before. Either way, the digest `publish` pushes is the one it attests and the one `deploy-dev` verifies and deploys. For prod, start a new `deploy-prod` run once the attestation exists.
- **After that one day**, the artifact is gone: if `publish` is among the failed jobs, **Re-run failed jobs** fails at its artifact download. Click **Re-run all jobs** instead: CI runs every check again and rebuilds the image, and `publish` pushes and attests a new digest, which `deploy-dev` then verifies and deploys. `deploy-prod` takes its digest from dev's records, so it deploys the new one too.
- **Re-run only the latest CI run on `main`.** Nothing checks that a run's commit is still the newest, so an older run's `deploy-dev` puts that older commit back on dev. If a newer release has migrated the schema since, it stops at `migrate` with nothing changed; otherwise dev runs the older commit until the next merge deploys.
- **Persistent** (the attest action or `gh attestation verify` keeps refusing a release `publish` built): revert the squash commit of #128 through a PR. That PR goes through review like any other; nobody pushes to `main`. Its merge publishes and deploys without the check, and the cause gets fixed in a new PR.
- **Meanwhile**, `rollback.yml` works for both environments. It doesn't verify provenance and doesn't depend on GitHub's attestation API or Sigstore.

**After the merge of #128**, the merge commit's **Publish image to GHCR** (the first real attestation) and **Deploy to dev** (the first real verification) are the first live test of all this. Watch both. A failure there means the steps above, not a broken dev: until the check passes, nothing new reaches dev.

## Health checks and automatic revert (#30)

### What a deploy checks

`focus-ci`'s `deploy`, the same code for dev and prod, under the deploy lock:

1. **Note the current release** (the record's `tag` and `digest`): the one to go back to. Work out the next rollback target from the log ([Known-good releases](#known-good-releases)).
2. **Pull** each [dependency image](#dependency-images-170) the host lacks (Postgres, the collector) by its pinned digest, then the new app image by digest. Check its revision label and re-tag `:<sha>` from the digest. A failed pull stops here, before anything runs.
3. **Read the schema** (#165): `infra/app/migration_info.py`, from the installed copy, is fed to a one-shot app container of the release (`run --rm -T --no-deps app python -`: the app service's limits, no database). It reads the image's own migrations and prints the alembic head they lead to and their `# contract-migration:` revisions. Output it can't read with certainty (not exactly one `schema=` and one `contracts=` line of revision ids) stops the deploy here. A contract revision this environment hasn't recorded sets its [rollback floor](#rollback-floor-165) now, before the migration.
4. **Migrate** as a one-shot container (`run --rm … alembic upgrade head`).
5. **Start** with `up -d --wait`, which waits for the `/healthz` healthcheck (`--wait-timeout 180`). Then check that the app container runs exactly that digest, and that `GET /healthz` (the process) and `GET /readyz` (the database) answer inside it, three tries each, 2 s apart.
6. **Record** the release (`release`, plus an ok line in `releases.log`).
7. **Prune** old app images, still under the lock ([Old images](#old-images-pruning-117)). This never fails the deploy.

### Automatic revert

A failure before the start (`promote`, `pull`, `schema`, `migrate`) leaves the running app alone. The old container is never stopped, and a failed migration rolls back in its transaction, so there's nothing to revert. The deploy fails, the record is unchanged, and the attempt is logged with its step.

A failure at the start (not healthy within the timeout, the wrong image, `/healthz` or `/readyz` not answering) means the app may now run the new release unhealthy. So, still under the lock, `focus-ci` starts **the release that ran before** again:

- by its recorded digest, re-tagged `:<sha>` from it (dev or prod may have moved that tag), pulled if the host no longer has it, along with any dependency image it lost;
- without migrating: the older release runs on the newer schema ([Schema compatibility](#schema-compatibility));
- with the same checks (running image, `/healthz`, `/readyz`).

The deploy and the revert finish even if the SSH client goes away meanwhile (a cancelled job, a lost runner). `focus-ci` ignores HUP and PIPE, and its output reaches the client through forwarders that drop it once the client is gone, so no write can stop it between `up` and the revert. `make test-server` kills the client during a broken build's start and checks the revert still runs and is logged.

Then the deploy **fails anyway** (exit 1), so the `Deploy to dev` or `Deploy to prod` job goes red. Its summary says the server started the previous release again. The record is unchanged, since it still names the release that runs. The log has two lines: `action=deploy outcome=failed step=start` for the new release, then `action=revert outcome=ok` (or `failed`) for the one restored, with `failed_tag` and `failed_digest`. A failed release has no ok line, so it never becomes a rollback target and prod never takes it from dev.

If the revert fails too (for example the database is down, so no release passes `/readyz`), the deploy says `reverting to <tag> failed too`: the environment may be down ([runbook](runbooks/rollback.md)). The revert never starts a release below the [rollback floor](#rollback-floor-165): when the deploy that fails is the one whose contract migration just set the floor, the release before it may need what that migration removed, so the deploy fails with `<tag>, the release that ran before, is below <env>'s rollback floor (…), so it isn't started again` and the environment may run the new release unhealthy. Fix forward. The first deploy of an environment has nothing to revert to. A redeploy of the current digest that fails has nothing *else* to go back to: roll back instead.

The smoke tests that run afterwards from the runner (`scripts/smoke_deploy.py`, through Caddy) don't trigger a revert. When they fail after the server's own checks passed, the cause is usually the edge (Caddy, DNS, the certificate), and undoing the release wouldn't fix it. A release that failed its smoke tests on dev is never offered to prod (deploy-prod's plan requires a dev deployment that reached `success`). To undo it anyway, run the [rollback workflow](#rollback-rollbackyml).

`make test-server` runs this with deliberately broken images: one never turns healthy, one has no `/readyz`, and one is broken on prod only. Each deploy fails, the release before it runs again by its own digest without migrating, and a probe checks the lock is held through both starts. One more loses the collector's image as its start fails, and the revert pulls it again before starting the release before it (#170).

### Known-good releases

Every `outcome=ok` line in an environment's `releases.log` is a release that ran there and passed every check: a deploy, a rollback or an automatic revert. A rollback's ok line also names the release it **left** (`from_digest`). That release is then *rolled back from* until a later ok line for the same digest, for example when someone deploys it again on purpose.

A **known-good release** of an environment is a release (tag and digest) with an ok line there that isn't rolled back from. Concretely:

- `rollback` restores the newest known-good release other than the current one. A rollback revokes the release it left, so rolling back again goes one further back, never forward to it.
- `rollback <sha>` restores the newest known-good release of that commit, by the digest recorded for it. The server refuses a sha with no known-good release there: one that never passed the checks, failed and was reverted, only ran on the other environment, was rolled back from, or is the current release.
- After every deploy or rollback, the record's `previous_tag`/`previous_digest` is the next rollback target, worked out the same way. The workflow summaries show it.

All three count only known-good releases at or above the environment's [rollback floor](#rollback-floor-165), and so does pruning.

#### Rollback floor (#165)

A rollback starts a known-good release without migrating, which is safe only while every migration since it only added ([Schema compatibility](#schema-compatibility)). A **contract migration** removes something: a migration file with a `# contract-migration: <reason>` comment, the marker `backend/tests/unit/test_migration_safety.py` lets a destructive migration through with. After one, a release from before it may need what was removed. So once a contract migration has run on an environment, the releases from before it are no longer rollback targets there.

- **How focus-ci knows.** Each deploy reads its release's schema before migrating ([What a deploy checks](#what-a-deploy-checks), step 3): the alembic head and every contract revision on the way to it. When one of those revisions isn't on any floor line of this environment's `releases.log` yet, the deploy writes a floor line (`action=floor outcome=set … contracts=…`) and then migrates. The line comes first, so the floor holds even when the migration fails or is cut short: one that ran part-way can't be undone either. A failed contract migration therefore still sets the floor (fail closed), and the environment keeps running its release, with no rollback target and no automatic revert until a release at or above the floor deploys. That's deliberate even though a failed migration usually rolls back in its transaction and leaves the schema unchanged: focus-ci can't tell that case from one cut short part-way.
- **What it changes.** Known-good counts only the ok lines after the environment's newest floor line. `rollback` stops at it: `nothing to roll back to above <env>'s rollback floor: … (contract migration <revisions> ran with the deploy of <sha> at <time>)`. `rollback <sha>` of a release below it is refused: `<sha> is below <env>'s rollback floor: …`. Both change nothing. The record's `previous_tag` never points below it: the contract deploy itself has no rollback target. The automatic revert never starts a release below it ([Automatic revert](#automatic-revert)). Pruning keeps only known-good releases at or above it ([Old images](#old-images-pruning-117)).
- **Per environment.** Each environment's floor comes from its own log, set when its own deploy runs the migration. A contract deploy to dev leaves prod's rollback targets alone until prod deploys that release. Promotion isn't affected: prod may still take a release dev ran before dev's floor, because prod's schema hasn't been contracted. Once prod's schema has, `alembic upgrade head` of an older release fails at `migrate` with nothing changed, as any deploy of an older release does.
- **It stays.** Nothing lowers a floor: a later revert, rollback or deploy above it keeps it, and a release that brings only contract revisions already recorded writes no new floor line. A later contract migration moves it up.
- **Reaching the server.** Like every `focus-ci` change, it runs once Yacine installs the merge commit with `install.sh`, which now also requires `infra/app/migration_info.py`. Until then deploys run the old `focus-ci`: no `schema=`, no floor. So the first contract migration must not merge before that install. The helper reads any release's image, older ones included (it needs only alembic), and logs written before it have no floor line, so nothing changes for them. Reinstalling infra at a commit from before #165 once a floor line exists makes that older `focus-ci` ignore the floor without saying so: it skips the floor line as a line that isn't an ok one, so rollbacks, the automatic revert and pruning reach below the floor again.

`make test-server` covers it with the fake docker: a contract deploy writes the floor line first and leaves no rollback target, `rollback` and `rollback <sha>` stop at the floor on dev while prod (no contract migration yet) still rolls back and still takes releases from below dev's floor, then prod's own contract deploy sets prod's floor and the next pruning removes the releases below both floors. The floor survives a revert to the floor release and later rollbacks; a contract deploy that fails at start doesn't revert below its floor; a failed contract migration still sets it; output the schema step can't read stops a deploy before migrating. `scripts/tests/test_migration_info.py` checks the helper on real and made-up migration chains, and that its marker rule is the safety test's; `make test-prod-stack` runs it in the real image.

**Not promotable once dev rolled back from it** (#125 review). Prod takes only releases dev ran, and a release dev rolled back from is one we decided was bad. `focus-ci prod` refuses it in `candidate` (read-only) and in `promote` (under the lock, before any docker call) with `dev rolled back from <sha> <digest>, so it is not promotable`. It becomes promotable again only when dev runs that digest again with an ok line. deploy-prod's `plan` job can't see this: it reads GitHub deployments, which a rollback doesn't change. With `tag` empty it does stop when dev was rolled back after its last deployment (#275). Otherwise (an explicit `tag`, or a deploy since the rollback), a run that picked such a release stops at `Resolve` or `Deploy`, after the approval but before anything changes on prod.

### Old images: pruning (#117)

Every deploy pulls a new `ghcr.io/ybenzine/ineedtofocus` image. So after every successful deploy or rollback, still under `/opt/focus/deploy.lock`, `focus-ci` removes the app images neither environment may start again. The image store is one for the host, so this crosses environments on purpose: whichever profile runs (`dev`, `prod` or `rollback-prod`), it reads both environments' `release` and `releases.log`, and an image goes when neither keeps it, whichever environment ran it. A dev deploy can therefore remove an old prod release's image, but never one in prod's window. It keeps, for **both** environments:

- the current and previous release of `/opt/focus/<env>/release` (`digest`, `previous_digest`): what runs, and what `rollback` and an automatic revert would start;
- the newest 5 [known-good releases](#known-good-releases) at or above its [rollback floor](#rollback-floor-165) in `/opt/focus/<env>/releases.log` (`KEEP_KNOWN_GOOD` in `focus-ci.sh`): the rollbacks after that.

An image is kept when any of its digests is one of these. Everything else of that repository goes: failed deploys' images, releases rolled back from, and known-good releases older than the newest 5. Those older releases stay rollback targets: `rollback <sha>` pulls one again by its recorded digest from GHCR, which is where every deploy pulls from anyway. So the next rollbacks need no registry, and the [dependency images](#dependency-images-170) are never touched, so no rollback needs Docker Hub.

How it removes, and what it never does:

- It lists images (`docker image ls`), takes those of `ghcr.io/ybenzine/ineedtofocus`, reads each one's references (`docker image inspect`) and removes only that repository's (`docker image rm <repo>:<tag> <repo>@<digest>`). Never `docker image prune` or `docker system prune`, never `--force`. Another repository's image is never named, and neither is another repository's name on the same image.
- An image a container uses can't be removed without force, so it stays, with a warning.
- Anything it can't read with certainty keeps images: a malformed or unreadable `release` or `releases.log` of either environment skips pruning (`focus-ci: warning: not pruning old images: …`), and an image whose references it can't read is kept.
- It never fails the request: the release is already recorded and running. Problems are warnings (`focus-ci: warning: …`, also in `journalctl -t focus-ci`). The output lists what was pruned and how many images were kept.
- It follows the [rollback floor](#rollback-floor-165): a release below an environment's floor isn't kept for that environment (`make test-server` checks it).
- **What it prints about either environment** (#186), whichever profile runs. To the SSH client only:
  - `==> pruned <repo>:<sha> <repo>@<digest>`: the references of each image it removed, each once (the containerd image store lists a digest reference once per name; it's printed once);
  - the summary: how many images it removed and kept. The images kept on purpose, in some environment's window, are counted, never named.

  As warnings (`focus-ci: warning: …`), to the client and to syslog:
  - `kept <references>: docker couldn't remove it (<docker's error>)`: the references of an image it meant to remove but Docker refused, with Docker's own message, which can name the container using the image;
  - `kept image <image id>: can't read its references`;
  - when it doesn't prune: the path of a directory or file it can't read, the path and key (not the value) of a malformed `release`, or the path and line number of a malformed `releases.log`: `not pruning old images: /opt/focus/<env>/releases.log line <n> is malformed (see …)`. Never the line's content. A deploy, rollback or `candidate` that reads a malformed log shows up to 40 characters of the bad word ([The release record](#the-release-record)), but those read only logs their key may read anyway (the prod key reads dev's by design); pruning also reads the other environment's, and the key gains nothing from its content. Yacine reads the line on the server.

  Syslog also gets the counts (`pruned removed=<n> kept=<n>`). Not about either environment's records: `not pruning old images: docker image ls failed`, and Docker's own error output from `image ls` or `image inspect`, can also reach the client.

  That's shas, digests, image IDs, counts, paths, line numbers and Docker's messages, never a record's content. The references and IDs can belong to either environment's releases.

`make test-server` checks it with the fake docker: the window per environment, both environments' releases kept whichever profile runs, the pinned images and another repository's image left alone, only the app's references in each `image rm` and never forced, under the lock and with the clean environment, a pruned known-good release pulled again by `rollback <sha>`, and that a failed deploy prunes nothing. Docker refusing a removal (or an image a container runs), a malformed log of the other environment and unreadable references each keep the images, and the deploy still succeeds. It pins the warning a malformed log of the other environment prints (its path and line number, not the bad word), and that an image the containerd store lists with a repeated digest reference is removed and printed with each reference once.

**Reaching the server:** like every `focus-ci` change, this runs once Yacine installs the merge commit with `install.sh`. The first deploy or rollback after that prunes what accumulated since #28. #186's two changes to what pruning prints (a malformed log named by path and line number only, each reference printed once) also wait for an install.

### Schema compatibility

Neither a rollback nor a revert runs a migration, and nothing ever undoes one. That's safe because migrations are **expand-only** ([AGENTS.md](../AGENTS.md#conventions), `backend/tests/unit/test_migration_safety.py`). A known-good release migrated this database or ran on it. While every later migration only added to the schema (new tables, new nullable or defaulted columns), the older code runs on today's schema. AGENTS.md also allows contract migrations later ("expand first, contract later"; the safety test lets one through with a `# contract-migration:` comment). After one, a release that still needs the removed shape would fail. So a deploy that runs one sets that environment's [rollback floor](#rollback-floor-165): the releases from before it are no longer rollback targets there, and neither a rollback nor a revert starts one. Ship a contract step in a later release than the code that stopped using what it removes: the floor then retires only releases that may still use it. And ship it in its own small release, the contract migration with no other change, so a start that fails after it (and can't revert below the floor) is rare ([Decision log](product_decisions.md#8-decision-log), 2026-10-25, #165). The app container doesn't migrate on start (`MIGRATE_ON_START=0`), so an older image doesn't fail with `Can't locate revision …`. A migration that breaks this rule breaks rollback, which is why the migration safety test exists. A bad migration isn't something a rollback fixes: fix forward.

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
| Roll back | server: `rollback [<sha>] expect <digest just read>` | Under the deploy lock: if the current release isn't that digest (a deploy or rollback ran in between), it refuses and nothing changes. Then the [known-good](#known-good-releases) target, pulled by its recorded digest if the host lacks it (and any [dependency image](#dependency-images-170) the host lacks), label checked, re-tagged `:<sha>`, `up -d --wait`, running image, `/healthz`, `/readyz`. No migration. If the target fails its checks, the release it left starts again ([Automatic revert](#automatic-revert)) and the job fails |
| Record | runner: `status` | The server's `result` line gives what it left and what runs now. The record must show `action=rollback` with that digest, and `tag` when one was given. Then the key is deleted, before any repository code runs |
| Smoke | runner | `scripts/smoke_deploy.py` against https://ineedtofoc.us or https://dev.ineedtofoc.us |
| Summary | runner | From (the release left) and To (what runs now), both from the server's `result` line, written under the lock, plus the next rollback target, infra revision and smoke results. For dev: the release left is no longer promotable |

**Concurrency:** one rollback per environment at a time (`rollback-dev`, `rollback-prod`). A running one is never cancelled. GitHub keeps one *pending* run per group: a second dispatch while one waits replaces it, which drops a duplicate step back. The groups are separate from `deploy-dev` and `deploy-prod`, for the reason under [Serialization](#the-forced-command-focus-ci): the server lock orders them.

**After a prod rollback**, prod runs an older release and dev may still run the bad one. The fix goes through the usual path: a PR, a merge that deploys it to dev, then an approved prod deploy. Roll dev back too if the bad release blocks work there.

**After a dev rollback**, the next `Deploy to dev` of a commit newer than the release dev now runs deploys as usual: the [order check](#deploy-order-257) only stops commits older than what dev runs. That includes a deploy still waiting for its CI when you rolled back. A revert merged on `main` is a newer commit, so it deploys.

### Credentials

| Where | What | Who sets it |
|---|---|---|
| GitHub environment `rollback` (no required reviewer; deployment branches: `main` only) | `DEPLOY_SSH_KEY`: the private half of the `focus-ci-rollback` key. `DEPLOY_KNOWN_HOSTS`: the Droplet's host key line (the same line as dev's and prod's) | Yacine |
| `/etc/ssh/authorized_keys/deploy` | `restrict,command="/opt/focus/bin/focus-ci rollback-prod" ssh-ed25519 … focus-ci-rollback` | Yacine (sudo) |
| GitHub environment `dev` | Nothing new: the dev key's profile already has `rollback` ([Deploy to dev → Credentials](#credentials)) | |

Nothing is stored at repo level. The environment has no reviewer on purpose, so rolling prod back works at any hour without Yacine. The key is what limits it:

| Key (profile) | deploy | rollback | status | candidate | Environment it acts on | Pruning after a deploy or rollback (#117) |
|---|---|---|---|---|---|---|
| dev (`dev`) | yes | yes | yes | no | dev only | reads dev's and prod's records; removes app images outside both windows |
| prod (`prod`) | yes, a release dev ran and didn't roll back from | no | yes | yes (reads dev) | prod | the same |
| prod rollback (`rollback-prod`) | no | yes, prod's own known-good releases | yes | no | prod only | the same |

- **Prod rollback key** (`focus-ci rollback-prod`): `rollback`, `rollback <sha>` and `status` on prod, nothing else. The client never names a digest: the target comes from prod's own `releases.log`, so the key can only start bytes prod already ran and checked. It can't deploy, migrate, read or change dev, open a shell or change the compose files. (After a rollback, focus-ci also reads dev's records on the server, to keep dev's images when it [prunes](#old-images-pruning-117), and may remove dev's images outside dev's window. Of dev's records the client sees only image references and IDs, counts, Docker's messages about images it couldn't remove, and the path and line number of a malformed log, never a record's content: [what pruning prints](#old-images-pruning-117).) If it leaked, the worst it could do is roll prod back to an older known-good release, or step back through several. That's an outage-sized nuisance, fixed by an approved deploy, but never new code.
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

AC: "Rollback demonstrated once with a deliberately broken build". **Status: run on 2026-10-25.** Dev was rolled back from the demo build `e18aafb` (#167) to `4588fa7` with [run 40160362879](https://github.com/ybenzine/ineedtofocus/actions/runs/40160362879), and prod refused `e18aafb` as a candidate. The demo was then reverted (#168). The record, with links to the runs and the `releases.log` tail before and after, is on [#30](https://github.com/ybenzine/ineedtofocus/issues/30#issuecomment-6393315329). To run it again, dev's one-time setup ([Deploy to dev](#one-time-setup-yacine), #28) and step 1 above must be done.

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
