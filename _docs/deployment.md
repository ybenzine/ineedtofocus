# Deployment

> **Status: in progress.** Server setup is scripted (#25); the rest is filled in by the DevOps agent with #26–#30. The plan is in [tech_stack.md §2–3](tech_stack.md).

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

## Sections to write

- DNS (Route 53) — #26
- Images and production Compose — #27
- Deploy to dev — #28
- Deploy to prod — #29
- Health checks, auto-revert and rollback — #30
- Credential separation — prod key and secrets only in the `production` environment; dev and rollback keys restricted by SSH forced commands (see [process.md](process.md#human-gates)) — #28–#30
