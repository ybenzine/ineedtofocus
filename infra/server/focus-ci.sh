#!/usr/bin/env bash
# Forced command for the CI deploy keys (#28; #29 and #30 extend it).
#
# infra/server/install.sh installs it, root-owned, as /opt/focus/bin/focus-ci. Every CI
# key is pinned to it in /etc/ssh/authorized_keys/deploy (root-owned). The key's line
# fixes the profile, which says what that key may do. The client can't choose it:
#
#   restrict,command="/opt/focus/bin/focus-ci dev" ssh-ed25519 AAAA... focus-ci-dev
#
# sshd runs this script whatever the client asks for. The client's request is only in
# $SSH_ORIGINAL_COMMAND, and must be exactly one of:
#
#   deploy <commit sha> sha256:<digest>
#       Pull ghcr.io/ybenzine/ineedtofocus@sha256:<digest> and check that it was built
#       from <commit sha> (its org.opencontainers.image.revision label). Then tag it
#       :<commit sha> locally, run the migrations as a one-shot container, start the
#       app (`up -d --wait`, which waits for the /healthz healthcheck), check that the
#       app runs exactly that image and that /readyz answers, and record the release.
#   rollback
#       Start the release that was current before this one again, by digest, without
#       migrating (migrations are expand-only). Then check it and record it.
#   status
#       Print the current release record.
#
# Profiles:
#   dev    deploy, rollback, status    on focus-dev
# #29 adds the prod deploy profile; #30 adds the prod rollback profile and the automatic
# revert when the checks fail. Add a profile in the `case` below, and keep each one to
# the verbs its key needs.
#
# Anything else is refused with exit status 2, before anything runs. That covers
# another verb, extra or malformed arguments, a shell, scp or sftp, and an unknown
# profile. Exit status 1 means an accepted request failed.
#
# Safety:
#   - Exact matches only: 40 lowercase hex for the commit, sha256: plus 64 lowercase hex
#     for the digest, in the C locale, so nothing the client sends is interpreted.
#   - Every docker and compose call gets a clean environment (env -i): PATH, HOME and,
#     for compose, APP_TAG. Variables from the SSH session can't override
#     infra/env/<env>.env (#92 review, finding 2).
#   - One deploy or rollback at a time on the host, across environments: everything
#     after validation runs under flock on /opt/focus/deploy.lock (finding 3). The
#     memory budget counts one migration container. install.sh takes the same lock.
#   - The release is recorded by digest, so a re-pushed tag can't change what a
#     rollback restores (finding 5).
#   - The compose files it runs are the root-owned copy in /opt/focus/infra (install.sh).
#     The deploy user can't change them, or this script.
#
# Records, in /opt/focus/<env>/ (owned by the deploy user, written only by this script):
#   release        the current release: key=value lines (what `status` prints)
#   releases.log   one line per deploy or rollback attempt, with its outcome
set -euo pipefail
set -f # no globbing anywhere: nothing here expands a pattern
export LC_ALL=C
umask 027

readonly FOCUS_ROOT=/opt/focus
readonly INFRA_DIR=$FOCUS_ROOT/infra
readonly LOCK_FILE=$FOCUS_ROOT/deploy.lock
readonly LOCK_WAIT_SECONDS=900
readonly WAIT_TIMEOUT_SECONDS=180
readonly IMAGE_REPO=ghcr.io/ybenzine/ineedtofocus
readonly CLEAN_PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly MAX_REQUEST_LENGTH=160
export PATH=$CLEAN_PATH

readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly DEPLOY_RE='^deploy ([0-9a-f]{40}) (sha256:[0-9a-f]{64})$'

profile=${1:-}
request=${SSH_ORIGINAL_COMMAND-}

log() { printf '==> %s\n' "$*"; }
audit() { logger -t focus-ci -- "profile=${profile:-none} $*" 2>/dev/null || true; }
refuse() {
  printf 'focus-ci: refused: %s\n' "$*" >&2
  audit "refused: $*"
  exit 2
}
fail() {
  printf 'focus-ci: FAILED: %s\n' "$*" >&2
  audit "failed: $*"
  exit 1
}

# --- What may this key do? ------------------------------------------------------------

(($# == 1)) || refuse "expected exactly one profile argument (from the key's command=)"
case $profile in
  dev)
    env_name=dev
    allowed=(deploy rollback status)
    ;;
  *) refuse "unknown profile $(printf '%q' "${profile:0:20}")" ;;
esac

# --- What is it asking for? -----------------------------------------------------------

shown=$(printf '%q' "${request:0:80}")
((${#request} <= MAX_REQUEST_LENGTH)) || refuse "request too long: $shown..."
tag="" digest=""
if [[ $request =~ $DEPLOY_RE ]]; then
  verb=deploy
  tag=${BASH_REMATCH[1]}
  digest=${BASH_REMATCH[2]}
elif [[ $request == rollback || $request == status ]]; then
  verb=$request
else
  refuse "not a request this key can make: $shown (expected: ${allowed[*]})"
fi
[[ " ${allowed[*]} " == *" $verb "* ]] || refuse "$verb isn't allowed for profile $profile"

# --- Paths and helpers ----------------------------------------------------------------

state_dir=$FOCUS_ROOT/$env_name
record=$state_dir/release
history=$state_dir/releases.log
home=$(getent passwd "$(id -u)" | cut -d: -f6)

# clean <command...>: run with nothing from this session's environment but PATH and HOME.
# The lock's descriptor isn't passed on, so no child can outlive the lock holding it.
clean() { env -i PATH="$CLEAN_PATH" HOME="$home" "$@" 9<&-; }
# compose <tag> <compose args...>: infra/compose.sh for this environment, APP_TAG only.
compose() {
  local app_tag=$1
  shift
  clean APP_TAG="$app_tag" "$INFRA_DIR/compose.sh" "$env_name" "$@"
}

# record_get <key>: a value from the current release record (never sourced).
record_get() {
  local line
  [[ -f $record ]] || return 0
  while IFS= read -r line; do
    if [[ $line == "$1="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$record"
}
# field <history line> <key>: one key=value field of a releases.log line.
field() {
  local word
  for word in $1; do
    if [[ $word == "$2="* ]]; then
      printf '%s' "${word#*=}"
      return 0
    fi
  done
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

take_lock() {
  [[ -f $LOCK_FILE ]] || fail "$LOCK_FILE is missing: run infra/server/install.sh (see _docs/deployment.md)"
  exec 9<"$LOCK_FILE"
  if ! flock -n 9; then
    log "waiting up to ${LOCK_WAIT_SECONDS}s for another deploy or rollback on this host to finish"
    flock -w "$LOCK_WAIT_SECONDS" 9 || fail "timed out after ${LOCK_WAIT_SECONDS}s waiting for $LOCK_FILE"
  fi
}

check_install() {
  [[ -x $INFRA_DIR/compose.sh && -r $INFRA_DIR/REVISION ]] ||
    fail "$INFRA_DIR isn't installed: run infra/server/install.sh (see _docs/deployment.md)"
  infra_revision=$(<"$INFRA_DIR/REVISION")
  [[ $infra_revision =~ $SHA_RE ]] || fail "$INFRA_DIR/REVISION isn't a commit sha"
  [[ -d $state_dir && -w $state_dir ]] || fail "$state_dir is missing or not writable (infra/server/bootstrap.sh)"
}

# --- Steps (each returns non-zero on failure; `step` records and stops) ------------------

# pull_image <tag> <digest>: the image by digest, built from <tag>, tagged :<tag> locally.
pull_image() {
  local ref=$IMAGE_REPO@$2 revision
  if clean docker image inspect "$ref" >/dev/null 2>&1; then
    log "$ref is already on this host"
  else
    clean docker pull --quiet "$ref" || return 1
  fi
  revision=$(clean docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ref") || return 1
  if [[ $revision != "$1" ]]; then
    printf 'focus-ci: %s was built from %q, not %s\n' "$ref" "$revision" "$1" >&2
    return 1
  fi
  clean docker tag "$ref" "$IMAGE_REPO:$1"
}

migrate() { compose "$1" run --rm --pull never app alembic upgrade head; }

# start_app <tag> <digest>: up -d --wait (the healthcheck is /healthz), then check that the
# app runs exactly this image and that /readyz (database) answers.
start_app() {
  local want container running
  compose "$1" up -d --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS" --pull never || return 1
  want=$(clean docker image inspect --format '{{.Id}}' "$IMAGE_REPO@$2") || return 1
  container=$(compose "$1" ps -q app) || return 1
  if [[ -z $container ]]; then
    echo "focus-ci: no app container is running" >&2
    return 1
  fi
  running=$(clean docker inspect --format '{{.Image}}' "$container") || return 1
  if [[ $running != "$want" ]]; then
    echo "focus-ci: the app runs image $running, expected $want" >&2
    return 1
  fi
  compose "$1" exec -T app python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=5)" ||
    return 1
  log "the app runs $IMAGE_REPO@$2 and /readyz answers"
}

# history_line <action> <outcome> [extra fields...], using $tag $digest $previous_*.
history_line() {
  local action=$1 outcome=$2
  shift 2
  printf 'time=%s env=%s action=%s outcome=%s tag=%s digest=%s previous_tag=%s previous_digest=%s infra=%s%s\n' \
    "$(now)" "$env_name" "$action" "$outcome" "$tag" "$digest" "${previous_tag:--}" \
    "${previous_digest:--}" "${infra_revision:--}" "${*:+ $*}" >>"$history"
}

# step <action> <name> <function> <args...>
step() {
  local action=$1 name=$2
  shift 2
  log "$action: $name"
  if ! "$@"; then
    history_line "$action" failed "step=$name"
    fail "$action of $tag failed at '$name'. The release record is unchanged (still $(record_get tag || true))"
  fi
}

write_record() { # <action>
  local tmp
  tmp=$(mktemp "$state_dir/.release.XXXXXX")
  {
    echo "env=$env_name"
    echo "tag=$tag"
    echo "digest=$digest"
    echo "image=$IMAGE_REPO@$digest"
    echo "action=$1"
    echo "deployed_at=$(now)"
    echo "previous_tag=$previous_tag"
    echo "previous_digest=$previous_digest"
    echo "infra_revision=$infra_revision"
  } >"$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$record"
  history_line "$1" ok
  log "recorded in $record:"
  sed 's/^/    /' "$record"
  audit "$1 ok tag=$tag digest=$digest"
}

# --- Verbs ----------------------------------------------------------------------------

do_status() {
  if [[ -f $record ]]; then
    cat "$record"
  else
    echo "focus-ci: no release recorded for $env_name yet" >&2
  fi
}

do_deploy() {
  take_lock
  check_install
  local current_tag current_digest
  current_tag=$(record_get tag)
  current_digest=$(record_get digest)
  if [[ $digest == "$current_digest" ]]; then
    # Redeploying what is already current keeps its rollback target.
    previous_tag=$(record_get previous_tag)
    previous_digest=$(record_get previous_digest)
  else
    previous_tag=$current_tag
    previous_digest=$current_digest
  fi
  audit "deploy tag=$tag digest=$digest"
  log "deploying $tag ($IMAGE_REPO@$digest) to $env_name, infra $infra_revision"
  step deploy pull pull_image "$tag" "$digest"
  step deploy migrate migrate "$tag"
  step deploy start start_app "$tag" "$digest"
  write_record deploy
}

do_rollback() {
  take_lock
  check_install
  tag=$(record_get previous_tag)
  digest=$(record_get previous_digest)
  if [[ -z $tag && -z $digest ]]; then
    fail "nothing to roll back to: $env_name has no previous release recorded"
  fi
  [[ $tag =~ $SHA_RE && $digest =~ $DIGEST_RE ]] || fail "the previous release in $record is malformed"
  # The target's own previous release becomes the next rollback target, so rolling back
  # again goes further back instead of returning to the release just left.
  local line found=""
  previous_tag="" previous_digest=""
  if [[ -f $history ]]; then
    while IFS= read -r line; do
      if [[ $(field "$line" outcome) == ok && $(field "$line" digest) == "$digest" ]]; then
        found=$line
      fi
    done <"$history"
  fi
  if [[ -n $found ]]; then
    previous_tag=$(field "$found" previous_tag)
    previous_digest=$(field "$found" previous_digest)
    [[ $previous_tag == - ]] && previous_tag=""
    [[ $previous_digest == - ]] && previous_digest=""
  fi
  audit "rollback to tag=$tag digest=$digest"
  log "rolling $env_name back from $(record_get tag) to $tag ($IMAGE_REPO@$digest), no migration"
  step rollback pull pull_image "$tag" "$digest"
  step rollback start start_app "$tag" "$digest"
  write_record rollback
}

cd /
case $verb in
  status) do_status ;;
  deploy) do_deploy ;;
  rollback) do_rollback ;;
esac
