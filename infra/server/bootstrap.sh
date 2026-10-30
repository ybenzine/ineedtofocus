#!/usr/bin/env bash
# Set up the I Need To Focus Droplet (Ubuntu 24.04): Docker Engine + Compose plugin,
# unattended security upgrades, hardened SSH, the `deploy` user for CI, the /opt/focus
# layout and the build provenance verifier focus-ci runs (#177). Issue #25; documented
# in _docs/deployment.md → Server setup.
#
# Run it as root on the server. Root SSH login is disabled, so Yacine copies it over
# and runs it with sudo:
#
#   scp infra/server/bootstrap.sh yacine@159.223.188.176:/tmp/focus-bootstrap.sh
#   ssh -t yacine@159.223.188.176 'sudo bash /tmp/focus-bootstrap.sh'
#
# Idempotent: it only writes what differs and never touches the .env files' contents
# or the deploy user's keys, so re-running it is safe. It doesn't upgrade packages that
# are already installed (unattended-upgrades handles security updates).
#
# Everything is inside main() so that bash reads the whole file before running any of
# it: with `sudo bash -s < bootstrap.sh`, a command reading stdin would otherwise eat
# the rest of the script.
set -euo pipefail

DEPLOY_USER=deploy
FOCUS_ROOT=/opt/focus
FOCUS_ENVS=(prod dev)
# The deploy user's keys live outside its home, owned by root, so the account can't add
# keys of its own. Every key in it carries a forced command (#28–#30).
DEPLOY_KEYS_DIR=/etc/ssh/authorized_keys
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-focus-hardening.conf
# Docker's release signing key (https://docs.docker.com/engine/install/ubuntu/).
DOCKER_GPG_URL=https://download.docker.com/linux/ubuntu/gpg
DOCKER_GPG_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
DOCKER_KEYRING=/etc/apt/keyrings/docker.asc
BASE_PACKAGES=(ca-certificates curl gnupg openssh-server unattended-upgrades)
# Build provenance (#177): cosign, which focus-ci's deploy runs on every digest, and the
# Sigstore trusted root it checks attestations against (the public-good instance's
# Fulcio certificates and Rekor and CT log keys). Both pinned by sha256, root-owned in
# SIGSTORE_DIR. To bump either, change the pins here in a PR (_docs/deployment.md →
# Build provenance, Upkeep) and re-run this script.
SIGSTORE_DIR=$FOCUS_ROOT/sigstore
COSIGN_VERSION=v3.1.4
COSIGN_URL=https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux
# From cosign_checksums.txt of that release; the key is `dpkg --print-architecture`
# (the Droplet is amd64; arm64 is for `make test-server` on Apple silicon).
declare -A COSIGN_SHA256=(
  [amd64]=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
  [arm64]=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2
)
# trusted_root.json from Sigstore's TUF repository, by its sha256 in targets.json
# (version 14, read on 2026-10-30): the same file cosign's own TUF client fetches.
TRUSTED_ROOT_SHA256=6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66
TRUSTED_ROOT_URL=https://tuf-repo-cdn.sigstore.dev/targets/$TRUSTED_ROOT_SHA256.trusted_root.json
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
# Status 2, not 1: write_file's "unchanged" is 1, so a die that only ends a subshell
# (a future `$(write_file …)` or pipe) still can't be mistaken for it (#80).
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

have_systemd() { [[ -d /run/systemd/system ]]; }

# write_file <path> <mode> <owner:group>, content on stdin. Writes only if the content
# differs, and always enforces mode and owner. Returns 0 if it wrote, 1 if unchanged.
#
# Callers use it as a condition (`if write_file …`), which turns errexit off inside it,
# so every step is checked by hand: any failure stops the whole script with an ERROR:
# (die: exit 2, not return), so a caller never mistakes it for "unchanged". Run it in
# the main shell (not in `$(…)` or a pipe), where that exit ends the script; in a
# subshell it would only end the subshell, though its status 2 still isn't "unchanged".
# Callers that don't care whether the file changed use ensure_file.
write_file() {
  local path=$1 mode=$2 owner=$3 tmp cmp_rc=1
  tmp=$(mktemp) || die "writing $path: can't create a temporary file"
  if ! cat >"$tmp"; then
    rm -f "$tmp"
    die "writing $path: can't buffer the new content in $tmp"
  fi
  if [[ -e $path && ! -f $path ]]; then
    rm -f "$tmp"
    die "writing $path: it exists but isn't a regular file"
  fi
  if [[ -f $path ]]; then
    # cmp: 0 same, 1 different, 2 error (e.g. unreadable).
    cmp_rc=0
    cmp -s "$tmp" "$path" || cmp_rc=$?
    if ((cmp_rc > 1)); then
      rm -f "$tmp"
      die "writing $path: can't compare it with the new content"
    fi
  fi
  if ((cmp_rc == 0)); then
    rm -f "$tmp"
    chmod "$mode" "$path" || die "writing $path: chmod $mode failed"
    chown "$owner" "$path" || die "writing $path: chown $owner failed"
    return 1
  fi
  if ! install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"; then
    rm -f "$tmp"
    die "writing $path: install failed (mode $mode, owner $owner)"
  fi
  rm -f "$tmp"
  log "wrote $path"
  return 0
}

# ensure_file <path> <mode> <owner:group>, content on stdin: write_file when the caller
# doesn't need to know whether the file changed. Only "unchanged" (1) is accepted; any
# other non-zero status stops the script.
ensure_file() {
  local rc=0
  write_file "$@" || rc=$?
  ((rc <= 1)) || die "writing $1 failed (status $rc)"
}

in_group() {
  local group
  for group in $(id -nG "$1"); do
    [[ $group == "$2" ]] && return 0
  done
  return 1
}

is_installed() {
  [[ $(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true) == "install ok installed" ]]
}

APT_UPDATED=0
# apt_install <package>...: installs only the packages that are missing.
apt_install() {
  local pkg missing=()
  for pkg in "$@"; do
    is_installed "$pkg" || missing+=("$pkg")
  done
  ((${#missing[@]})) || return 0
  if ((!APT_UPDATED)); then
    apt-get update -q
    APT_UPDATED=1
  fi
  log "installing ${missing[*]}"
  apt-get install -y -q --no-install-recommends "${missing[@]}"
}

key_fingerprint() {
  local home fpr
  home=$(mktemp -d)
  fpr=$(GNUPGHOME=$home gpg --batch --show-keys --with-colons "$1" 2>/dev/null |
    awk -F: '$1 == "fpr" && !seen { print $10; seen = 1 }')
  rm -rf "$home"
  printf '%s' "$fpr"
}

check_system() {
  [[ $EUID -eq 0 ]] || die "run as root, e.g. ssh -t yacine@<droplet> 'sudo bash /tmp/focus-bootstrap.sh'"
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] ||
    die "expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
  if is_installed docker.io || is_installed podman-docker; then
    die "Ubuntu's docker.io or podman-docker is installed; remove it first (it conflicts with docker-ce)"
  fi
}

install_docker() {
  local tmp codename=${UBUNTU_CODENAME:-$VERSION_CODENAME}
  install -d -m 0755 /etc/apt/keyrings
  if [[ ! -f $DOCKER_KEYRING || $(key_fingerprint "$DOCKER_KEYRING") != "$DOCKER_GPG_FINGERPRINT" ]]; then
    tmp=$(mktemp)
    curl -fsSL --retry 3 "$DOCKER_GPG_URL" -o "$tmp"
    if [[ $(key_fingerprint "$tmp") != "$DOCKER_GPG_FINGERPRINT" ]]; then
      rm -f "$tmp"
      die "Docker's signing key at $DOCKER_GPG_URL doesn't have the expected fingerprint $DOCKER_GPG_FINGERPRINT"
    fi
    install -m 0644 -o root -g root "$tmp" "$DOCKER_KEYRING"
    rm -f "$tmp"
    log "installed Docker's signing key ($DOCKER_GPG_FINGERPRINT)"
  fi
  if write_file /etc/apt/sources.list.d/docker.sources 0644 root:root <<EOF; then
# Managed by infra/server/bootstrap.sh (#25).
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Signed-By: $DOCKER_KEYRING
EOF
    APT_UPDATED=0
  fi
  apt_install "${DOCKER_PACKAGES[@]}"
  getent group docker >/dev/null || die "the docker group is missing after installing docker-ce"

  # Rotate container logs so they can't fill the disk; live-restore keeps containers
  # running while dockerd restarts (e.g. when docker-ce is upgraded).
  local daemon_changed=0
  install -d -m 0755 /etc/docker
  if write_file /etc/docker/daemon.json 0644 root:root <<'EOF'; then
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "live-restore": true
}
EOF
    daemon_changed=1
  fi

  if have_systemd; then
    systemctl enable --now containerd.service docker.service
    if ((daemon_changed)); then
      log "restarting dockerd to apply /etc/docker/daemon.json"
      systemctl restart docker.service
    fi
  else
    log "no systemd (container test run): not managing the docker service"
  fi
}

configure_unattended_upgrades() {
  # Ubuntu's 50unattended-upgrades already limits automatic upgrades to the -security
  # pocket (plus ESM); Docker's repo isn't in it, so docker-ce is upgraded by hand.
  ensure_file /etc/apt/apt.conf.d/20auto-upgrades 0644 root:root <<'EOF'
// Managed by infra/server/bootstrap.sh (#25).
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
  ensure_file /etc/apt/apt.conf.d/52focus-unattended-upgrades 0644 root:root <<'EOF'
// Managed by infra/server/bootstrap.sh (#25).
// No automatic reboot: prod and dev share this server, so a reboot is a planned step
// (see _docs/deployment.md → Server setup). /var/run/reboot-required says when one is due.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
  if have_systemd; then
    systemctl enable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
  else
    log "no systemd (container test run): not managing the unattended-upgrades service"
  fi
}

create_deploy_user() {
  if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --create-home --user-group --shell /bin/bash \
      --comment "CI deploys (forced-command keys only)" "$DEPLOY_USER"
    log "created user $DEPLOY_USER"
  fi
  # '*' is no valid password, so no password login or su, but key login still works.
  if [[ $(getent shadow "$DEPLOY_USER" | cut -d: -f2) != "*" ]]; then
    usermod -p '*' "$DEPLOY_USER"
  fi
  # Docker access is what deploys need. It's root-equivalent, which is why every key
  # for this account is restricted to a forced command and the keys are root-owned.
  if ! in_group "$DEPLOY_USER" docker; then
    usermod -aG docker "$DEPLOY_USER"
    log "added $DEPLOY_USER to the docker group"
  fi
  # No sudo, ever.
  local group
  for group in sudo admin; do
    if in_group "$DEPLOY_USER" "$group"; then
      gpasswd -d "$DEPLOY_USER" "$group" >/dev/null
      log "removed $DEPLOY_USER from the $group group"
    fi
  done
  if grep -rqsw -- "$DEPLOY_USER" /etc/sudoers /etc/sudoers.d; then
    die "a sudoers rule mentions $DEPLOY_USER; remove it (the deploy user must not have sudo)"
  fi

  install -d -m 0755 -o root -g root "$DEPLOY_KEYS_DIR"
  local keys=$DEPLOY_KEYS_DIR/$DEPLOY_USER
  if [[ ! -f $keys ]]; then
    install -m 0640 -o root -g "$DEPLOY_USER" /dev/null "$keys"
    cat >"$keys" <<'EOF'
# Keys for the deploy user (sshd reads this file instead of ~deploy/.ssh, see
# /etc/ssh/sshd_config.d/00-focus-hardening.conf). Created empty by
# infra/server/bootstrap.sh (#25), which never changes it afterwards.
#
# One line per CI key, each one per GitHub environment and each restricted to a forced
# command (added with #28–#30, see _docs/deployment.md → Server setup):
#
#   restrict,command="/opt/focus/bin/<command>" ssh-ed25519 AAAA... focus-ci-<environment>
#
# Never add a key without restrict,command=..., and never add a personal key here.
EOF
    log "created $keys (no keys yet: #28–#30 add the CI keys)"
  fi
  chown root:"$DEPLOY_USER" "$keys"
  chmod 0640 "$keys"
  local line n=0 missing
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line=${line#"${line%%[![:space:]]*}"}
    [[ -z $line || $line == \#* ]] && continue
    missing=$(key_missing_restrictions "$line")
    if [[ -n $missing ]]; then
      warn "$keys line $n: deploy key without $missing; every deploy key needs both restrict and command=\"…\" (a forced command): ${line:0:60}..."
    fi
  done <"$keys"
}

# key_options <authorized_keys line>: prints the line's options, one per line, as sshd
# reads them: a comma-separated field before the key type, where a double-quoted value
# (command="…") may contain commas, spaces and \". Prints nothing if the line starts with
# the key type (no options).
key_options() {
  local line=$1 opt="" c i quoted=0
  case ${line%%[[:space:]]*} in
    ssh-* | ecdsa-sha2-* | sk-*) return 0 ;;
  esac
  for ((i = 0; i < ${#line}; i++)); do
    c=${line:i:1}
    if ((quoted)); then
      if [[ $c == "\\" && ${line:i+1:1} == '"' ]]; then
        opt+='\"'
        i=$((i + 1))
        continue
      fi
      [[ $c == '"' ]] && quoted=0
      opt+=$c
    else
      case $c in
        '"')
          quoted=1
          opt+=$c
          ;;
        ,)
          printf '%s\n' "$opt"
          opt=""
          ;;
        [[:space:]]) break ;;
        *) opt+=$c ;;
      esac
    fi
  done
  printf '%s\n' "$opt"
}

# key_missing_restrictions <authorized_keys line>: prints what the line lacks of
# `restrict` and `command="…"` (in any order, option names case-insensitive as in sshd),
# or nothing when it has both.
key_missing_restrictions() {
  local opt has_restrict=0 has_command=0
  local -a opts
  mapfile -t opts < <(key_options "$1")
  for opt in "${opts[@]}"; do
    case ${opt,,} in
      restrict) has_restrict=1 ;;
      command=\"?*\") has_command=1 ;;
    esac
  done
  if ((!has_restrict && !has_command)); then
    printf 'restrict and without command="…"'
  elif ((!has_restrict)); then
    printf 'restrict'
  elif ((!has_command)); then
    printf 'command="…"'
  fi
}

harden_ssh() {
  # Ubuntu's sshd_config includes sshd_config.d/*.conf first and the first value wins,
  # so 00- takes precedence over e.g. cloud-init's 50-cloud-init.conf.
  local backup=""
  # sshd -t and sshd -T need the privilege separation directory.
  install -d -m 0755 /run/sshd
  if [[ -f $SSHD_DROPIN ]]; then
    backup=$(mktemp)
    cp -p "$SSHD_DROPIN" "$backup"
  fi
  if write_file "$SSHD_DROPIN" 0644 root:root <<EOF; then
# Managed by infra/server/bootstrap.sh (#25).
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes

# CI only: root-owned keys, each with a forced command; no shell, PTY or forwarding.
Match User $DEPLOY_USER
    AuthorizedKeysFile $DEPLOY_KEYS_DIR/%u
    DisableForwarding yes
    PermitTTY no
    PermitTunnel no
    PermitUserRC no
EOF
    if ! sshd -t; then
      if [[ -n $backup ]]; then
        cp -p "$backup" "$SSHD_DROPIN"
        rm -f "$backup"
      else
        rm -f "$SSHD_DROPIN"
      fi
      die "sshd rejected the new configuration; restored the previous $SSHD_DROPIN"
    fi
    if have_systemd; then
      # Open sessions are unaffected; new logins use the new configuration.
      systemctl try-reload-or-restart ssh.service
      log "reloaded sshd"
    fi
  fi
  if [[ -n $backup ]]; then
    rm -f "$backup"
  fi
}

create_layout() {
  install -d -m 0755 -o root -g root "$FOCUS_ROOT"
  # Forced-command scripts for the CI keys (#28–#30). Root-owned so the deploy user
  # can't change what its own keys are allowed to run.
  install -d -m 0755 -o root -g root "$FOCUS_ROOT/bin"
  local env dir
  for env in "${FOCUS_ENVS[@]}"; do
    dir=$FOCUS_ROOT/$env
    install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$dir"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$dir"
    chmod 0750 "$dir"
    if [[ -f $dir/.env ]]; then
      chown "$DEPLOY_USER:$DEPLOY_USER" "$dir/.env"
      chmod 0600 "$dir/.env"
    else
      warn "$dir/.env is missing; create it (values in .env.example, secrets never in git)"
    fi
  done
}

# install_pinned <url> <sha256> <path> <mode> <what>: <path>, root-owned with <mode>, holds
# exactly the file with that sha256. Downloads it only when it doesn't, and installs
# nothing unless the download has that sha256. Returns 0 if it installed, 1 if unchanged;
# any failure stops the script (die).
install_pinned() {
  local url=$1 want=$2 path=$3 mode=$4 what=$5 tmp have=""
  if [[ -e $path && ! -f $path ]]; then
    die "installing $path: it exists but isn't a regular file"
  fi
  if [[ -f $path ]]; then
    have=$(sha256sum "$path") || die "installing $path: can't read its sha256"
    have=${have%% *}
  fi
  if [[ $have == "$want" ]]; then
    chmod "$mode" "$path" || die "installing $path: chmod $mode failed"
    chown root:root "$path" || die "installing $path: chown root:root failed"
    return 1
  fi
  tmp=$(mktemp) || die "installing $path: can't create a temporary file"
  if ! curl -fsSL --retry 3 -o "$tmp" "$url"; then
    rm -f "$tmp"
    die "installing $path: downloading $what from $url failed"
  fi
  have=$(sha256sum "$tmp") || die "installing $path: can't read the download's sha256"
  have=${have%% *}
  if [[ $have != "$want" ]]; then
    rm -f "$tmp"
    die "installing $path: $what from $url has sha256 $have, not the pinned $want. Nothing installed"
  fi
  # Next to the target, then renamed over it: a deploy never runs a half-written file.
  if ! install -m "$mode" -o root -g root "$tmp" "$path.new"; then
    rm -f "$tmp" "$path.new"
    die "installing $path: install failed (mode $mode, owner root:root)"
  fi
  rm -f "$tmp"
  mv -f "$path.new" "$path" || die "installing $path: can't move $path.new into place"
  log "installed $what as $path (sha256 $want)"
  return 0
}

# install_verifier (#177): cosign and the trusted root, pinned, in SIGSTORE_DIR (root, 755).
install_verifier() {
  local arch rc
  arch=$(dpkg --print-architecture) || die "can't read the architecture (dpkg --print-architecture)"
  [[ -n ${COSIGN_SHA256[$arch]-} ]] || die "no cosign is pinned for $arch (COSIGN_SHA256 in this script)"
  install -d -m 0755 -o root -g root "$SIGSTORE_DIR" || die "creating $SIGSTORE_DIR failed"
  chown root:root "$SIGSTORE_DIR" || die "chown root:root $SIGSTORE_DIR failed"
  chmod 0755 "$SIGSTORE_DIR" || die "chmod 0755 $SIGSTORE_DIR failed"
  rc=0
  install_pinned "$COSIGN_URL-$arch" "${COSIGN_SHA256[$arch]}" "$SIGSTORE_DIR/cosign" 0755 \
    "cosign $COSIGN_VERSION ($arch)" || rc=$?
  ((rc <= 1)) || die "installing cosign failed (status $rc)"
  rc=0
  install_pinned "$TRUSTED_ROOT_URL" "$TRUSTED_ROOT_SHA256" "$SIGSTORE_DIR/trusted_root.json" 0644 \
    "Sigstore's trusted root" || rc=$?
  ((rc <= 1)) || die "installing the trusted root failed (status $rc)"
}

summary() {
  log "done. State:"
  printf '  %-22s %s\n' "deploy user:" "$(id "$DEPLOY_USER")"
  printf '  %-22s %s\n' "docker:" "$(docker --version)"
  printf '  %-22s %s\n' "compose:" "$(docker compose version)"
  printf '  %-22s %s\n' "cosign (#177):" "$("$SIGSTORE_DIR/cosign" version 2>/dev/null | sed -n 's/^GitVersion: *//p')"
  printf '  %-22s %s\n' "sshd:" "$(sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication) ' | tr '\n' ' ')"
  if have_systemd; then
    printf '  %-22s %s\n' "unattended-upgrades:" "$(systemctl is-active unattended-upgrades.service || true)"
    printf '  %-22s %s\n' "docker service:" "$(systemctl is-active docker.service || true)"
  fi
  if [[ -f /var/run/reboot-required ]]; then
    warn "a reboot is pending (/var/run/reboot-required); plan one, see _docs/deployment.md"
  fi
}

main() {
  exec </dev/null
  export DEBIAN_FRONTEND=noninteractive
  check_system
  apt_install "${BASE_PACKAGES[@]}"
  install_docker
  configure_unattended_upgrades
  create_deploy_user
  harden_ssh
  create_layout
  install_verifier
  summary
}

main "$@"
