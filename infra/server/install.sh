#!/usr/bin/env bash
# Install this repo's infra/ on the Droplet, root-owned, at a commit on main (#28).
#
#   sudo bash install.sh <commit sha>        # the full 40-character sha of a commit on main
#
# Run by Yacine, never by CI: no deploy key can run it. That way, what the deploy keys
# run (the compose files, the env settings, the forced command) changes only when he
# installs a reviewed commit. The first time, copy it over like bootstrap.sh:
#
#   scp infra/server/install.sh yacine@159.223.188.176:/tmp/focus-install.sh
#   ssh -t yacine@159.223.188.176 'sudo bash /tmp/focus-install.sh <sha>'
#
# After that, the installed copy can install the next commit:
#
#   ssh -t yacine@159.223.188.176 'sudo /opt/focus/infra/server/install.sh <sha>'
#
# What it does:
#   1. Clones main from GitHub over HTTPS (a fresh bare clone of that one branch, so
#      only commits on main are present) and checks that <sha> is on main. infra/ at
#      <sha> must hold regular files only: no symlinks or submodules.
#   2. Writes the full diff between what is installed now and infra/ at <sha> (every
#      file, as it is on disk) to /root/focus-install-<sha>.diff, prints the commits and
#      a summary, and asks for a typed "yes" on the terminal. Answering "diff" pages
#      through the whole diff first; anything else stops without changing anything.
#      Without a terminal (no ssh -t) it stops too. This is the one place where Yacine
#      sees exactly what will run as root, so read the diff.
#   3. Under the deploy lock (/opt/focus/deploy.lock, the one focus-ci takes), so it
#      never swaps files under a running deploy: replaces /opt/focus/infra with infra/
#      at <sha>, plus a REVISION file, all root:root and not writable by group or
#      others. The previous copy stays in /opt/focus/infra.previous. Then it installs
#      the forced command as /opt/focus/bin/focus-ci (root, 755).
#   4. Starts or updates the shared edge (Caddy, compose.edge.yml). It recreates Caddy
#      when the Caddyfile changed, because the old container still sees the old file.
#      That's a few seconds without HTTPS for both sites. When infra/otel-collector/
#      changed, it recreates each deployed environment's collector the same way (a few
#      seconds of telemetry buffered by the app's exporter).
#   5. Prints the installed revision and the forced command's sha256.
#
# It never touches the deploy keys (/etc/ssh/authorized_keys/deploy), the .env files,
# the databases or the apps.
#
# Test-harness options (never needed on the server):
#   --repo <url or path>   clone from somewhere else instead of GitHub
#   --yes                  don't ask for confirmation
set -euo pipefail
export LC_ALL=C

REPO_URL=https://github.com/ybenzine/ineedtofocus.git
FOCUS_ROOT=/opt/focus
INFRA_DIR=$FOCUS_ROOT/infra
PREVIOUS_DIR=$FOCUS_ROOT/infra.previous
LOCK_FILE=$FOCUS_ROOT/deploy.lock
LOCK_WAIT_SECONDS=900
CLEAN_PATH=/usr/sbin:/usr/bin:/sbin:/bin
# Every file the deploy keys depend on; a commit without them isn't installed.
REQUIRED_FILES=(compose.sh compose.prod.yml compose.edge.yml env/prod.env env/dev.env
  caddy/Caddyfile otel-collector/config.yaml server/focus-ci.sh server/install.sh)

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
usage() {
  echo "usage: sudo bash $0 <40-character commit sha on main>   (tests: --repo <url>, --yes)" >&2
  exit 2
}
clean() { env -i PATH="$CLEAN_PATH" HOME=/root "$@" 9<&-; }
edge() { clean docker compose -f "$INFRA_DIR/compose.edge.yml" "$@"; }

# write_diff <installed revision> <stage>: the full diff, installed files (a/) against
# the new ones (b/), to $diff_file, plus a summary on the terminal.
write_diff() {
  local rc=0
  diff_file=/root/focus-install-$sha.diff
  mkdir "$work/empty"
  ln -s "$( [[ -d $INFRA_DIR ]] && echo "$INFRA_DIR" || echo "$work/empty")" "$work/a"
  ln -s "$2" "$work/b"
  {
    echo "# install.sh: infra/ installed now (a/, revision ${1:-none}) -> infra/ at $sha (b/)"
    (cd "$work" && diff -ruN a/ b/) || rc=$?
  } >"$work/install.diff"
  ((rc <= 1)) || die "couldn't diff the installed files against $sha"
  install -m 0600 -o root -g root "$work/install.diff" "$diff_file"
  local changed
  changed=$(grep -c '^diff -ruN ' "$diff_file" || true)
  log "$changed file(s) differ from what is installed; full diff: $diff_file"
  grep '^diff -ruN ' "$diff_file" | sed 's|^diff -ruN a/\(.*\) b/.*|    \1|' || true
}

# confirm: a typed "yes" on the terminal, or --yes (tests).
confirm() {
  if ((assume_yes)); then
    log "--yes: installing without asking"
    return 0
  fi
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    die "nothing installed: confirming needs a terminal (ssh -t ...). The diff is in $diff_file"
  fi
  local answer
  while true; do
    printf 'Install infra/ at %s on this server? Type "yes" to install, "diff" to read the full diff, anything else to stop: ' "$sha" >&3
    IFS= read -r answer <&3 || answer=""
    case $answer in
      yes) break ;;
      diff)
        if command -v less >/dev/null; then
          less "$diff_file" <&3 >&3
        else
          cat "$diff_file" >&3
        fi
        ;;
      *) die "stopped: nothing installed" ;;
    esac
  done
  exec 3>&-
}

main() {
  exec </dev/null
  local repo=$REPO_URL sha="" assume_yes=0
  while (($#)); do
    case $1 in
      --yes)
        assume_yes=1
        shift
        ;;
      --repo)
        (($# >= 2)) || usage
        repo=$2
        shift 2
        ;;
      -*) usage ;;
      *)
        [[ -z $sha ]] || usage
        sha=$1
        shift
        ;;
    esac
  done
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || usage
  [[ $EUID -eq 0 ]] || die "run as root: ssh -t yacine@<droplet> 'sudo bash /tmp/focus-install.sh <sha>'"
  if [[ ! -d $FOCUS_ROOT/bin ]] || ! id -u deploy >/dev/null 2>&1; then
    die "run infra/server/bootstrap.sh first ($FOCUS_ROOT/bin or the deploy user is missing)"
  fi
  if ! command -v git >/dev/null; then
    log "installing git"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends git
  fi

  umask 022
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  local git=(clean git -C "$work/repo.git")

  # 1. Fetch main and check the commit.
  log "fetching main from $repo"
  clean git clone --quiet --bare --single-branch --branch main --no-tags "$repo" "$work/repo.git"
  "${git[@]}" cat-file -e "$sha^{commit}" 2>/dev/null || die "$sha isn't a commit on main of $repo"
  "${git[@]}" merge-base --is-ancestor "$sha" refs/heads/main || die "$sha isn't on main of $repo"
  local odd
  odd=$("${git[@]}" ls-tree -r "$sha" -- infra | awk '$1 != "100644" && $1 != "100755"')
  [[ -z $odd ]] || die "infra/ at $sha holds something other than regular files: $odd"
  mkdir "$work/stage"
  "${git[@]}" archive --format=tar "$sha" infra | tar -x -C "$work/stage" --no-same-owner
  local stage=$work/stage/infra file
  for file in "${REQUIRED_FILES[@]}"; do
    [[ -f $stage/$file ]] || die "infra/$file is missing at $sha"
  done
  printf '%s\n' "$sha" >"$stage/REVISION"
  chown -R root:root "$stage"
  chmod -R u+rwX,go+rX,go-w "$stage"

  # 2. What changes, and a decision.
  local old=""
  [[ -r $INFRA_DIR/REVISION ]] && old=$(<"$INFRA_DIR/REVISION")
  if [[ -z $old ]]; then
    log "first install: infra/ at $sha"
  elif [[ $old == "$sha" ]]; then
    log "reinstalling $sha (already installed)"
  elif "${git[@]}" cat-file -e "$old^{commit}" 2>/dev/null; then
    log "changes to infra/ from $old to $sha:"
    "${git[@]}" log --oneline "$old..$sha" -- infra | sed 's/^/    /'
  else
    log "the installed revision $old isn't on main any more; installing $sha"
  fi
  write_diff "$old" "$stage"
  confirm

  # 3. Swap under the deploy lock.
  [[ -f $LOCK_FILE ]] || install -m 0644 -o root -g root /dev/null "$LOCK_FILE"
  chown root:root "$LOCK_FILE"
  chmod 0644 "$LOCK_FILE"
  exec 9<"$LOCK_FILE"
  if ! flock -n 9; then
    log "waiting up to ${LOCK_WAIT_SECONDS}s for a running deploy or rollback to finish"
    flock -w "$LOCK_WAIT_SECONDS" 9 || die "timed out waiting for $LOCK_FILE"
  fi
  local caddy_changed=1 collector_changed=1
  if [[ -d $INFRA_DIR ]]; then
    cmp -s "$INFRA_DIR/caddy/Caddyfile" "$stage/caddy/Caddyfile" && caddy_changed=0
    diff -rq "$INFRA_DIR/otel-collector" "$stage/otel-collector" >/dev/null && collector_changed=0
    rm -rf "$PREVIOUS_DIR"
    mv "$INFRA_DIR" "$PREVIOUS_DIR"
  fi
  mv "$stage" "$INFRA_DIR"
  install -m 0755 -o root -g root "$INFRA_DIR/server/focus-ci.sh" "$FOCUS_ROOT/bin/.focus-ci.new"
  mv -f "$FOCUS_ROOT/bin/.focus-ci.new" "$FOCUS_ROOT/bin/focus-ci"
  log "installed $INFRA_DIR at $sha and $FOCUS_ROOT/bin/focus-ci"

  # 4. The shared edge.
  log "starting the edge (Caddy)"
  edge up -d --wait
  if [[ -n $old ]] && ((caddy_changed)); then
    log "the Caddyfile changed: recreating Caddy"
    edge up -d --wait --force-recreate caddy
  fi
  if [[ -n $old ]] && ((collector_changed)); then
    local env_name tag
    for env_name in prod dev; do
      tag=$(sed -n 's/^tag=//p' "$FOCUS_ROOT/$env_name/release" 2>/dev/null || true)
      [[ $tag =~ ^[0-9a-f]{40}$ ]] || continue
      log "the collector config changed: recreating focus-$env_name's collector"
      clean APP_TAG="$tag" "$INFRA_DIR/compose.sh" "$env_name" \
        up -d --wait --no-deps --force-recreate otel-collector
    done
  fi
  flock -u 9

  # 5. Summary.
  log "done:"
  printf '    %-16s %s\n' "infra revision:" "$sha"
  printf '    %-16s %s\n' "focus-ci sha256:" "$(sha256sum "$FOCUS_ROOT/bin/focus-ci" | cut -d' ' -f1)"
  echo "    CI keys go in /etc/ssh/authorized_keys/deploy, one per line, each pinned to its profile:"
  echo "    restrict,command=\"$FOCUS_ROOT/bin/focus-ci dev\" ssh-ed25519 AAAA... focus-ci-dev"
  echo "    restrict,command=\"$FOCUS_ROOT/bin/focus-ci prod\" ssh-ed25519 AAAA... focus-ci-prod"
}

main "$@"
