#!/usr/bin/env bash
# Runs in the `make test-server` container right after in_container.sh, on the server
# bootstrap.sh has just set up. Tests infra/server/install.sh and the forced command
# focus-ci (#28, #29, #30) behind the real, hardened sshd. A fake docker CLI (fake_docker.sh)
# stands in for Docker: it records every call and the environment variables it got.
#
#   installer   refuses non-root, malformed shas, commits not on main and trees with
#               symlinks; writes the full diff and installs nothing without a typed
#               "yes" on a terminal; installs root-owned files the deploy user can't
#               change; pulls the pinned images it starts first, and installs nothing
#               when a pull fails (#170); starts the edge; on a change, recreates Caddy
#               and the collectors
#   refusals    anything but `deploy <sha> sha256:<digest>`, `rollback [<sha>]` or
#               `status` is refused with exit status 2 before any docker call (shells,
#               scp, sftp, injection, case, spacing, length, an unknown profile)
#   deploy      pull the missing dependency images (Postgres, the collector) by their
#               pinned digests, as on dev's first deploy (#28, #170), and the app by
#               digest; revision label check, migrate, then up, then the running-image,
#               /healthz and /readyz checks; clean environment; the record
#   rollback    no migration; walks back through previous releases
#   failures    each failing step stops the deploy, keeps the record and logs it (a
#               dependency image that can't be pulled or isn't pinned stops it at pull,
#               before anything runs); a failure at start reverts, and says so when the
#               revert fails too
#   lock        a deploy waits for /opt/focus/deploy.lock
#   prod        (#29) the prod key: hostile inputs; it can't roll back or touch dev, and
#               the dev key can't touch prod; `candidate` reads dev's records only; a
#               deploy needs dev to have run that exact sha and digest; it re-points the
#               host-wide :<sha> at prod's digest under the lock; record, log, lock;
#               a failing check or migration leaves the record and the running app alone
#   revert      (#30) a deliberately broken build (never healthy, or no /readyz) on dev,
#               and one broken on prod only: the deploy fails, and the release that ran
#               before starts again by its digest, without migrating, under the same lock,
#               pulling a dependency image the host lost meanwhile
#   known-good  (#30) rollback picks the newest release that passed the checks there and
#               wasn't rolled back from, re-tags it from its own digest (pulling it and
#               any pruned dependency image if needed, under the lock), never migrates; `rollback <sha>` takes only a known-good release;
#               a release dev rolled back from isn't promotable until dev runs it again; a
#               rollback whose target fails starts the release it left again
#   rollback-prod (#30) the prod rollback key: hostile inputs; only rollback and status;
#               only prod's own known-good releases; never touches dev; the lock and the
#               clean environment
#   pruning     (#117) after a successful deploy or rollback, under the lock, with any
#               profile: old app images leave the host, but never the current, previous
#               or newest known-good releases of either environment, the pinned images
#               (Postgres, the collector, Caddy) or another repository's; a pruned
#               known-good release is pulled again by a rollback; a failed deploy prunes
#               nothing; a failed removal, a malformed log or unreadable references keep
#               images and never fail the deploy; a malformed log of the other
#               environment is named by path and line number only (#186); a digest
#               reference the containerd store repeats is removed and printed once
#   floor       (#165) each deploy reads its release's schema (the installed
#               migration_info.py, fed to a one-shot container) before migrating, and
#               logs schema=<head>; output it can't read stops it there. A contract
#               migration writes a floor line first: rollback, rollback <sha>, the
#               record's previous release, the automatic revert and pruning stop at it;
#               dev's floor doesn't move prod's, or stop promotion; it survives a revert
#               and later rollbacks; a failed contract deploy still sets it
set -euo pipefail

SRC=/src
FAKE=/tmp/fake-docker
SSH_PORT=2223
REPO=ghcr.io/ybenzine/ineedtofocus
RECORD=/opt/focus/dev/release
HISTORY=/opt/focus/dev/releases.log
# shellcheck source=/dev/null # lib.sh: check, eq, contains, not_contains, mode_owner, first_line, finish
. "$SRC/server/tests/lib.sh"

value() { sed -n "s/^$1=//p" "$RECORD"; }
mark() { mark=$(wc -l <"$FAKE/calls.log"); }
new_calls() { tail -n "+$((mark + 1))" "$FAKE/calls.log"; }
no_new_calls() { eq "$(new_calls)" ""; }
# line_of <text> <pattern>: number of the first line containing pattern (0 if none).
line_of() { grep -nF -- "$2" <<<"$1" | first_line | cut -d: -f1 || echo 0; }
before() { # <text> <first> <second>: first appears, and before second
  local a b
  a=$(line_of "$1" "$2")
  b=$(line_of "$1" "$3")
  [[ -n $a && -n $b && $a -gt 0 && $b -gt 0 && $a -lt $b ]] && return 0
  printf '     %q (line %s) not before %q (line %s)\n' "$2" "${a:-0}" "$3" "${b:-0}"
  return 1
}
# Only PATH, HOME and (for compose) APP_TAG reach docker.
clean_env_only() {
  local bad
  bad=$(grep -vE ' env=(APP_TAG,)?HOME,PATH ' <<<"$1" || true)
  [[ -z $bad ]] && return 0
  printf '     calls with other environment variables:\n%s\n' "$bad"
  return 1
}
last_history() { tail -n1 "$HISTORY"; }
# put <file> <line>: (re)write a fake-docker state file the deploy user also writes. Root
# can't open a file the deploy user owns in the sticky $FAKE dirs (fs.protected_regular),
# so it replaces it with a world-writable one of its own.
put() {
  local tmp
  tmp=$(mktemp "$FAKE/.put.XXXXXX")
  printf '%s\n' "$2" >"$tmp"
  chmod 0666 "$tmp"
  mv -f "$tmp" "$1"
}
# History lines written since hmark: new_history [<file>].
hmark() { hmark=$(wc -l <"${1:-$HISTORY}"); }
new_history() { tail -n "+$((hmark + 1))" "${1:-$HISTORY}"; }
# after <text> <pattern>: the lines from the first one containing pattern onwards.
after() { tail -n "+$(line_of "$1" "$2")" <<<"$1"; }

echo "--- Setup: git, a fake docker, an upstream repo"
apt-get update -q >/dev/null
apt-get install -y -q --no-install-recommends git >/dev/null
mv /usr/bin/docker /usr/bin/docker.real
install -m 0755 "$SRC/server/tests/fake_docker.sh" /usr/bin/docker
install -d -m 1777 "$FAKE" "$FAKE/labels" "$FAKE/fail" "$FAKE/broken"
# Not sticky: root (install.sh) and the deploy user (focus-ci) both pull and tag, the
# tests remove images from the host whoever pulled them, and focus-ci's pruning (#117)
# removes images and tags whoever made them.
install -d -m 0777 "$FAKE/local" "$FAKE/tags"
install -m 0666 /dev/null "$FAKE/calls.log"

# The images the real compose files pin besides the app's (#170): in the fake registry
# but not on the host, like on a fresh Droplet.
pinned() { sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]#]*@sha256:[0-9a-f]\{64\}\).*/\1/p' "$1"; }
PG=$(pinned "$SRC/compose.prod.yml" | grep '^postgres:' || true)
OTEL=$(pinned "$SRC/compose.prod.yml" | grep '^otel/opentelemetry-collector-contrib:' || true)
CADDY=$(pinned "$SRC/compose.edge.yml" | grep '^caddy:' || true)
check "sanity: compose.prod.yml pins Postgres by tag and digest" [ -n "$PG" ]
check "sanity: compose.prod.yml pins the collector by tag and digest" [ -n "$OTEL" ]
check "sanity: compose.edge.yml pins Caddy by tag and digest" [ -n "$CADDY" ]
for ref in "$PG" "$OTEL" "$CADDY"; do
  install -m 0644 /dev/null "$FAKE/labels/${ref#*@}"
done
on_host() { [[ -f $FAKE/local/${1#*@} ]]; }
prune() { rm -f "$FAKE/local/${1#*@}"; } # <image>: it leaves the host

# Upstream "GitHub": main has the working tree's infra/ (A), then a commit with a
# symlink (B), then a change to the Caddyfile and the collector config (D). Branch
# topic has a commit that isn't on main (C).
up=/tmp/upstream
g() { git -C "$up" -c user.name=test -c user.email=test@example.invalid "$@"; }
git init -q -b main "$up"
cp -a "$SRC" "$up/infra"
g add -A && g commit -qm A
A=$(g rev-parse HEAD)
g checkout -q -b topic
echo topic >"$up/infra/topic.txt"
g add -A && g commit -qm C
C=$(g rev-parse HEAD)
g checkout -q main
ln -s /etc/shadow "$up/infra/link"
g add -A && g commit -qm B
B=$(g rev-parse HEAD)
g rm -q "$up/infra/link"
echo "# changed" >>"$up/infra/caddy/Caddyfile"
echo "# changed" >>"$up/infra/otel-collector/config.yaml"
g add -A && g commit -qm D
D=$(g rev-parse HEAD)

install_at() { # <sha>: run the installer as root, confirmed with --yes; sets out and rc
  rc=0
  # file:// goes through git's transport like the clone from GitHub: only commits
  # reachable from main arrive.
  out=$(bash "$SRC/server/install.sh" --repo "file://$up" --yes "$@" 2>&1) || rc=$?
}
install_typing() { # <answer> <sha>: run it on a pseudo-terminal, typing <answer>
  rc=0
  out=$(printf '%s\n' "$1" | script -qec "bash $SRC/server/install.sh --repo file://$up $2" /dev/null 2>&1) || rc=$?
}

echo "--- Installer refuses what it mustn't install"
rc=0
out=$(su -s /bin/bash nobody -c "bash $SRC/server/install.sh --repo file://$up $A" 2>&1) || rc=$?
check "non-root: refused" [ "$rc" -ne 0 ]
check "non-root: says to run as root" contains "$out" "run as root"
install_at "${A:0:12}"
check "short sha: usage error" eq "$rc" 2
install_at "${A^^}"
check "uppercase sha: usage error" eq "$rc" 2
install_at "$C"
check "commit not on main: refused" [ "$rc" -ne 0 ]
check "commit not on main: says so" contains "$out" "isn't a commit on main"
# A plain-path clone copies every object, the topic branch's too: then the ancestry
# check is what refuses it.
rc=0
out=$(bash "$SRC/server/install.sh" --repo "$up" "$C" 2>&1) || rc=$?
check "commit present but not on main: refused" [ "$rc" -ne 0 ]
check "commit present but not on main: says so" contains "$out" "$C isn't on main"
install_at "$B"
check "tree with a symlink: refused" [ "$rc" -ne 0 ]
check "tree with a symlink: says so" contains "$out" "other than regular files"
rc=0
out=$(bash "$SRC/server/install.sh" --repo "file://$up" "$A" 2>&1) || rc=$?
check "no terminal and no --yes: stops" eq "$rc" 1
check "no terminal: says it needs one" contains "$out" "confirming needs a terminal"
check "the full diff is saved for review, root only" eq "$(mode_owner "/root/focus-install-$A.diff")" "600 root:root"
check "first-install diff shows every file" contains "$(cat "/root/focus-install-$A.diff")" "+++ b/compose.prod.yml"
check "it lists the files that differ" contains "$out" "    compose.sh"
install_typing no "$A"
check "typing anything but yes: stops" [ "$rc" -ne 0 ]
check "typing no: says nothing was installed" contains "$out" "stopped: nothing installed"
check "nothing installed so far" [ ! -e /opt/focus/infra ]
check "no forced command so far" [ ! -e /opt/focus/bin/focus-ci ]
touch "$FAKE/fail/pull" # Docker Hub unreachable
mark
install_at "$A"
rm "$FAKE/fail/pull"
check "Caddy's image can't be pulled: install fails" eq "$rc" 1
check "it names the image and says nothing was installed" contains "$out" "couldn't pull $CADDY (the edge): nothing installed"
check "a failed pull installs nothing" [ ! -e /opt/focus/infra ]
check "a failed pull installs no forced command" [ ! -e /opt/focus/bin/focus-ci ]
check "a failed pull starts nothing" not_contains "$(new_calls)" " up "

echo "--- Installer installs a commit on main, root-owned"
mark
install_at "$A"
printf '%s\n' "$out" | sed 's/^/     | /'
check "install succeeds" eq "$rc" 0
check "/opt/focus/infra is root 755" eq "$(mode_owner /opt/focus/infra)" "755 root:root"
check "every installed file is root's" eq "$(find /opt/focus/infra ! -user root -o ! -group root)" ""
check "nothing installed is group- or world-writable" eq "$(find /opt/focus/infra -perm /022)" ""
check "REVISION is the commit" eq "$(cat /opt/focus/infra/REVISION)" "$A"
check "compose.sh installed, executable" [ -x /opt/focus/infra/compose.sh ]
check "forced command is root 755" eq "$(mode_owner /opt/focus/bin/focus-ci)" "755 root:root"
check "forced command is the repo's focus-ci.sh" cmp -s /opt/focus/bin/focus-ci "$SRC/server/focus-ci.sh"
check "deploy lock is root 644" eq "$(mode_owner /opt/focus/deploy.lock)" "644 root:root"
calls=$(new_calls)
check "edge started" contains "$calls" ":: compose -f /opt/focus/infra/compose.edge.yml up -d --wait"
check "installer pulls Caddy's image by its pinned digest (#170)" contains "$calls" ":: pull --quiet $CADDY"
check "before starting the edge" before "$calls" ":: pull --quiet $CADDY" "compose.edge.yml up -d --wait"
check "the edge starts with --pull never (only what was pulled)" contains "$calls" "compose.edge.yml up -d --wait --pull never"
check "Caddy's image is on the host" on_host "$CADDY"
check "nothing deployed yet: the environments' images aren't pulled by the installer" not_contains "$calls" ":: pull --quiet $PG"
check "first install doesn't recreate Caddy" not_contains "$calls" "--force-recreate"
check "installer calls docker with a clean environment" clean_env_only "$calls"
for path in /opt/focus/infra/compose.sh /opt/focus/infra/env/dev.env /opt/focus/bin/focus-ci /opt/focus/deploy.lock; do
  check "deploy user can't modify $path" su -s /bin/bash deploy -c "! (echo x >> $path) 2>/dev/null"
done
for dir in /opt/focus/infra /opt/focus/bin /opt/focus; do
  check "deploy user can't create files in $dir" su -s /bin/bash deploy -c "! touch $dir/new 2>/dev/null"
done

echo "--- CI keys behind the real sshd"
keys=/tmp/ci-keys
mkdir -p "$keys"
for who in dev prod rollback unknown env; do
  ssh-keygen -q -t ed25519 -N '' -C "focus-ci-$who" -f "$keys/$who"
done
{
  echo "# test keys (focus_ci.sh)"
  printf 'restrict,command="/opt/focus/bin/focus-ci dev" %s\n' "$(cat "$keys/dev.pub")"
  printf 'restrict,command="/opt/focus/bin/focus-ci prod" %s\n' "$(cat "$keys/prod.pub")"
  printf 'restrict,command="/opt/focus/bin/focus-ci rollback-prod" %s\n' "$(cat "$keys/rollback.pub")"
  printf 'restrict,command="/opt/focus/bin/focus-ci staging" %s\n' "$(cat "$keys/unknown.pub")"
  printf 'restrict,command="env" %s\n' "$(cat "$keys/env.pub")"
} >/etc/ssh/authorized_keys/deploy
/usr/sbin/sshd -p "$SSH_PORT" -o ListenAddress=127.0.0.1
sleep 1
ssh_opts=(-T -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=5)
ci_as() { # <key> [ssh options...] -- <remote command...>; sets out and rc
  local key=$1 opts=()
  shift
  while (($#)) && [[ $1 != -- ]]; do
    opts+=("$1")
    shift
  done
  shift
  rc=0
  out=$(ssh "${ssh_opts[@]}" "${opts[@]}" -i "$keys/$key" deploy@127.0.0.1 "$@" 2>&1) || rc=$?
}
ci() { ci_as dev -- "$@"; }

ci_as env -o 'SetEnv=LC_FOCUS=leak LANG=C.UTF-8' --
check "sanity: sshd passes LC_* from the client (so the clean-env checks mean something)" contains "$out" "LC_FOCUS=leak"

sha() { printf '%040x' "$1"; }
digest() { printf 'sha256:%064x' "$1"; }
S1=$(sha 0xa1) S2=$(sha 0xa2)
D1=$(digest 0xd1) D2=$(digest 0xd2) D3=$(digest 0xd3) D4=$(digest 0xd4)
echo "$S1" >"$FAKE/labels/$D1"
echo "$S2" >"$FAKE/labels/$D2"
echo "$S1" >"$FAKE/labels/$D3" # D3 claims S2 below but was built from S1

echo "--- Refused before anything runs (exit status 2, no docker call)"
refused=(
  ""
  "bash"
  "sh -c id"
  "id"
  "deploy"
  "deploy $S1"
  "deploy $S1 $D1 extra"
  "deploy ${S1^^} $D1"
  "deploy $S1 ${D1^^}"
  "deploy $S1 ${D1#sha256:}"
  "deploy ${S1:1} $D1"
  "deploy ${S1}0 $D1"
  "deploy $S1 ${D1:0:70}"
  "deploy $S1 sha512:${D1#sha256:}"
  "deploy  $S1 $D1"
  " deploy $S1 $D1"
  "deploy $S1 $D1 "
  "deploy $S1 $D1;id"
  "deploy $S1 $D1 && id"
  "deploy \$(id) $D1"
  "deploy $S1 $D1"$'\n'"id"
  "status"$'\n'"id"
  "status extra"
  "STATUS"
  "ROLLBACK"
  "rollback $S1 $D1"
  "rollback $D1"
  "rollback ${S1^^}"
  "rollback ${S1:1}"
  "rollback ${S1}0"
  "rollback  $S1"
  " rollback"
  "rollback "
  "rollback $S1 "
  "rollback;id"
  "rollback $S1;id"
  "rollback \$(id)"
  "rollback ../prod"
  "rollback prod"
  "rollback"$'\n'"id"
  "rollback $S1"$'\n'"id"
  "rollback expect"
  "rollback expect ${D1#sha256:}"
  "rollback expect ${D1^^}"
  "rollback expect $S1"
  "rollback $S1 expect"
  "rollback expect $D1 extra"
  "rollback expect $D1 $S1"
  "rollback  expect $D1"
  "rollback expect  $D1"
  "rollback EXPECT $D1"
  "rollback expect $D1;id"
  "scp -t /tmp"
  "/usr/lib/openssh/sftp-server"
  "deploy $S1 $D1 $(printf 'x%.0s' {1..200})"
)
for request in "${refused[@]}"; do
  mark
  ci "$request"
  shown=$(printf '%q' "${request:0:60}")
  check "refused: $shown" eq "$rc" 2
  check "refused with a message: $shown" contains "$out" "focus-ci: refused"
  check "no docker call for: $shown" no_new_calls
done
mark
ci_as dev -o 'SetEnv=LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8' -- "deploy ${S1^^} $D1"
check "uppercase hex refused whatever locale the client sends" eq "$rc" 2
check "no docker call for it" no_new_calls
ci_as unknown -- status
check "a key with an unknown profile is refused, even for status" eq "$rc" 2
check "it says which" contains "$out" "unknown profile"
rc=0
out=$(su -s /bin/bash deploy -c 'SSH_ORIGINAL_COMMAND=status /opt/focus/bin/focus-ci' 2>&1) || rc=$?
check "no profile argument: refused" eq "$rc" 2
rc=0
out=$(su -s /bin/bash deploy -c 'SSH_ORIGINAL_COMMAND=status /opt/focus/bin/focus-ci dev prod' 2>&1) || rc=$?
check "two profile arguments: refused" eq "$rc" 2
rc=0
scp -q -P "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -i "$keys/dev" /etc/hostname deploy@127.0.0.1:/tmp/scp-test >/dev/null 2>&1 || rc=$?
check "scp with the CI key fails" [ "$rc" -ne 0 ]
check "scp wrote nothing" [ ! -e /tmp/scp-test ]
rc=0
sftp -q -b - -P "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -i "$keys/dev" deploy@127.0.0.1 <<<"ls" >/dev/null 2>&1 || rc=$?
check "sftp with the CI key fails" [ "$rc" -ne 0 ]

echo "--- Before the first deploy"
ci status
check "status with no release: succeeds" eq "$rc" 0
check "status with no release: says so" contains "$out" "no release recorded for dev yet"
ci rollback
check "rollback with no release: fails (status 1)" eq "$rc" 1
check "rollback with no release: says so" contains "$out" "nothing to roll back to"

echo "--- Dependency images missing, as on dev's first deploy (#28, #170)"
check "sanity: Postgres' image isn't on the host" bash -c "! [ -e '$FAKE/local/${PG#*@}' ]"
check "sanity: the collector's image isn't on the host" bash -c "! [ -e '$FAKE/local/${OTEL#*@}' ]"
rc=0
out=$(env -i PATH=/usr/bin:/bin APP_TAG="$S1" docker compose -f /opt/focus/infra/compose.prod.yml \
  --env-file /opt/focus/dev/.env --env-file /opt/focus/infra/env/dev.env \
  run --rm --pull never app alembic upgrade head 2>&1) || rc=$?
check "sanity: without them, the fake fails migrate as dev did on #28" eq "$rc" 1
check "sanity: with Docker's message" contains "$out" "No such image: $PG"

echo "--- Deploy"
mark
ci_as dev -o 'SetEnv=LC_FOCUS=leak LANG=C.UTF-8' -- "deploy $S1 $D1"
printf '%s\n' "$out" | sed 's/^/     | /'
check "deploy succeeds" eq "$rc" 0
calls=$(new_calls)
compose_args="compose -f /opt/focus/infra/compose.prod.yml --env-file /opt/focus/dev/.env --env-file /opt/focus/infra/env/dev.env"
migrate=":: $compose_args run --rm --pull never app alembic upgrade head"
start=":: $compose_args up -d --wait --wait-timeout 180 --pull never"
check "pulls by digest" contains "$calls" ":: pull --quiet $REPO@$D1"
check "lists the project's images (#170)" contains "$calls" "app_tag=$S1 :: $compose_args config --images"
check "pulls Postgres' missing image by its pinned digest" contains "$calls" ":: pull --quiet $PG"
check "pulls the collector's missing image by its pinned digest" contains "$calls" ":: pull --quiet $OTEL"
check "pulls them before migrate" before "$calls" ":: pull --quiet $OTEL" "$migrate"
check "never touches Caddy's image (the edge is install.sh's)" not_contains "$calls" "$CADDY"
check "Postgres' and the collector's images are on the host now" bash -c "[ -e '$FAKE/local/${PG#*@}' ] && [ -e '$FAKE/local/${OTEL#*@}' ]"
check "checks the revision label" contains "$calls" "org.opencontainers.image.revision\" }} $REPO@$D1"
check "tags the digest :<sha> locally" contains "$calls" ":: tag $REPO@$D1 $REPO:$S1"
check "pull before migrate" before "$calls" ":: pull --quiet" "$migrate"
check "migrates with a one-shot container" contains "$calls" "$migrate"
check "migrate before up" before "$calls" "$migrate" "$start"
read_schema=":: $compose_args run --rm -T --pull never --no-deps app python -"
check "reads the release's schema in a one-shot container, no database (#165)" contains "$calls" "app_tag=$S1 $read_schema"
check "after the pull and the re-tag" before "$calls" ":: tag $REPO@$D1 $REPO:$S1" "$read_schema"
check "before migrate" before "$calls" "$read_schema" "$migrate"
check "it feeds the container the installed migration_info.py" cmp -s "$FAKE/run-stdin" /opt/focus/infra/app/migration_info.py
check "no contract migration: no floor line" not_contains "$(cat "$HISTORY")" "action=floor"
check "checks the running image after up" before "$calls" "$start" ":: inspect --format {{.Image}} container-dev-app"
check "checks /healthz in the app" contains "$calls" "exec -T app python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz'"
check "checks /readyz in the app" contains "$calls" "exec -T app python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz'"
check "the endpoint checks come after the running-image check" before "$calls" ":: inspect --format {{.Image}}" "/healthz"
check "every compose call gets APP_TAG=<sha>" eq "$(grep ':: compose' <<<"$calls" | grep -vc "app_tag=$S1 ")" 0
check "docker gets PATH, HOME and APP_TAG only (no LC_*, LANG or SSH_*)" clean_env_only "$calls"
check "runs as the deploy user" eq "$(grep -vc "uid=$(id -u deploy) " <<<"$calls")" 0
check "record: tag" eq "$(value tag)" "$S1"
check "record: digest" eq "$(value digest)" "$D1"
check "record: image by digest" eq "$(value image)" "$REPO@$D1"
check "record: action" eq "$(value action)" deploy
check "record: time (UTC)" grep -qxE 'deployed_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' "$RECORD"
check "record: no previous release" eq "$(value previous_tag)$(value previous_digest)" ""
check "record: infra revision" eq "$(value infra_revision)" "$A"
check "record is deploy's, 640" eq "$(mode_owner "$RECORD")" "640 deploy:deploy"
check "history: one ok line" eq "$(grep -c ' outcome=ok ' "$HISTORY")" 1
check "history line names the release" contains "$(last_history)" "action=deploy outcome=ok tag=$S1 digest=$D1"
check "history line records the alembic head it migrated to (#165)" contains "$(last_history)" " schema=0002"
check "deploy output shows the record" contains "$out" "deployed_at="
ci status
check "status prints the record" eq "$out" "$(cat "$RECORD")"

mark
ci "deploy $S2 $D2"
check "second deploy succeeds" eq "$rc" 0
check "second deploy: checks the dependency images are on the host" contains "$(new_calls)" ":: image inspect $PG"
check "second deploy: pulls only the app, the rest is on the host" eq "$(new_calls | grep -c ':: pull ')" 1
check "record: tag after the second deploy" eq "$(value tag)" "$S2"
check "record: previous release is the first" eq "$(value previous_tag) $(value previous_digest)" "$S1 $D1"
ci "deploy $S2 $D2"
check "redeploying the current release succeeds" eq "$rc" 0
check "redeploy keeps the rollback target" eq "$(value previous_tag)" "$S1"

echo "--- Rollback"
mark
ci rollback
printf '%s\n' "$out" | sed 's/^/     | /'
check "rollback succeeds" eq "$rc" 0
calls=$(new_calls)
check "rollback doesn't migrate" not_contains "$calls" "alembic"
check "rollback doesn't pull an image the host has" not_contains "$calls" ":: pull"
check "rollback starts the previous release" contains "$calls" "app_tag=$S1 :: $compose_args up -d --wait"
check "rollback checks /readyz" contains "$calls" "readyz"
check "rollback: clean environment" clean_env_only "$calls"
check "record: rolled back to the first release" eq "$(value tag) $(value digest)" "$S1 $D1"
check "record: action rollback" eq "$(value action)" rollback
check "record: the first release's own previous (none)" eq "$(value previous_tag)" ""
check "history: the rollback names the release it left" \
  contains "$(last_history)" "action=rollback outcome=ok tag=$S1 digest=$D1 previous_tag=- previous_digest=- infra=$A from_tag=$S2 from_digest=$D2"
check "rollback said dev's left release isn't promotable" contains "$out" "prod won't take it from dev"
ci rollback
check "a second rollback has nowhere further back to go (status 1)" eq "$rc" 1
check "it says so" contains "$out" "nothing to roll back to"
check "record unchanged by it" eq "$(value tag) $(value action)" "$S1 rollback"

echo "--- Failing steps stop the deploy and keep the record"
deploy_fails() { # <description> <step> <sha> <digest> <must not appear>
  local desc=$1 step=$2 tag=$3 dig=$4 absent=$5 before_record
  before_record=$(cat "$RECORD")
  mark
  hmark
  ci "deploy $tag $dig"
  check "$desc: fails (status 1)" eq "$rc" 1
  check "$desc: says at which step" contains "$out" "failed at '$step'"
  check "$desc: stops before $absent" not_contains "$(new_calls)" "$absent"
  check "$desc: record unchanged" eq "$(cat "$RECORD")" "$before_record"
  check "$desc: logged as failed" contains "$(new_history | first_line)" "action=deploy outcome=failed tag=$tag digest=$dig"
  check "$desc: logged step" contains "$(new_history | first_line)" "step=$step"
  check "$desc: prunes nothing (#117)" not_contains "$(new_calls)" ":: image ls"
}
# Before `up`, the running app is untouched: nothing to revert.
no_revert() { # <description>
  check "$1: no revert (the app was never touched)" not_contains "$(new_history)" "action=revert"
  check "$1: no up at all" not_contains "$(new_calls)" " up -d"
}
deploy_fails "image built from another commit" pull "$S2" "$D3" "alembic"
check "image built from another commit: says so" contains "$out" "was built from"
no_revert "image built from another commit"
deploy_fails "digest not in the registry" pull "$S2" "$D4" "alembic"
no_revert "digest not in the registry"
running_before=$(cat "$FAKE/running-dev")
prune "$PG"                   # Postgres' image left the host (#117's pruning, a bump)
touch "$FAKE/fail/pull"       # and Docker Hub is unreachable
deploy_fails "a dependency image that can't be pulled" pull "$S2" "$D2" "alembic"
rm "$FAKE/fail/pull"
check "a dependency image that can't be pulled: names it (#170)" contains "$out" "could not pull $PG, which focus-dev needs"
no_revert "a dependency image that can't be pulled"
check "a dependency image that can't be pulled: the app isn't re-tagged" not_contains "$(new_calls)" ":: tag "
check "a dependency image that can't be pulled: dev runs the same image" eq "$(cat "$FAKE/running-dev")" "$running_before"
cp -p /opt/focus/infra/compose.prod.yml /tmp/compose.prod.yml.installed
sed -i "s|$PG|postgres:17-alpine|" /opt/focus/infra/compose.prod.yml
deploy_fails "a dependency image pinned by tag only" pull "$S2" "$D2" "alembic"
cp -p /tmp/compose.prod.yml.installed /opt/focus/infra/compose.prod.yml
check "a dependency image pinned by tag only: says so" contains "$out" "postgres:17-alpine in /opt/focus/infra/compose.prod.yml is not pinned by tag and digest"
check "a dependency image pinned by tag only: never pulled by tag" not_contains "$(new_calls)" ":: pull --quiet postgres:17-alpine"
no_revert "a dependency image pinned by tag only"
touch "$FAKE/fail/migrate"
deploy_fails "failed migration" migrate "$S2" "$D2" " up -d"
rm "$FAKE/fail/migrate"
no_revert "failed migration"
check "the next deploy pulled Postgres' image again" contains "$(new_calls)" ":: pull --quiet $PG"
# These fail every start, the revert's too (a broken host rather than a broken build;
# the broken builds come with #30's tests below): the revert is tried and fails.
revert_fails_too() { # <description>
  check "$1: tries to start the release that ran before" contains "$(new_calls)" "app_tag=$S1 :: $compose_args up -d --wait"
  check "$1: the revert doesn't migrate" not_contains "$(after "$(new_calls)" "app_tag=$S2 :: $compose_args up")" "alembic"
  check "$1: logs the failed revert" contains "$(new_history | sed -n 2p)" "action=revert outcome=failed tag=$S1 digest=$D1"
  check "$1: says the revert failed too" contains "$out" "reverting to $S1 failed too"
}
touch "$FAKE/fail/up"
deploy_fails "app doesn't turn healthy" start "$S2" "$D2" "readyz"
rm "$FAKE/fail/up"
revert_fails_too "app doesn't turn healthy"
touch "$FAKE/fail/verify"
deploy_fails "app runs another image" start "$S2" "$D2" "readyz"
check "app runs another image: says so" contains "$out" "the app runs image"
rm "$FAKE/fail/verify"
revert_fails_too "app runs another image"
touch "$FAKE/fail/exec"
deploy_fails "/healthz doesn't answer" start "$S2" "$D2" "no such call"
check "/healthz doesn't answer: says so" contains "$out" "/healthz doesn't answer inside the app container"
check "/healthz doesn't answer: retried $((3)) times, for the new release and the revert" \
  eq "$(new_calls | grep -c "/healthz")" 6
rm "$FAKE/fail/exec"
revert_fails_too "/healthz doesn't answer"

echo "--- One deploy at a time: the lock"
rm -f /tmp/released
flock /opt/focus/deploy.lock bash -c 'sleep 3; date +%s.%N > /tmp/released' &
holder=$!
sleep 0.5
mark
ci "deploy $S2 $D2"
wait "$holder"
check "deploy succeeds once the lock is free" eq "$rc" 0
check "deploy said it was waiting" contains "$out" "waiting up to 900s"
first=$(new_calls | first_line | cut -d' ' -f1)
check "no docker call while another holder had the lock" \
  awk -v a="$first" -v b="$(cat /tmp/released)" 'BEGIN { exit !(a >= b) }'

echo "--- Installing a change"
install_typing no "$D"
check "a change: stops unless confirmed" [ "$rc" -ne 0 ]
check "a change: still the old revision" eq "$(cat /opt/focus/infra/REVISION)" "$A"
diff_text=$(cat "/root/focus-install-$D.diff")
check "the diff shows the Caddyfile change" contains "$diff_text" "+# changed"
check "the diff is against the installed files" contains "$diff_text" "--- a/caddy/Caddyfile"
check "the diff has no symlink in it" not_contains "$diff_text" "b/link"
prune "$OTEL" # the collector's image left the host
touch "$FAKE/fail/pull"
mark
install_at "$D"
rm "$FAKE/fail/pull"
check "a pull fails for dev's images: install fails (#170)" eq "$rc" 1
check "a pull fails for dev's images: names the image" contains "$out" "couldn't pull $OTEL (focus-dev): nothing installed"
check "a pull fails for dev's images: still the old revision" eq "$(cat /opt/focus/infra/REVISION)" "$A"
check "a pull fails for dev's images: nothing started or recreated" not_contains "$(new_calls)" " up "
mark
install_typing yes "$D"
printf '%s\n' "$out" | sed 's/^/     | /'
check "second install succeeds once yes is typed" eq "$rc" 0
calls=$(new_calls)
check "install pulls the collector image dev needs and the host lacks" contains "$calls" ":: pull --quiet $OTEL"
check "it lists dev's images from the new files, before they're installed" \
  contains "$calls" "/stage/infra/compose.prod.yml --env-file /opt/focus/dev/.env"
check "it pulls before recreating dev's collector" before "$calls" ":: pull --quiet $OTEL" "--force-recreate otel-collector"
check "REVISION updated" eq "$(cat /opt/focus/infra/REVISION)" "$D"
check "previous copy kept" eq "$(cat /opt/focus/infra.previous/REVISION)" "$A"
check "shows the commits since the installed revision" contains "$out" "changes to infra/ from $A to $D"
check "Caddyfile changed: Caddy recreated" contains "$calls" "compose.edge.yml up -d --wait --pull never --force-recreate caddy"
check "collector config changed: dev's collector recreated at dev's tag" \
  contains "$calls" "app_tag=$S2 :: $compose_args up -d --wait --pull never --no-deps --force-recreate otel-collector"
check "prod (nothing deployed) left alone" not_contains "$calls" "/opt/focus/prod/.env"
check "installer: clean environment" clean_env_only "$calls"
ci status
check "forced command still works after the reinstall" eq "$rc" 0
check "the record survives the reinstall" contains "$out" "tag=$S2"
install_at "$D"
check "reinstalling the same commit succeeds" eq "$rc" 0
check "reinstalling the same commit says so" contains "$out" "already installed"

echo "--- Prod key (#29)"
PROD_RECORD=/opt/focus/prod/release
PROD_HISTORY=/opt/focus/prod/releases.log
prod() { ci_as prod -- "$@"; }
pvalue() { sed -n "s/^$1=//p" "$PROD_RECORD"; }
prod_compose="compose -f /opt/focus/infra/compose.prod.yml --env-file /opt/focus/prod/.env --env-file /opt/focus/infra/env/prod.env"
prod_migrate=":: $prod_compose run --rm --pull never app alembic upgrade head"
prod_start=":: $prod_compose up -d --wait --wait-timeout 180 --pull never"
S3=$(sha 0xa3) D5=$(digest 0xd5) D6=$(digest 0xd6)
echo "$S1" >"$FAKE/labels/$D5" # a re-push of :S1 (a full CI re-run): other bytes, same label
echo "$S3" >"$FAKE/labels/$D6" # a real image of S3 that dev never ran

prod_refused=(
  "${refused[@]}"
  "rollback"
  "candidate "
  " candidate"
  "candidate  $S1"
  "candidate ${S1^^}"
  "candidate ${S1:1}"
  "candidate ${S1}0"
  "candidate $S1 extra"
  "candidate $S1 $D1"
  "candidate;id"
  "candidate \$(id)"
  "candidate $S1"$'\n'"id"
  "CANDIDATE"
  "status dev"
  "status prod"
)
for request in "${prod_refused[@]}"; do
  mark
  prod "$request"
  shown=$(printf '%q' "${request:0:60}")
  check "prod key refused: $shown" eq "$rc" 2
  check "prod key refused with a message: $shown" contains "$out" "focus-ci: refused"
  check "prod key: no docker call for: $shown" no_new_calls
done
prod rollback
check "prod key can't roll back (that's #30's own key)" contains "$out" "rollback isn't allowed for profile prod"
mark
ci candidate
check "dev key can't use candidate (status 2)" eq "$rc" 2
check "dev key: says candidate isn't its verb" contains "$out" "candidate isn't allowed for profile dev"
check "dev key: no docker call for candidate" no_new_calls
prod status
check "prod status with no release: succeeds" eq "$rc" 0
check "prod status with no release: says so" contains "$out" "no release recorded for prod yet"

echo "--- The dev key acts on dev only"
mark
ci "deploy $S1 $D5"
check "dev deploys a re-push of S1 (other bytes)" eq "$rc" 0
calls=$(new_calls)
check "dev deploy: no prod file in any call" not_contains "$calls" "/opt/focus/prod/"
check "dev deploy: no prod record" [ ! -e "$PROD_RECORD" ]
check "dev deploy moved the host-wide :S1 to its digest" eq "$(cat "$FAKE/tags/$S1")" "$D5"
dev_state=$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")

echo "--- candidate: read-only, from dev's records"
mark
prod candidate
check "candidate succeeds" eq "$rc" 0
check "candidate: dev's current tag" contains "$out" "tag=$S1"
check "candidate: dev's current digest" contains "$out" "digest=$D5"
check "candidate: says where from" contains "$out" "source=dev"
check "candidate: no docker call" no_new_calls
prod "candidate $S2"
check "candidate <sha>: succeeds" eq "$rc" 0
check "candidate <sha>: the digest dev ran ok, not a failed attempt's" contains "$out" "digest=$D2"
check "sanity: dev's log has a failed attempt of S2 with another digest" \
  contains "$(cat "$HISTORY")" "outcome=failed tag=$S2 digest=$D3"
prod "candidate $S1"
check "candidate <sha>: the last ok release of that sha" contains "$out" "digest=$D5"
prod "candidate $S3"
check "candidate of a sha dev never ran: fails (status 1)" eq "$rc" 1
check "candidate of a sha dev never ran: says so" contains "$out" "dev ran no release of $S3 successfully"
check "candidate changes nothing on dev" eq "$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")" "$dev_state"

echo "--- A prod deploy needs dev to have run that exact release"
prod_promote_refused() { # <description> <sha> <digest>
  mark
  prod "deploy $2 $3"
  check "$1: fails (status 1)" eq "$rc" 1
  check "$1: at the promote step" contains "$out" "failed at 'promote'"
  check "$1: says dev must run it first" contains "$out" "deploy it to dev first"
  check "$1: no docker call" no_new_calls
  check "$1: no prod record" [ ! -e "$PROD_RECORD" ]
  check "$1: logged as failed" contains "$(tail -n1 "$PROD_HISTORY")" "env=prod action=deploy outcome=failed tag=$2 digest=$3"
}
prod_promote_refused "a sha dev never ran" "$S3" "$D6"
prod_promote_refused "a digest dev only failed with" "$S2" "$D3"
prod_promote_refused "a digest dev ran for another sha" "$S2" "$D1"

echo "--- Prod deploy"
mark
ci_as prod -o 'SetEnv=LC_FOCUS=leak LANG=C.UTF-8' -- "deploy $S1 $D1"
printf '%s\n' "$out" | sed 's/^/     | /'
check "prod deploy of an earlier dev release succeeds" eq "$rc" 0
calls=$(new_calls)
check "prod: no pull, the digest is on the host" not_contains "$calls" ":: pull"
check "prod: checks the revision label" contains "$calls" "org.opencontainers.image.revision\" }} $REPO@$D1"
check "prod: re-points :S1 at prod's digest" contains "$calls" ":: tag $REPO@$D1 $REPO:$S1"
check "prod: re-tag before migrate" before "$calls" ":: tag $REPO@$D1" "$prod_migrate"
check "prod: migrates prod" contains "$calls" "$prod_migrate"
check "prod: migrate before up" before "$calls" "$prod_migrate" "$prod_start"
check "prod: checks prod's running image after up" before "$calls" "$prod_start" ":: inspect --format {{.Image}} container-prod-app"
check "prod: checks /readyz" contains "$calls" "readyz"
check "prod: every compose call is prod's, APP_TAG=S1" eq "$(grep ':: compose' <<<"$calls" | grep -vc "app_tag=$S1 :: $prod_compose ")" 0
check "prod: no dev file in any call" not_contains "$calls" "/opt/focus/dev/"
check "prod: docker gets PATH, HOME and APP_TAG only" clean_env_only "$calls"
check "prod: the host-wide :S1 now points at prod's digest, not dev's re-push" eq "$(cat "$FAKE/tags/$S1")" "$D1"
check "prod: the app runs D1" eq "$(cat "$FAKE/running-prod")" "$D1"
check "prod: dev's state untouched (record, log, running image)" eq "$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")" "$dev_state"
check "prod record: env" eq "$(pvalue env)" prod
check "prod record: tag" eq "$(pvalue tag)" "$S1"
check "prod record: digest" eq "$(pvalue digest)" "$D1"
check "prod record: image by digest" eq "$(pvalue image)" "$REPO@$D1"
check "prod record: action" eq "$(pvalue action)" deploy
check "prod record: no previous release" eq "$(pvalue previous_tag)$(pvalue previous_digest)" ""
check "prod record: infra revision" eq "$(pvalue infra_revision)" "$D"
check "prod record is deploy's, 640" eq "$(mode_owner "$PROD_RECORD")" "640 deploy:deploy"
check "prod history: one ok line" eq "$(grep -c ' outcome=ok ' "$PROD_HISTORY")" 1
check "prod history names the release" contains "$(tail -n1 "$PROD_HISTORY")" "env=prod action=deploy outcome=ok tag=$S1 digest=$D1"
prod status
check "prod status prints prod's record" eq "$out" "$(cat "$PROD_RECORD")"
ci status
check "dev status still prints dev's record" eq "$out" "$(cat "$RECORD")"

prod "deploy $S2 $D2"
check "second prod deploy succeeds" eq "$rc" 0
check "prod record: previous release is the first (#30's rollback target)" eq "$(pvalue previous_tag) $(pvalue previous_digest)" "$S1 $D1"

echo "--- Prod: a failing step stops the deploy and keeps the record"
before_record=$(cat "$PROD_RECORD")
touch "$FAKE/fail/verify"
mark
hmark "$PROD_HISTORY"
prod "deploy $S1 $D1"
rm "$FAKE/fail/verify"
check "prod runs another image: fails (status 1)" eq "$rc" 1
check "prod runs another image: at start" contains "$out" "failed at 'start'"
check "prod runs another image: says so" contains "$out" "the app runs image"
check "prod runs another image: record unchanged" eq "$(cat "$PROD_RECORD")" "$before_record"
check "prod runs another image: logged" contains "$(new_history "$PROD_HISTORY" | first_line)" "outcome=failed tag=$S1 digest=$D1 previous_tag=$S2"
check "prod runs another image: the revert to S2 was tried, and failed the same way" \
  contains "$(new_history "$PROD_HISTORY" | sed -n 2p)" "env=prod action=revert outcome=failed tag=$S2 digest=$D2"
# An older release on a newer schema: alembic can't locate the revision, before any DDL.
before_record=$(cat "$PROD_RECORD")
before_running=$(cat "$FAKE/running-prod")
touch "$FAKE/fail/migrate"
mark
prod "deploy $S1 $D1"
rm "$FAKE/fail/migrate"
calls=$(new_calls)
check "prod failed migration: fails (status 1)" eq "$rc" 1
check "prod failed migration: at migrate" contains "$out" "failed at 'migrate'"
check "prod failed migration: it did try prod's migration" contains "$calls" "$prod_migrate"
check "prod failed migration: never starts the app" not_contains "$calls" " up -d"
check "prod failed migration: no running-image check" not_contains "$calls" ":: inspect"
check "prod failed migration: record unchanged" eq "$(cat "$PROD_RECORD")" "$before_record"
check "prod failed migration: the app still runs the same image" eq "$(cat "$FAKE/running-prod")" "$before_running"
check "prod failed migration: logged" contains "$(tail -n1 "$PROD_HISTORY")" "action=deploy outcome=failed tag=$S1 digest=$D1"
check "prod failed migration: logged step" contains "$(tail -n1 "$PROD_HISTORY")" "step=migrate"

echo "--- Prod: waits for the host-wide lock (a dev deploy, a rollback, install.sh)"
rm -f /tmp/released
flock /opt/focus/deploy.lock bash -c 'sleep 3; date +%s.%N > /tmp/released' &
holder=$!
sleep 0.5
mark
prod "deploy $S1 $D1"
wait "$holder"
check "prod deploy succeeds once the lock is free" eq "$rc" 0
check "prod deploy said it was waiting" contains "$out" "waiting up to 900s"
first=$(new_calls | first_line | cut -d' ' -f1)
check "prod: no docker call while another holder had the lock" \
  awk -v a="$first" -v b="$(cat /tmp/released)" 'BEGIN { exit !(a >= b) }'
check "dev's state still untouched by every prod request" eq "$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")" "$dev_state"

echo "--- Automatic revert: a deliberately broken build on dev (#30)"
S4=$(sha 0xa4) D7=$(digest 0xd7) D8=$(digest 0xd8)
echo "$S4" >"$FAKE/labels/$D7"
echo up >"$FAKE/broken/$D7" # never turns healthy: /healthz fails, `up --wait` fails
echo "$S4" >"$FAKE/labels/$D8"
echo readyz >"$FAKE/broken/$D8" # healthy, but /readyz (the database) doesn't answer
check "sanity: dev runs S1 (the re-push D5) before the broken deploys" eq "$(value tag) $(value digest)" "$S1 $D5"
broken_deploy() { # <description> <digest> <what the output says failed>
  local desc=$1 dig=$2 says=$3 before_record
  before_record=$(cat "$RECORD")
  put "$FAKE/tags/$S1" "$D2" # someone moved the host-wide :S1 (prod has D1, dev D5)
  touch "$FAKE/probe-lock"
  rm -f "$FAKE/lock-probe.log"
  mark
  hmark
  ci_as dev -o 'SetEnv=LC_FOCUS=leak LANG=C.UTF-8' -- "deploy $S4 $dig"
  rm "$FAKE/probe-lock"
  printf '%s\n' "$out" | sed 's/^/     | /'
  calls=$(new_calls)
  check "$desc: the deploy fails (status 1), so the workflow goes red" eq "$rc" 1
  check "$desc: says why" contains "$out" "$says"
  check "$desc: says it failed at start and reverted" contains "$out" "failed at 'start' (its checks failed): reverted to $S1"
  check "$desc: it migrated and started the broken build first" before "$calls" "app_tag=$S4 $migrate" "app_tag=$S4 $start"
  check "$desc: then re-tags :S1 from dev's own digest D5" before "$calls" "app_tag=$S4 $start" ":: tag $REPO@$D5 $REPO:$S1"
  check "$desc: then starts S1 again" before "$calls" ":: tag $REPO@$D5 $REPO:$S1" "app_tag=$S1 $start"
  check "$desc: the revert doesn't migrate" not_contains "$(after "$calls" "app_tag=$S4 $start")" "alembic"
  check "$desc: the revert checks the dependency images (#170)" \
    contains "$(after "$calls" "app_tag=$S4 $start")" "app_tag=$S1 :: $compose_args config --images"
  check "$desc: the revert checks the running image" contains "$(after "$calls" "app_tag=$S1 $start")" ":: inspect --format {{.Image}} container-dev-app"
  check "$desc: the revert checks /healthz and /readyz" \
    contains "$(after "$calls" "app_tag=$S1 $start")" "app_tag=$S1 :: $compose_args exec -T app python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz'"
  check "$desc: dev runs D5 again" eq "$(cat "$FAKE/running-dev")" "$D5"
  check "$desc: the host-wide :S1 points at D5 again" eq "$(cat "$FAKE/tags/$S1")" "$D5"
  check "$desc: the record still names S1 D5 (unchanged)" eq "$(cat "$RECORD")" "$before_record"
  check "$desc: the failed deploy is logged" contains "$(new_history | sed -n 1p)" "action=deploy outcome=failed tag=$S4 digest=$dig previous_tag=$S1 previous_digest=$D5"
  check "$desc: with its step" contains "$(new_history | sed -n 1p)" "step=start"
  check "$desc: then the revert" contains "$(new_history | sed -n 2p)" "action=revert outcome=ok tag=$S1 digest=$D5"
  check "$desc: which names what failed" contains "$(new_history | sed -n 2p)" "failed_action=deploy failed_tag=$S4 failed_digest=$dig"
  check "$desc: two history lines" eq "$(new_history | wc -l)" 2
  check "$desc: a failed deploy prunes nothing (#117)" not_contains "$calls" ":: image ls"
  check "$desc: docker gets PATH, HOME and APP_TAG only" clean_env_only "$calls"
  check "$desc: no prod file in any call" not_contains "$calls" "/opt/focus/prod/"
  check "$desc: both starts ran under the deploy lock" \
    eq "$(cat "$FAKE/lock-probe.log")" "app_tag=$S4 lock=held"$'\n'"app_tag=$S1 lock=held"
  prod "candidate $S4"
  check "$desc: prod can't take the broken build" eq "$rc" 1
  check "$desc: candidate says dev never ran it successfully" contains "$out" "dev ran no release of $S4 successfully"
}
broken_deploy "never healthy" "$D7" "focus-ci: FAILED"
check "never healthy: no endpoint check on the broken build (up --wait failed)" \
  not_contains "$(new_calls | grep "app_tag=$S4 ")" "exec -T app"
broken_deploy "no /readyz" "$D8" "/readyz doesn't answer inside the app container"
check "no /readyz: /healthz passed on the broken build, /readyz retried 3 times" \
  eq "$(new_calls | grep "app_tag=$S4 " | grep -c "8000/readyz")" 3

echo "--- The revert pulls a dependency image the host lost meanwhile (#170)"
put "$FAKE/drop-on-up" "${OTEL#*@}" # the collector's image leaves the host as the start fails
mark
hmark
ci "deploy $S4 $D7"
rm "$FAKE/drop-on-up"
calls=$(new_calls)
check "lost image: the deploy fails and reverts" contains "$out" "failed at 'start' (its checks failed): reverted to $S1"
check "lost image: the revert pulls the collector's image by its pinned digest" \
  contains "$(after "$calls" "app_tag=$S4 $start")" ":: pull --quiet $OTEL"
check "lost image: before starting S1 again" \
  before "$(after "$calls" "app_tag=$S4 $start")" ":: pull --quiet $OTEL" "app_tag=$S1 $start"
check "lost image: the revert is logged ok" contains "$(new_history | sed -n 2p)" "action=revert outcome=ok tag=$S1 digest=$D5"
check "lost image: dev runs D5 again" eq "$(cat "$FAKE/running-dev")" "$D5"

echo "--- A dropped SSH session doesn't stop the revert (#30 review)"
before_record=$(cat "$RECORD")
echo 2 >"$FAKE/sleep-up" # each start takes 2 s
mark
hmark
ssh "${ssh_opts[@]}" -i "$keys/dev" deploy@127.0.0.1 "deploy $S4 $D7" >/tmp/dropped.out 2>&1 &
client=$!
for _ in $(seq 100); do # until the broken build's start has begun
  grep -q "app_tag=$S4 :: $compose_args up" <<<"$(new_calls)" && break
  sleep 0.1
done
kill "$client"
wait "$client" || true
flock -w 60 /opt/focus/deploy.lock true # focus-ci is done once the lock is free
rm "$FAKE/sleep-up"
check "dropped session: the client was gone before the revert began" not_contains "$(cat /tmp/dropped.out)" "revert:"
check "dropped session: the failed deploy is logged" contains "$(new_history | sed -n 1p)" "action=deploy outcome=failed tag=$S4 digest=$D7"
check "dropped session: the revert still ran and is logged" contains "$(new_history | sed -n 2p)" "action=revert outcome=ok tag=$S1 digest=$D5"
check "dropped session: dev runs D5 again" eq "$(cat "$FAKE/running-dev")" "$D5"
check "dropped session: record unchanged" eq "$(cat "$RECORD")" "$before_record"
check "dropped session: the revert checked /readyz" contains "$(after "$(new_calls)" "app_tag=$S1 :: $compose_args up")" "8000/readyz"

echo "--- Automatic revert on prod: a build broken only there (#30)"
S5=$(sha 0xa5) D9=$(digest 0xd9)
echo "$S5" >"$FAKE/labels/$D9"
echo "up prod" >"$FAKE/broken/$D9"
ci "deploy $S5 $D9"
check "dev runs S5 fine" eq "$rc" 0
dev_state=$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")
before_record=$(cat "$PROD_RECORD")
check "sanity: prod runs S1 D1" eq "$(pvalue tag) $(pvalue digest) $(cat "$FAKE/running-prod")" "$S1 $D1 $D1"
mark
hmark "$PROD_HISTORY"
prod "deploy $S5 $D9"
calls=$(new_calls)
check "prod deploy of the broken build fails (status 1)" eq "$rc" 1
check "prod: reverted to S1" contains "$out" "reverted to $S1"
check "prod: migrated prod for S5, then started it" before "$calls" "app_tag=$S5 $prod_migrate" "app_tag=$S5 $prod_start"
check "prod: the revert re-tags :S1 from prod's digest D1" before "$calls" "app_tag=$S5 $prod_start" ":: tag $REPO@$D1 $REPO:$S1"
check "prod: the revert starts S1, no migration" contains "$(after "$calls" "app_tag=$S5 $prod_start")" "app_tag=$S1 $prod_start"
check "prod: the revert doesn't migrate" not_contains "$(after "$calls" "app_tag=$S5 $prod_start")" "alembic"
check "prod runs D1 again" eq "$(cat "$FAKE/running-prod")" "$D1"
check "prod record unchanged" eq "$(cat "$PROD_RECORD")" "$before_record"
check "prod log: failed deploy, then the revert" \
  eq "$(new_history "$PROD_HISTORY" | sed 's/^time=[^ ]* //' | cut -d' ' -f1-5)" \
  "env=prod action=deploy outcome=failed tag=$S5 digest=$D9"$'\n'"env=prod action=revert outcome=ok tag=$S1 digest=$D1"
check "prod revert: every compose call is prod's" eq "$(grep ':: compose' <<<"$calls" | grep -vc ":: $prod_compose ")" 0
check "prod revert: dev's state untouched" eq "$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")" "$dev_state"
check "prod revert: clean environment" clean_env_only "$calls"

echo "--- Rollback picks the last known-good release (#30)"
S6=$(sha 0xa6) S7=$(sha 0xa7) S8=$(sha 0xa8) S9=$(sha 0xa9)
D10=$(digest 0xe0) D11=$(digest 0xe1) D12=$(digest 0xe2) D13=$(digest 0xe3)
echo "$S6" >"$FAKE/labels/$D10"
echo "$S7" >"$FAKE/labels/$D11"
echo "$S8" >"$FAKE/labels/$D12"
echo "$S9" >"$FAKE/labels/$D13"
for release in "$S6 $D10" "$S7 $D11" "$S8 $D12"; do
  ci "deploy $release"
  check "deploy $release succeeds" eq "$rc" 0
done
check "record: S8, rollback target S7" eq "$(value tag) $(value previous_tag)" "$S8 $S7"
put "$FAKE/tags/$S7" "$D10" # the host-wide :S7 moved
rm "$FAKE/local/$D11"         # and S7's image was pruned from the host
prune "$OTEL"                 # and the collector's (#117's pruning, #170)
before_record=$(cat "$RECORD")
mark
hmark
ci "rollback expect $D11"
check "rollback expect <not the current digest>: fails (status 1)" eq "$rc" 1
check "rollback expect: says a deploy or rollback ran in between" contains "$out" "not the expected $D11"
check "rollback expect: no docker call" no_new_calls
check "rollback expect: record unchanged, nothing logged" eq "$(cat "$RECORD")$(new_history)" "$before_record"
mark
touch "$FAKE/probe-lock"
rm -f "$FAKE/pull-lock-probe.log"
ci "rollback expect $D12"
rm "$FAKE/probe-lock"
calls=$(new_calls)
check "rollback succeeds" eq "$rc" 0
check "rollback: pulls the collector's pruned image by its pinned digest (#170)" contains "$calls" ":: pull --quiet $OTEL"
check "rollback: before starting" before "$calls" ":: pull --quiet $OTEL" "app_tag=$S7 $start"
check "rollback: both pulls ran under the deploy lock" \
  eq "$(cat "$FAKE/pull-lock-probe.log")" "pull $OTEL lock=held"$'\n'"pull $REPO@$D11 lock=held"
check "rollback prints what it left and what runs now" contains "$out" "result from_tag=$S8 from_digest=$D12 tag=$S7 digest=$D11"
check "rollback: to S7, the release before S8" eq "$(value tag) $(value digest) $(value action)" "$S7 $D11 rollback"
check "rollback: pulls S7 by its recorded digest" contains "$calls" ":: pull --quiet $REPO@$D11"
check "rollback: checks its revision label" contains "$calls" "org.opencontainers.image.revision\" }} $REPO@$D11"
check "rollback: re-tags :S7 from its own digest" before "$calls" ":: tag $REPO@$D11 $REPO:$S7" "app_tag=$S7 $start"
check "rollback: runs no migration" not_contains "$calls" "alembic"
check "rollback: dev runs D11" eq "$(cat "$FAKE/running-dev")" "$D11"
check "rollback: checks /healthz and /readyz" contains "$calls" "8000/readyz"
check "rollback: dev's files only" not_contains "$calls" "/opt/focus/prod/"
check "rollback: clean environment" clean_env_only "$calls"
check "rollback: the next target is S6" eq "$(value previous_tag) $(value previous_digest)" "$S6 $D10"
check "rollback: logged with the release it left" contains "$(last_history)" "action=rollback outcome=ok tag=$S7 digest=$D11 previous_tag=$S6 previous_digest=$D10 infra=$D from_tag=$S8 from_digest=$D12"

echo "--- A release dev rolled back from isn't promotable (#30, #125 review)"
mark
prod "candidate $S8"
check "candidate of a rolled-back release: fails (status 1)" eq "$rc" 1
check "candidate: says dev rolled back from it" contains "$out" "dev rolled back from every release of $S8"
before_record=$(cat "$PROD_RECORD")
hmark "$PROD_HISTORY"
prod "deploy $S8 $D12"
check "prod deploy of a rolled-back release: fails (status 1)" eq "$rc" 1
check "prod deploy: at the promote step" contains "$out" "failed at 'promote'"
check "prod deploy: says it isn't promotable" contains "$out" "dev rolled back from $S8 $D12, so it is not promotable"
check "prod deploy: no docker call" no_new_calls
check "prod deploy: prod record unchanged" eq "$(cat "$PROD_RECORD")" "$before_record"
check "prod deploy: logged as failed at promote" contains "$(new_history "$PROD_HISTORY")" "action=deploy outcome=failed tag=$S8 digest=$D12"
prod "candidate $S7"
check "the release dev rolled back to is promotable" eq "$rc" 0
prod candidate
check "candidate without a sha: dev's current release (S7)" contains "$out" "tag=$S7"

echo "--- rollback <sha>: only a known-good release"
rollback_refused() { # <description> <sha>
  local before_record
  before_record=$(cat "$RECORD")
  mark
  hmark
  ci "rollback $2"
  check "$1: fails (status 1)" eq "$rc" 1
  check "$1: says it's not known-good" contains "$out" "no known-good release of $2 is recorded on dev"
  check "$1: no docker call" no_new_calls
  check "$1: record unchanged" eq "$(cat "$RECORD")" "$before_record"
  check "$1: nothing logged" eq "$(new_history)" ""
}
rollback_refused "the release dev rolled back from" "$S8"
rollback_refused "the current release" "$S7"
rollback_refused "a commit whose image dev never ran" "$S3"
rollback_refused "a build that only failed (and was reverted)" "$S4"
rollback_refused "a commit nobody deployed" "$(sha 0xbad)"
ci rollback
check "rolling back again goes further back: S6" eq "$rc $(value tag)" "0 $S6"
check "the next target skips S8 and S7, both rolled back from: S5" eq "$(value previous_tag)" "$S5"
ci "deploy $S9 $D13"
check "deploy S9: the rollback target is S6, not a rolled-back release" eq "$rc $(value previous_tag)" "0 $S6"
mark
ci "rollback $S1"
check "rollback <sha>: succeeds" eq "$rc" 0
check "rollback <sha>: the newest known-good digest of that commit (D5, not D1)" eq "$(value tag) $(value digest)" "$S1 $D5"
check "rollback <sha>: no migration" not_contains "$(new_calls)" "alembic"
check "rollback <sha>: names the release it left" contains "$(last_history)" "from_tag=$S9 from_digest=$D13"
ci "deploy $S8 $D12"
check "dev deploys S8 again" eq "$rc" 0
prod "candidate $S8"
check "once dev runs S8 again, it's promotable again" eq "$rc" 0
check "candidate: S8's digest" contains "$out" "digest=$D12"

echo "--- A rollback whose target fails starts the release it left again"
echo up >"$FAKE/broken/$D5" # the target, S1 D5, turns out broken now
before_record=$(cat "$RECORD")
mark
hmark
ci rollback
rm "$FAKE/broken/$D5"
calls=$(new_calls)
check "failed rollback: fails (status 1)" eq "$rc" 1
check "failed rollback: tried S1 D5" contains "$calls" "app_tag=$S1 $start"
check "failed rollback: says so and went back to S8" contains "$out" "rollback of $S1 failed at 'start' (its checks failed): reverted to $S8"
check "failed rollback: dev runs S8 again" eq "$(cat "$FAKE/running-dev")" "$D12"
check "failed rollback: no migration" not_contains "$calls" "alembic"
check "failed rollback: record unchanged" eq "$(cat "$RECORD")" "$before_record"
check "failed rollback: logged" contains "$(new_history | sed -n 1p)" "action=rollback outcome=failed tag=$S1 digest=$D5"
check "failed rollback: and the revert" contains "$(new_history | sed -n 2p)" "action=revert outcome=ok tag=$S8 digest=$D12"
prod "candidate $S8"
check "failed rollback: S8 wasn't rolled back from, so it stays promotable" eq "$rc" 0

echo "--- The prod rollback key: rollback-prod (#30)"
rb() { ci_as rollback -- "$@"; }
rb_refused=(
  "${refused[@]}"
  "deploy $S1 $D1"
  "deploy $S2 $D2"
  "candidate"
  "candidate $S1"
  "status prod"
  "status dev"
  "rollback dev"
  "rollback $S1 dev"
)
for request in "${rb_refused[@]}"; do
  mark
  rb "$request"
  shown=$(printf '%q' "${request:0:60}")
  check "rollback key refused: $shown" eq "$rc" 2
  check "rollback key refused with a message: $shown" contains "$out" "focus-ci: refused"
  check "rollback key: no docker call for: $shown" no_new_calls
done
rb "deploy $S1 $D1"
check "rollback key can't deploy" contains "$out" "deploy isn't allowed for profile rollback-prod"
rb candidate
check "rollback key can't read dev's records" contains "$out" "candidate isn't allowed for profile rollback-prod"
rb status
check "rollback key: status prints prod's record" eq "$out" "$(cat "$PROD_RECORD")"
prod_rollback_refused() { # <description> <sha>
  local before_record
  before_record=$(cat "$PROD_RECORD")
  mark
  rb "rollback $2"
  check "rollback key, $1: fails (status 1)" eq "$rc" 1
  check "rollback key, $1: not known-good on prod" contains "$out" "no known-good release of $2 is recorded on prod"
  check "rollback key, $1: no docker call" no_new_calls
  check "rollback key, $1: prod record unchanged" eq "$(cat "$PROD_RECORD")" "$before_record"
}
prod_rollback_refused "a release only dev ran" "$S8"
prod_rollback_refused "a release prod only failed with" "$S5"
prod_rollback_refused "prod's current release" "$S1"
prod_rollback_refused "a commit nobody deployed" "$(sha 0xbad)"

dev_state=$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")
rm "$FAKE/local/$D2" # pruned from the host: the rollback pulls it by its recorded digest
prune "$PG"          # and Postgres' image (#170)
put "$FAKE/tags/$S2" "$D5"
rm -f /tmp/released
flock /opt/focus/deploy.lock bash -c 'sleep 3; date +%s.%N > /tmp/released' &
holder=$!
sleep 0.5
mark
ci_as rollback -o 'SetEnv=LC_FOCUS=leak LANG=C.UTF-8' -- "rollback expect $D1"
wait "$holder"
printf '%s\n' "$out" | sed 's/^/     | /'
calls=$(new_calls)
check "rollback key: rollback succeeds once the lock is free" eq "$rc" 0
check "rollback key: prints the result" contains "$out" "result from_tag=$S1 from_digest=$D1 tag=$S2 digest=$D2"
check "rollback key: said it was waiting" contains "$out" "waiting up to 900s"
first=$(new_calls | first_line | cut -d' ' -f1)
check "rollback key: no docker call while another holder had the lock" \
  awk -v a="$first" -v b="$(cat /tmp/released)" 'BEGIN { exit !(a >= b) }'
check "rollback key: prod rolled back to S2, prod's release before S1" eq "$(pvalue tag) $(pvalue digest) $(pvalue action)" "$S2 $D2 rollback"
check "rollback key: pulls S2 by prod's recorded digest" contains "$calls" ":: pull --quiet $REPO@$D2"
check "rollback key: pulls Postgres' pruned image by its pinned digest" contains "$calls" ":: pull --quiet $PG"
check "rollback key: before starting" before "$calls" ":: pull --quiet $PG" "app_tag=$S2 $prod_start"
check "rollback key: re-tags :S2 from it" before "$calls" ":: tag $REPO@$D2 $REPO:$S2" "app_tag=$S2 $prod_start"
check "rollback key: runs no migration" not_contains "$calls" "alembic"
check "rollback key: prod runs D2" eq "$(cat "$FAKE/running-prod")" "$D2"
check "rollback key: every compose call is prod's, APP_TAG=S2" eq "$(grep ':: compose' <<<"$calls" | grep -vc "app_tag=$S2 :: $prod_compose ")" 0
check "rollback key: no dev file in any call" not_contains "$calls" "/opt/focus/dev/"
check "rollback key: docker gets PATH, HOME and APP_TAG only" clean_env_only "$calls"
check "rollback key: dev's state untouched" eq "$(cat "$RECORD" "$HISTORY" "$FAKE/running-dev")" "$dev_state"
check "rollback key: logged in prod's log" contains "$(tail -n1 "$PROD_HISTORY")" "env=prod action=rollback outcome=ok tag=$S2 digest=$D2"
check "rollback key: with the release it left" contains "$(tail -n1 "$PROD_HISTORY")" "from_tag=$S1 from_digest=$D1"
check "rollback key: nothing further back (S1 was rolled back from)" eq "$(pvalue previous_tag)" ""
rb rollback
check "rollback key: a second rollback has nowhere to go (status 1)" eq "$rc" 1
check "rollback key: says so" contains "$out" "nothing to roll back to"
prod "deploy $S1 $D1"
check "prod key deploys S1 again (dev ran it)" eq "$rc" 0
check "prod: the rollback target is S2 again" eq "$(pvalue previous_tag)" "$S2"
mark
rb "rollback $S2"
check "rollback key: rollback <sha> to a known-good prod release succeeds" eq "$rc" 0
check "rollback key: prod runs S2 D2" eq "$(pvalue tag) $(pvalue digest) $(cat "$FAKE/running-prod")" "$S2 $D2 $D2"
check "rollback key: rollback <sha>: no migration" not_contains "$(new_calls)" "alembic"

echo "--- Pruning old app images (#117)"
KEEP=$(sed -n 's/^readonly KEEP_KNOWN_GOOD=\([0-9][0-9]*\)$/\1/p' /opt/focus/bin/focus-ci)
check "sanity: focus-ci keeps a number of known-good releases per environment" [ -n "$KEEP" ]
# Each `image rm` names only the app's references: <repo>:<tag> or <repo>@<digest>.
rm_app_only() {
  local line word bad=""
  while IFS= read -r line; do
    for word in ${line#*:: image rm }; do
      [[ $word == "$REPO:"* || $word == "$REPO@"* ]] || bad+="$word "
    done
  done < <(grep ':: image rm ' <<<"$1" || true)
  [[ -z $bad ]] && return 0
  printf '     image rm of other references: %s\n' "$bad"
  return 1
}
OTHER=example/other:1@$(digest 0xfe) # an image of another repository, on the host
printf '%s\n' "${OTHER%@*}" >"$FAKE/local/${OTHER#*@}"
chmod 0666 "$FAKE/local/${OTHER#*@}"
check "sanity: prod runs S2 D2, with no rollback target" eq "$(pvalue tag) $(pvalue digest) $(pvalue previous_digest)" "$S2 $D2 "
N=$((KEEP + 2))
P=() Q=()
for ((i = 1; i <= N; i++)); do
  P[i]=$(sha $((0xc0 + i)))
  Q[i]=$(digest $((0xf0 + i)))
  echo "${P[i]}" >"$FAKE/labels/${Q[i]}"
done
for ((i = 1; i < N; i++)); do
  ci "deploy ${P[i]} ${Q[i]}"
  check "dev deploys release $i of $N" eq "$rc" 0
done
touch "$FAKE/probe-lock"
rm -f "$FAKE/rm-lock-probe.log"
mark
ci_as dev -o 'SetEnv=LC_FOCUS=leak LANG=C.UTF-8' -- "deploy ${P[N]} ${Q[N]}"
rm "$FAKE/probe-lock"
printf '%s\n' "$out" | sed 's/^/     | /'
calls=$(new_calls)
check "deploy $N succeeds" eq "$rc" 0
for ((i = N - KEEP + 1; i <= N; i++)); do
  check "dev's release $i (one of its newest $KEEP known-good) stays on the host" on_host "${Q[i]}"
done
check "dev's release 1 is pruned (outside the window)" bash -c "! [ -e '$FAKE/local/${Q[1]}' ]"
check "dev's release 2 is pruned by this deploy" bash -c "! [ -e '$FAKE/local/${Q[2]}' ]"
check "with its host-wide tag" bash -c "! [ -e '$FAKE/tags/${P[2]}' ]"
check "the deploy says what it pruned" contains "$out" "pruned $REPO:${P[2]} $REPO@${Q[2]}"
check "and how many it kept" contains "$out" "old $REPO image(s);"
check "prod's current release stays (any profile keeps both environments')" on_host "$D2"
check "Postgres' pinned image stays (#170)" on_host "$PG"
check "the collector's pinned image stays (#170)" on_host "$OTEL"
check "Caddy's pinned image stays (#170)" on_host "$CADDY"
check "another repository's image stays" on_host "$OTHER"
check "pruning lists the images after the start and its checks" before "$calls" "/readyz" ":: image ls"
check "it removes only the app's references" rm_app_only "$calls"
check "it never forces a removal" not_contains "$(grep ':: image rm ' <<<"$calls")" " -f"
check "it removes under the deploy lock" eq "$(sed 's/.* lock=//' "$FAKE/rm-lock-probe.log" | sort -u)" held
check "pruning: docker gets PATH, HOME and APP_TAG only" clean_env_only "$calls"
check "pruning: no prod file in any call" not_contains "$calls" "/opt/focus/prod/"

echo "--- An older known-good release stays a rollback target: it's pulled again"
mark
ci "rollback ${P[1]}"
calls=$(new_calls)
check "rollback to the pruned release 1 succeeds" eq "$rc" 0
check "it pulls release 1 by its recorded digest" contains "$calls" ":: pull --quiet $REPO@${Q[1]}"
check "dev runs release 1" eq "$(cat "$FAKE/running-dev")" "${Q[1]}"
check "the release it left ($N, now rolled back from) is pruned" bash -c "! [ -e '$FAKE/local/${Q[N]}' ]"
check "the next rollback target ($((N - 1))) stays" on_host "${Q[N - 1]}"
check "sanity: it is the record's previous release" eq "$(value previous_digest)" "${Q[N - 1]}"

echo "--- Prod's deploy and rollback keep dev's images, and dev's keep prod's"
mark
prod "deploy ${P[N - 1]} ${Q[N - 1]}"
check "prod deploys dev's release $((N - 1))" eq "$rc" 0
check "prod's deploy keeps dev's current release" on_host "${Q[1]}"
check "and prod's previous one (D2)" on_host "$D2"
check "prod's deploy removes only the app's references" rm_app_only "$(new_calls)"
mark
rb rollback
check "the rollback key rolls prod back to S2" eq "$rc $(pvalue digest)" "0 $D2"
check "the rollback key's prune keeps a release prod left but dev may still start" on_host "${Q[N - 1]}"
check "and dev's current release" on_host "${Q[1]}"
check "the rollback key's prune removes only the app's references" rm_app_only "$(new_calls)"

echo "--- Pruning never fails a deploy, and keeps what it can't be sure of"
SX=$(sha 0xcf) DX=$(digest 0xff)
echo "$SX" >"$FAKE/labels/$DX"
touch "$FAKE/fail/migrate"
ci "deploy $SX $DX"
rm "$FAKE/fail/migrate"
check "sanity: a deploy that failed at migrate" eq "$rc" 1
check "left its image on the host, tagged" eq "$(on_host "$DX" && cat "$FAKE/tags/$SX")" "$DX"
dev_release() { ci "deploy ${P[1]} ${Q[1]}"; } # redeploy dev's current release
touch "$FAKE/fail/rm"
mark
dev_release
rm "$FAKE/fail/rm"
check "docker can't remove an image: the deploy still succeeds" eq "$rc" 0
check "it warns and keeps the image" contains "$out" "focus-ci: warning: kept $REPO:$SX $REPO@$DX: docker couldn't remove it"
check "the image is still there" on_host "$DX"
check "the release is recorded" eq "$(value tag) $(value digest) $(value action)" "${P[1]} ${Q[1]} deploy"
cp -p "$PROD_HISTORY" /tmp/prod-history.bak
printf 'note-left-in-prods-log\n' >>"$PROD_HISTORY"
bad_n=$(wc -l <"$PROD_HISTORY")
mark
dev_release
cp -p /tmp/prod-history.bak "$PROD_HISTORY"
check "prod's log is malformed: dev's deploy still succeeds" eq "$rc" 0
# What the dev key sees of prod's log (#186): its path and the line's number, nothing
# of what the line holds.
check "it says it doesn't prune, and why: the path and line number only" eq \
  "$(grep -F 'not pruning' <<<"$out")" \
  "focus-ci: warning: not pruning old images: /opt/focus/prod/releases.log line $bad_n is malformed (see _docs/deployment.md, The release record)"
check "nothing of the bad line reaches the client" not_contains "$out" "note-left"
check "it lists no image, so removes none" not_contains "$(new_calls)" ":: image ls"
check "the stray image is still there" on_host "$DX"
touch "$FAKE/fail/refs"
mark
dev_release
rm "$FAKE/fail/refs"
check "an image's references can't be read: the deploy still succeeds" eq "$rc" 0
check "it keeps that image and says so" contains "$out" "focus-ci: warning: kept image $(printf 'sha256:img%s' "${DX#sha256:}")"
check "it removes nothing it couldn't read" not_contains "$(new_calls)" ":: image rm"
running_prod=$(cat "$FAKE/running-prod")
put "$FAKE/running-prod" "$DX" # a container runs the stray image (started by hand, say)
mark
dev_release
put "$FAKE/running-prod" "$running_prod"
check "an image a container runs: the deploy still succeeds" eq "$rc" 0
check "it keeps that image, with docker's reason" \
  contains "$out" "focus-ci: warning: kept $REPO:$SX $REPO@$DX: docker couldn't remove it (Error response from daemon: conflict"
check "it never forces a removal" not_contains "$(grep ':: image rm ' <<<"$(new_calls)")" " -f"
check "the image a container runs is still there" on_host "$DX"
mark
dev_release
check "the next deploy prunes the stray image" bash -c "! [ -e '$FAKE/local/$DX' ] && ! [ -e '$FAKE/tags/$SX' ]"
check "and says so" contains "$out" "pruned $REPO:$SX $REPO@$DX"
check "still only the app's references" rm_app_only "$(new_calls)"
check "the pinned images are all still there" bash -c "[ -e '$FAKE/local/${PG#*@}' ] && [ -e '$FAKE/local/${OTEL#*@}' ] && [ -e '$FAKE/local/${CADDY#*@}' ]"

echo "--- The containerd image store repeats a digest reference: each is named once (#186)"
SZ=$(sha 0xce) DZ=$(digest 0xfd)
echo "$SZ" >"$FAKE/labels/$DZ"
touch "$FAKE/fail/migrate"
ci "deploy $SZ $DZ" # a failed deploy leaves its image, tagged
rm "$FAKE/fail/migrate"
check "sanity: a stray image, tagged" eq "$rc $(cat "$FAKE/tags/$SZ")" "1 $DZ"
touch "$FAKE/containerd"
check "sanity: the fake lists its digest reference twice" eq \
  "$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' "$REPO@$DZ" | grep -c "@$DZ")" 2
mark
dev_release
rm "$FAKE/containerd"
check "containerd store: the deploy succeeds" eq "$rc" 0
check "it removes each reference once" eq "$(new_calls | grep -F ":: image rm " | grep -F "$DZ" | sed 's/.* :: //')" \
  "image rm $REPO:$SZ $REPO@$DZ"
check "it prints each reference once" eq "$(grep -F "pruned $REPO:$SZ" <<<"$out")" "==> pruned $REPO:$SZ $REPO@$DZ"
check "with no warning" not_contains "$out" "focus-ci: warning"
check "the stray image is gone" bash -c "! [ -e '$FAKE/local/$DZ' ] && ! [ -e '$FAKE/tags/$SZ' ]"

echo "--- releases.log is read strictly, and fails closed (#30 review)"
cp -p "$HISTORY" /tmp/dev-history.bak
log_refused() { # <description> <bad line> <reason shown>
  local n
  cp /tmp/dev-history.bak "$HISTORY"
  printf '%s\n' "$2" >>"$HISTORY"
  n=$(wc -l <"$HISTORY")
  mark
  ci rollback
  check "$1: rollback fails (status 1)" eq "$rc" 1
  check "$1: names the line and why" contains "$out" "/opt/focus/dev/releases.log line $n is malformed ($3)"
  ci "deploy $S2 $D2"
  check "$1: a deploy fails the same way, loudly" contains "$out" "line $n is malformed"
  check "$1: no docker call" no_new_calls
  prod "candidate $S2"
  check "$1: prod's candidate fails too" eq "$rc" 1
  check "$1: and says why" contains "$out" "line $n is malformed"
}
ok_line="time=2026-01-01T00:00:00Z env=dev action=deploy outcome=ok tag=$S2 digest=$D2 previous_tag=- previous_digest=- infra=$D"
log_refused "an empty key" "$ok_line =x" "=x isn't key=value"
log_refused "a repeated key" "${ok_line/outcome=ok/outcome=failed} outcome=ok" "outcome appears twice"
log_refused "an uppercase key" "${ok_line/outcome=ok/Outcome=ok}" "Outcome=ok isn't key=value"
log_refused "a word without =" "$ok_line garbage" "garbage isn't key=value"
cp /tmp/dev-history.bak "$HISTORY"
printf '\n' >>"$HISTORY" # an empty line carries no claim: skipped
S10=$(sha 0xaa) D14=$(digest 0xe4)
echo "$S10" >"$FAKE/labels/$D14"
hand_line="time=2026-01-01T00:00:00Z env=dev action=deploy outcome=ok tag=$S10 digest=$D14 previous_tag=- previous_digest=- infra=$D"
printf '%s' "$hand_line" >>"$HISTORY" # no final newline
prod "candidate $S10"
check "a last line without a newline still counts" eq "$rc" 0
check "it's that line's digest" contains "$out" "digest=$D14"
ci "deploy $S10 $D14"
check "the next deploy succeeds" eq "$rc" 0
check "and doesn't glue its line onto the last one" eq "$(tail -n 2 "$HISTORY" | first_line)" "$hand_line"
check "its own line is whole" contains "$(last_history)" "action=deploy outcome=ok tag=$S10 digest=$D14"

echo "--- The schema step: what a deploy can't read stops it before migrating (#165)"
install -d -m 0755 "$FAKE/schema"
schema() { printf '%s\n' "$2" >"$FAKE/schema/$1"; } # <digest> <what migration_info prints>
SY=$(sha 0xb0) EY=$(digest 0x1b0)
echo "$SY" >"$FAKE/labels/$EY"
touch "$FAKE/fail/schema"
deploy_fails "the schema step fails" schema "$SY" "$EY" "alembic"
rm "$FAKE/fail/schema"
no_revert "the schema step fails"
schema "$EY" $'schema=0002\nschema=0003\ncontracts=-'
deploy_fails "two schema lines" schema "$SY" "$EY" "alembic"
check "two schema lines: says what it got" contains "$out" "can't read $SY's schema"
schema "$EY" $'schema=0002\ncontracts=0003;id'
deploy_fails "a contract list that isn't revision ids" schema "$SY" "$EY" "alembic"
schema "$EY" "contracts=-"
deploy_fails "no schema line" schema "$SY" "$EY" "alembic"
rm "$FAKE/schema/$EY"
mv /opt/focus/infra/app/migration_info.py /tmp/migration_info.py
deploy_fails "migration_info.py isn't installed" schema "$SY" "$EY" "alembic"
mv /tmp/migration_info.py /opt/focus/infra/app/migration_info.py
check "migration_info.py isn't installed: says to run install.sh" contains "$out" "/opt/focus/infra/app/migration_info.py is missing: run infra/server/install.sh"

echo "--- Rollback floor: a contract migration retires older releases (#165)"
F1=$(sha 0xb1) F2=$(sha 0xb2) C1=$(sha 0xb3) Z=$(sha 0xb4) G=$(sha 0xb5) K=$(sha 0xb6) L=$(sha 0xb7) M=$(sha 0xb8)
EF1=$(digest 0x1b1) EF2=$(digest 0x1b2) EC=$(digest 0x1b3) EZ=$(digest 0x1b4)
EG=$(digest 0x1b5) EK=$(digest 0x1b6) EL=$(digest 0x1b7) EM=$(digest 0x1b8)
for release in "$F1 $EF1" "$F2 $EF2" "$C1 $EC" "$Z $EZ" "$G $EG" "$K $EK" "$L $EL" "$M $EM"; do
  read -r s d <<<"$release"
  echo "$s" >"$FAKE/labels/$d"
done
schema "$EC" $'schema=0003\ncontracts=0003' # C1 drops what F1 and F2 may still use
schema "$EZ" $'schema=0003\ncontracts=0003'
schema "$EG" $'schema=0004\ncontracts=0003'
schema "$EK" $'schema=0005\ncontracts=0003,0005'
schema "$EL" $'schema=0005\ncontracts=0003,0005'
schema "$EM" $'schema=0006\ncontracts=0003,0005,0006'
floor_lines() { grep -c ' action=floor ' "$1" || true; }
for release in "$F1 $EF1" "$F2 $EF2"; do
  ci "deploy $release"
  check "dev deploys ${release%% *}" eq "$rc" 0
  prod "deploy $release"
  check "prod deploys ${release%% *}" eq "$rc" 0
done
check "sanity: dev and prod run F2, with F1 as their rollback target" \
  eq "$(value tag) $(value previous_tag) $(pvalue tag) $(pvalue previous_tag)" "$F2 $F1 $F2 $F1"
check "sanity: no floor line in either log yet" eq "$(floor_lines "$HISTORY") $(floor_lines "$PROD_HISTORY")" "0 0"

mark
hmark
ci "deploy $C1 $EC"
printf '%s\n' "$out" | sed 's/^/     | /'
calls=$(new_calls)
check "contract deploy on dev succeeds" eq "$rc" 0
check "it says it sets dev's rollback floor" contains "$out" "contract migration 0003: dev's rollback floor is now $C1"
check "the floor line comes first, then the deploy's" \
  eq "$(new_history | sed 's/^time=[^ ]* //' | cut -d' ' -f1-5)" \
  "env=dev action=floor outcome=set tag=$C1 digest=$EC"$'\n'"env=dev action=deploy outcome=ok tag=$C1 digest=$EC"
check "the floor line names the schema and the contract revisions" contains "$(new_history | first_line)" " schema=0003 contracts=0003"
check "the floor line names no rollback target" contains "$(new_history | first_line)" "previous_tag=- previous_digest=-"
check "the deploy line records the schema" contains "$(last_history)" " schema=0003"
check "it migrates as usual" contains "$calls" "app_tag=$C1 $migrate"
check "record: no rollback target, everything before is below the floor" eq "$(value previous_tag)$(value previous_digest)" ""
check "prod's log has no floor line" eq "$(floor_lines "$PROD_HISTORY")" 0
check "prod still runs and may start F1 and F2: their images stay" bash -c "[ -e '$FAKE/local/$EF1' ] && [ -e '$FAKE/local/$EF2' ]"

FLOOR1="contract migration 0003 ran with the deploy of $C1 at"
at_floor() { # <description> <request> <message> <floor note>
  local before_record
  before_record=$(cat "$RECORD")
  mark
  hmark
  ci "$2"
  check "$1: fails (status 1)" eq "$rc" 1
  check "$1: says why" contains "$out" "$3"
  check "$1: names the floor" contains "$out" "$4"
  check "$1: says to fix forward" contains "$out" "fix forward"
  check "$1: no docker call" no_new_calls
  check "$1: record unchanged, nothing logged" eq "$(cat "$RECORD")$(new_history)" "$before_record"
}
at_floor "rollback after the contract deploy" rollback "nothing to roll back to above dev's rollback floor" "$FLOOR1"
at_floor "rollback <sha> to the release just before the floor" "rollback $F2" "$F2 is below dev's rollback floor" "$FLOOR1"
at_floor "rollback <sha> further back" "rollback $F1" "$F1 is below dev's rollback floor" "$FLOOR1"
at_floor "rollback <sha> with expect" "rollback $F2 expect $EC" "$F2 is below dev's rollback floor" "$FLOOR1"
ci "rollback $(sha 0xbad)"
check "a sha never deployed: still 'no known-good release'" contains "$out" "no known-good release of $(sha 0xbad) is recorded on dev"

echo "--- The floor is per environment"
prod "candidate $F2"
check "prod may still take a release from below dev's floor (promotion reads dev's log whole)" eq "$rc" 0
rb rollback
check "prod, without the contract migration, still rolls back to F1" eq "$rc $(pvalue tag) $(pvalue digest)" "0 $F1 $EF1"
prod "deploy $F2 $EF2"
check "and prod deploys F2, from below dev's floor, again" eq "$rc $(pvalue previous_tag)" "0 $F1"
mark
hmark "$PROD_HISTORY"
prod "deploy $C1 $EC"
check "prod's contract deploy succeeds" eq "$rc" 0
check "it sets prod's own floor" contains "$(new_history "$PROD_HISTORY" | first_line)" "env=prod action=floor outcome=set tag=$C1 digest=$EC"
check "prod record: no rollback target below it" eq "$(pvalue previous_tag)$(pvalue previous_digest)" ""
check "prod's deploy: no dev file in any docker call" not_contains "$(new_calls)" "/opt/focus/dev/"
check "dev's log still has its one floor line" eq "$(floor_lines "$HISTORY")" 1
check "pruning follows the floors: F1 and F2, below both, leave the host" \
  bash -c "! [ -e '$FAKE/local/$EF1' ] && ! [ -e '$FAKE/local/$EF2' ]"
check "with their tags" bash -c "! [ -e '$FAKE/tags/$F1' ] && ! [ -e '$FAKE/tags/$F2' ]"
check "C1 stays" on_host "$EC"
rb rollback
check "prod's rollback stops at prod's floor (status 1)" eq "$rc" 1
check "it says so" contains "$out" "nothing to roll back to above prod's rollback floor: every known-good release other than the current one ($C1) is below it"
rb "rollback $F2"
check "rollback <sha> below prod's floor: refused" contains "$out" "$F2 is below prod's rollback floor"
check "prod still runs C1" eq "$(pvalue tag) $(cat "$FAKE/running-prod")" "$C1 $EC"

echo "--- The floor survives a revert and later rollbacks"
echo up >"$FAKE/broken/$EZ"
mark
hmark
ci "deploy $Z $EZ"
check "a broken build after the floor: fails" eq "$rc" 1
check "it reverts to C1, the release at the floor" contains "$out" "reverted to $C1"
check "no new floor line: 0003 is recorded already" eq "$(new_history | grep -c ' action=floor ' || true)" 0
check "dev runs C1 again" eq "$(cat "$FAKE/running-dev")" "$EC"
at_floor "rollback after the revert" rollback "nothing to roll back to above dev's rollback floor" "$FLOOR1"
ci "deploy $G $EG"
check "a later release with the same contract revision deploys" eq "$rc" 0
check "its rollback target is C1, at the floor" eq "$(value previous_tag)" "$C1"
check "still one floor line in dev's log" eq "$(floor_lines "$HISTORY")" 1
ci rollback
check "rollback from it goes to C1" eq "$rc $(value tag) $(value digest)" "0 $C1 $EC"
check "and the next target is none: G is rolled back from, the rest below the floor" eq "$(value previous_tag)" ""
at_floor "a second rollback" rollback "nothing to roll back to above dev's rollback floor" "$FLOOR1"
at_floor "rollback <sha> below the floor after rollbacks" "rollback $F2" "$F2 is below dev's rollback floor" "$FLOOR1"

echo "--- A contract deploy that fails at start doesn't revert below its floor"
echo up >"$FAKE/broken/$EK"
mark
hmark
ci "deploy $K $EK"
calls=$(new_calls)
check "it fails (status 1)" eq "$rc" 1
check "the floor line was written first, with both contract revisions" \
  contains "$(new_history | first_line)" "action=floor outcome=set tag=$K digest=$EK previous_tag=- previous_digest=- infra=$D schema=0005 contracts=0003,0005"
check "then the failed deploy" contains "$(new_history | sed -n 2p)" "action=deploy outcome=failed tag=$K digest=$EK previous_tag=- previous_digest=- infra=$D step=start schema=0005"
check "it says C1 is below the new floor, so it isn't started again" \
  contains "$out" "$C1, the release that ran before, is below dev's rollback floor (contract migration 0003,0005 ran with the deploy of $K"
check "and that dev may run K unhealthy" contains "$out" "dev may be running $K unhealthy"
check "no revert line" not_contains "$(new_history)" "action=revert"
check "C1 isn't started again" not_contains "$(after "$calls" "app_tag=$K $start")" "app_tag=$C1 "
check "the record still names C1" eq "$(value tag)" "$C1"
FLOOR2="contract migration 0003,0005 ran with the deploy of $K at"
at_floor "rollback after it" rollback "nothing to roll back to above dev's rollback floor" "$FLOOR2"
ci "deploy $L $EL"
check "the fix-forward release deploys" eq "$rc" 0
check "no new floor line for it" eq "$(floor_lines "$HISTORY")" 2
check "its rollback target is none: C1, still the record's release, is below the floor" eq "$(value previous_tag)" ""
rm "$FAKE/broken/$EK" "$FAKE/broken/$EZ"

echo "--- A contract migration that fails still sets the floor (it may have run in part)"
touch "$FAKE/fail/migrate"
mark
hmark
ci "deploy $M $EM"
rm "$FAKE/fail/migrate"
check "it fails at migrate" contains "$out" "failed at 'migrate'"
check "after the floor line" eq "$(new_history | sed 's/^time=[^ ]* //' | cut -d' ' -f1-5)" \
  "env=dev action=floor outcome=set tag=$M digest=$EM"$'\n'"env=dev action=deploy outcome=failed tag=$M digest=$EM"
check "dev still runs L" eq "$(value tag) $(cat "$FAKE/running-dev")" "$L $EL"
FLOOR3="contract migration 0003,0005,0006 ran with the deploy of $M at"
at_floor "rollback after it" rollback "nothing to roll back to above dev's rollback floor" "$FLOOR3"
ci "deploy $M $EM"
check "the same release, once its migration works, deploys" eq "$rc" 0
check "without another floor line" eq "$(floor_lines "$HISTORY")" 3
check "its rollback target is none: L ran before the floor" eq "$(value previous_tag)" ""

pkill -f "sshd -p $SSH_PORT" || true
finish
