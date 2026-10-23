#!/usr/bin/env bash
# Runs in the `make test-server` container right after in_container.sh, on the server
# bootstrap.sh has just set up. Tests infra/server/install.sh and the forced command
# focus-ci (#28) behind the real, hardened sshd. A fake docker CLI (fake_docker.sh)
# stands in for Docker: it records every call and the environment variables it got.
#
#   installer   refuses non-root, malformed shas, commits not on main and trees with
#               symlinks; writes the full diff and installs nothing without a typed
#               "yes" on a terminal; installs root-owned files the deploy user can't
#               change; starts the edge; on a change, recreates Caddy and the collectors
#   refusals    anything but `deploy <sha> sha256:<digest>`, `rollback` or `status` is
#               refused with exit status 2 before any docker call (shells, scp, sftp,
#               injection, case, spacing, length, an unknown profile)
#   deploy      pull by digest, revision label check, migrate, then up, then the
#               running-image and /readyz checks; clean environment; the record
#   rollback    no migration; walks back through previous releases
#   failures    each failing step stops the deploy, keeps the record and logs it
#   lock        a deploy waits for /opt/focus/deploy.lock
set -euo pipefail

SRC=/src
FAKE=/tmp/fake-docker
SSH_PORT=2223
REPO=ghcr.io/ybenzine/ineedtofocus
RECORD=/opt/focus/dev/release
HISTORY=/opt/focus/dev/releases.log
# shellcheck source=/dev/null # lib.sh: check, eq, contains, not_contains, mode_owner, finish
. "$SRC/server/tests/lib.sh"

value() { sed -n "s/^$1=//p" "$RECORD"; }
mark() { mark=$(wc -l <"$FAKE/calls.log"); }
new_calls() { tail -n "+$((mark + 1))" "$FAKE/calls.log"; }
no_new_calls() { eq "$(new_calls)" ""; }
# line_of <text> <pattern>: number of the first line containing pattern (0 if none).
line_of() { grep -nF -- "$2" <<<"$1" | head -n1 | cut -d: -f1 || echo 0; }
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

echo "--- Setup: git, a fake docker, an upstream repo"
apt-get update -q >/dev/null
apt-get install -y -q --no-install-recommends git >/dev/null
mv /usr/bin/docker /usr/bin/docker.real
install -m 0755 "$SRC/server/tests/fake_docker.sh" /usr/bin/docker
install -d -m 1777 "$FAKE" "$FAKE/labels" "$FAKE/local" "$FAKE/tags" "$FAKE/fail"
install -m 0666 /dev/null "$FAKE/calls.log"

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
for who in dev unknown env; do
  ssh-keygen -q -t ed25519 -N '' -C "focus-ci-$who" -f "$keys/$who"
done
{
  echo "# test keys (focus_ci.sh)"
  printf 'restrict,command="/opt/focus/bin/focus-ci dev" %s\n' "$(cat "$keys/dev.pub")"
  printf 'restrict,command="/opt/focus/bin/focus-ci prod" %s\n' "$(cat "$keys/unknown.pub")"
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
  "rollback $S1"
  "rollback $S1 $D1"
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
check "checks the revision label" contains "$calls" "org.opencontainers.image.revision\" }} $REPO@$D1"
check "tags the digest :<sha> locally" contains "$calls" ":: tag $REPO@$D1 $REPO:$S1"
check "pull before migrate" before "$calls" ":: pull --quiet" "$migrate"
check "migrates with a one-shot container" contains "$calls" "$migrate"
check "migrate before up" before "$calls" "$migrate" "$start"
check "checks the running image after up" before "$calls" "$start" ":: inspect --format {{.Image}} container-app"
check "checks /readyz in the app" contains "$calls" "exec -T app python -c import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz'"
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
check "deploy output shows the record" contains "$out" "deployed_at="
ci status
check "status prints the record" eq "$out" "$(cat "$RECORD")"

ci "deploy $S2 $D2"
check "second deploy succeeds" eq "$rc" 0
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
ci rollback
check "a second rollback has nowhere further back to go (status 1)" eq "$rc" 1
check "record unchanged by it" eq "$(value tag) $(value action)" "$S1 rollback"

echo "--- Failing steps stop the deploy and keep the record"
deploy_fails() { # <description> <step> <sha> <digest> <must not appear>
  local desc=$1 step=$2 tag=$3 dig=$4 absent=$5 before_record
  before_record=$(cat "$RECORD")
  mark
  ci "deploy $tag $dig"
  check "$desc: fails (status 1)" eq "$rc" 1
  check "$desc: says at which step" contains "$out" "failed at '$step'"
  check "$desc: stops before $absent" not_contains "$(new_calls)" "$absent"
  check "$desc: record unchanged" eq "$(cat "$RECORD")" "$before_record"
  check "$desc: logged as failed" contains "$(last_history)" "action=deploy outcome=failed tag=$tag digest=$dig"
  check "$desc: logged step" contains "$(last_history)" "step=$step"
}
deploy_fails "image built from another commit" pull "$S2" "$D3" "alembic"
check "image built from another commit: says so" contains "$out" "was built from"
deploy_fails "digest not in the registry" pull "$S2" "$D4" "alembic"
touch "$FAKE/fail/migrate"
deploy_fails "failed migration" migrate "$S2" "$D2" " up -d"
rm "$FAKE/fail/migrate"
touch "$FAKE/fail/up"
deploy_fails "app doesn't turn healthy" start "$S2" "$D2" "readyz"
rm "$FAKE/fail/up"
touch "$FAKE/fail/verify"
deploy_fails "app runs another image" start "$S2" "$D2" "readyz"
check "app runs another image: says so" contains "$out" "the app runs image"
rm "$FAKE/fail/verify"
touch "$FAKE/fail/exec"
deploy_fails "/readyz doesn't answer" start "$S2" "$D2" "no such call"
rm "$FAKE/fail/exec"

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
first=$(new_calls | head -n1 | cut -d' ' -f1)
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
mark
install_typing yes "$D"
printf '%s\n' "$out" | sed 's/^/     | /'
check "second install succeeds once yes is typed" eq "$rc" 0
calls=$(new_calls)
check "REVISION updated" eq "$(cat /opt/focus/infra/REVISION)" "$D"
check "previous copy kept" eq "$(cat /opt/focus/infra.previous/REVISION)" "$A"
check "shows the commits since the installed revision" contains "$out" "changes to infra/ from $A to $D"
check "Caddyfile changed: Caddy recreated" contains "$calls" "compose.edge.yml up -d --wait --force-recreate caddy"
check "collector config changed: dev's collector recreated at dev's tag" \
  contains "$calls" "app_tag=$S2 :: $compose_args up -d --wait --no-deps --force-recreate otel-collector"
check "prod (nothing deployed) left alone" not_contains "$calls" "/opt/focus/prod/.env"
check "installer: clean environment" clean_env_only "$calls"
ci status
check "forced command still works after the reinstall" eq "$rc" 0
check "the record survives the reinstall" contains "$out" "tag=$S2"
install_at "$D"
check "reinstalling the same commit succeeds" eq "$rc" 0
check "reinstalling the same commit says so" contains "$out" "already installed"

pkill -f "sshd -p $SSH_PORT" || true
finish
