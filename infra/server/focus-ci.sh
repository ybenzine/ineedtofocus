#!/usr/bin/env bash
# Forced command for the CI deploy keys (#28, #29, #30).
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
#       Note the current release (the one to go back to). Pull every other image of the
#       environment's project the host lacks (Postgres, the collector: pinned by tag and
#       digest in compose.prod.yml, #170), then pull
#       ghcr.io/ybenzine/ineedtofocus@sha256:<digest> and check that it was built from
#       <commit sha> (its org.opencontainers.image.revision label). Then tag it
#       :<commit sha> locally, run the migrations as a one-shot container, start the app
#       (`up -d --wait`, which waits for the /healthz healthcheck), check that the app runs
#       exactly that image and that /healthz and /readyz answer inside it, and record the
#       release. If the start or a check fails, it starts the release that ran before
#       again (the automatic revert: by its recorded digest, the same pulls, no
#       migration) and still fails, so the workflow goes red. After a success, prune
#       old app images (see Pruning).
#   rollback [<commit sha>] [expect sha256:<digest>]
#       Start a known-good release again, by its recorded digest, without migrating
#       (migrations are expand-only). With no sha: the newest known-good release other
#       than the current one. With a sha: the newest known-good release of that commit.
#       With `expect`: only if the current release is that digest, checked under the
#       lock (a guard against a deploy that ran in between; never a target). Then pull
#       what it needs like a deploy, start it, check it like a deploy and record it, and print a `result` line with what it left and
#       what runs now. The release it leaves is marked as rolled back from (revoked). On
#       dev, that also makes it not promotable to prod. After a success, prune old app
#       images (see Pruning).
#   status
#       Print the current release record.
#   candidate [<commit sha>]
#       Read-only, for the prod deploy (#29): print the tag and digest of the release
#       dev runs now or, with a sha, of the last promotable release of that commit dev
#       ran. It reads dev's records and nothing else: no docker call, no lock, no write.
#
# Known-good (#30). Each outcome=ok line of an environment's releases.log records a
# release (tag and digest) that ran there and passed every check: a deploy, a rollback or
# an automatic revert. A rollback's line also names the release it left (from_digest),
# which is then revoked until a later ok line for that digest. A known-good release is a
# release with an ok line that isn't revoked. Each one migrated this environment's
# database, or ran on it, and migrations are never undone and only ever add (AGENTS.md),
# so it runs on today's schema without migrating.
#
# Pruning (#117). After a successful deploy or rollback, still under the lock, focus-ci
# removes the ghcr.io/ybenzine/ineedtofocus images that neither environment may start
# again, whichever profile runs: each environment keeps its record's current and
# previous release and its newest KEEP_KNOWN_GOOD known-good releases. Older known-good
# releases stay rollback targets: a rollback to one pulls it again by its recorded
# digest. No other image is touched: the dependency images (Postgres, the collector,
# Caddy) stay, so a rollback never depends on Docker Hub. Pruning never fails the
# request, and whatever it can't read with certainty (a malformed log, an image whose
# references it can't read) keeps images rather than removing them.
#
# Profiles:
#   dev            deploy, rollback, status       on focus-dev
#   prod           deploy, status, candidate      on focus-prod. A prod deploy also needs
#                  dev to have run that exact sha and digest successfully, and not to
#                  have rolled back from it (dev's releases.log), checked under the lock:
#                  prod only gets bytes dev ran, which deploy-dev took from `publish`.
#                  The prod key can read dev's records but not change dev.
#   rollback-prod  rollback, status               on focus-prod, for the `rollback`
#                  environment's key (no reviewer, so on-call can use it). It can only
#                  start a known-good release from prod's own releases.log: no deploy, no
#                  migration, no digest chosen by the client.
# Every profile's deploy and rollback also prunes (see Pruning), and that crosses
# environments on purpose: it reads both environments' release and releases.log (the
# dev key reads prod's, the rollback key dev's) and removes app images neither keeps,
# whichever environment ran them. So the dev key can remove a prod release's image, but
# only one outside prod's window (current, previous, newest known-good), which a prod
# rollback would pull again by digest. No key can make pruning keep less: the window
# comes from the records, which only focus-ci writes. Nothing of the other
# environment's records reaches the client but the references of the images removed.
# Add a profile in the `case` below, and keep each one to the verbs its key needs.
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
#     after validation runs under flock on /opt/focus/deploy.lock (finding 3), the
#     automatic revert included. The memory budget counts one migration container.
#     install.sh takes the same lock.
#   - Releases are recorded and restored by digest, so a re-pushed tag can't change what
#     a rollback or a revert restores (finding 5). The host-wide :<sha> tag is re-pointed
#     at that digest right before `up`, and the running image is checked afterwards
#     (#110 review).
#   - Every other image (Postgres, the collector) is pinned by tag and digest in
#     compose.prod.yml, and pulled by that digest when the host lacks it, before any
#     `run` or `up` (#170). An image that isn't pinned is refused, never pulled by tag.
#     Compose itself never pulls (--pull never), so what starts is what was pulled.
#   - The compose files it runs are the root-owned copy in /opt/focus/infra (install.sh).
#     The deploy user can't change them, or this script.
#   - A deploy or rollback finishes even if the SSH client goes away (a cancelled job, a
#     lost runner): HUP and PIPE are ignored, and its output reaches the client through
#     forwarders that drop it once the client is gone, so no write can stop it between
#     `up` and the revert.
#   - releases.log is parsed strictly: a line with an empty, odd or repeated key stops
#     everything that reads the log with the line's number, rather than being read
#     loosely. A last line without a newline still counts.
#
# Records, in /opt/focus/<env>/ (owned by the deploy user, written only by this script):
#   release        the current release: key=value lines (what `status` prints)
#   releases.log   one line per deploy, rollback or revert attempt, with its outcome
set -euo pipefail
set -f # no globbing anywhere: nothing here expands a pattern
trap '' HUP PIPE # outlive the SSH session (see Safety)
export LC_ALL=C
umask 027

readonly FOCUS_ROOT=/opt/focus
readonly INFRA_DIR=$FOCUS_ROOT/infra
readonly LOCK_FILE=$FOCUS_ROOT/deploy.lock
readonly LOCK_WAIT_SECONDS=900
readonly WAIT_TIMEOUT_SECONDS=180
readonly CHECK_ATTEMPTS=3
readonly IMAGE_REPO=ghcr.io/ybenzine/ineedtofocus
readonly CLEAN_PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly MAX_REQUEST_LENGTH=160
# Image pruning (#117): per environment, the newest known-good releases whose app image
# stays on the host, on top of the record's current and previous release.
readonly KEEP_KNOWN_GOOD=5
export PATH=$CLEAN_PATH

readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly DEPLOY_RE='^deploy ([0-9a-f]{40}) (sha256:[0-9a-f]{64})$'
readonly ROLLBACK_RE='^rollback( ([0-9a-f]{40}))?( expect (sha256:[0-9a-f]{64}))?$'
readonly CANDIDATE_RE='^candidate( ([0-9a-f]{40}))?$'
# name:tag@sha256:<digest>, the form compose.prod.yml pins every image but the app's in
# (#170). The same pattern is in install.sh and scripts/check_prod_compose.py.
readonly PINNED_RE='^[a-z0-9]+([._/-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:[0-9a-f]{64}$'

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
warn() {
  printf 'focus-ci: warning: %s\n' "$*" >&2
  audit "warning: $*"
}

# --- What may this key do? ------------------------------------------------------------

(($# == 1)) || refuse "expected exactly one profile argument (from the key's command=)"
case $profile in
  dev)
    env_name=dev
    allowed=(deploy rollback status)
    promote_from="" # dev deploys what `publish` pushed
    ;;
  prod)
    env_name=prod
    allowed=(deploy status candidate)
    promote_from=dev # prod deploys only what dev ran (#29)
    ;;
  rollback-prod)
    env_name=prod
    allowed=(rollback status) # known-good releases from prod's own log only (#30)
    promote_from=""
    ;;
  *) refuse "unknown profile $(printf '%q' "${profile:0:20}")" ;;
esac

# --- What is it asking for? -----------------------------------------------------------

shown=$(printf '%q' "${request:0:80}")
((${#request} <= MAX_REQUEST_LENGTH)) || refuse "request too long: $shown..."
tag="" digest="" expect=""
if [[ $request =~ $DEPLOY_RE ]]; then
  verb=deploy
  tag=${BASH_REMATCH[1]}
  digest=${BASH_REMATCH[2]}
elif [[ $request =~ $ROLLBACK_RE ]]; then
  verb=rollback
  tag=${BASH_REMATCH[2]}
  expect=${BASH_REMATCH[4]}
elif [[ $request =~ $CANDIDATE_RE ]]; then
  verb=candidate
  tag=${BASH_REMATCH[2]}
elif [[ $request == status ]]; then
  verb=status
else
  refuse "not a request this key can make: $shown (expected: ${allowed[*]})"
fi
[[ " ${allowed[*]} " == *" $verb "* ]] || refuse "$verb isn't allowed for profile $profile"

# --- Paths and helpers ----------------------------------------------------------------

state_dir=$FOCUS_ROOT/$env_name
record=$state_dir/release
history=$state_dir/releases.log
home=$(getent passwd "$(id -u)" | cut -d: -f6)

# clean <command...>: run with nothing from this session's environment but PATH and HOME,
# and no stdin from the session. The lock's descriptor isn't passed on, so no child can
# outlive the lock holding it.
clean() { env -i PATH="$CLEAN_PATH" HOME="$home" "$@" </dev/null 9<&-; }

# forward <fd>: copy lines to <fd> (the SSH client's stdout or stderr), and keep reading
# when the client is gone, so writers never see a closed pipe.
forward() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    { printf '%s\n' "$line" >&"$1"; } 2>/dev/null || true
  done
}
# detach_output: from here on, stdout and stderr go through forwarders. Called before
# the lock is taken, so they don't hold it.
detach_output() {
  exec 3>&1 4>&2
  exec 1> >(forward 3) 2> >(forward 4)
  exec 3>&- 4>&-
}
# compose <tag> <compose args...>: infra/compose.sh for this environment, APP_TAG only.
compose() {
  local app_tag=$1
  shift
  clean APP_TAG="$app_tag" "$INFRA_DIR/compose.sh" "$env_name" "$@"
}

# record_get <key> [record file]: a value from a release record (never sourced); the
# current environment's unless another file is given.
record_get() {
  local line file=${2:-$record}
  [[ -f $file ]] || return 0
  while IFS= read -r line; do
    if [[ $line == "$1="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$file"
}

# parse_line <releases.log line>: its key=value words, into the associative array `f`.
# Returns 1, with the reason in $bad, for a word that isn't <lowercase key>=<value> or a
# key that appears twice: focus-ci never writes either, so such a line isn't trusted.
declare -A f=()
bad=""
parse_line() {
  local word key
  f=() bad=""
  for word in $1; do
    if [[ ! $word =~ ^[a-z_]+= ]]; then
      bad="$(printf '%q' "${word:0:40}") isn't key=value"
      return 1
    fi
    key=${word%%=*}
    if [[ -n ${f[$key]+set} ]]; then
      bad="$key appears twice"
      return 1
    fi
    f[$key]=${word#*=}
  done
  return 0
}

# load_history <releases.log>: the releases that ran there and passed the checks, oldest
# first (ok_tags, ok_digests, ok_lines), and the digests rolled back from since their
# last ok line (revoked). See "Known-good" at the top. Returns 1, with the reason in
# $history_error, for a malformed line: callers fail on it (read_history), except the
# image pruning, which then keeps every image instead.
declare -A revoked=()
ok_tags=() ok_digests=() ok_lines=()
history_error=""
load_history() {
  local line number=0
  ok_tags=() ok_digests=() ok_lines=() revoked=() history_error=""
  [[ -f $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    number=$((number + 1))
    [[ -n $line ]] || continue
    if ! parse_line "$line"; then
      history_error="$1 line $number is malformed ($bad): nothing that reads that log runs until it's fixed (see _docs/deployment.md, The release record)"
      return 1
    fi
    [[ ${f[outcome]-} == ok && ${f[tag]-} =~ $SHA_RE && ${f[digest]-} =~ $DIGEST_RE ]] || continue
    if [[ ${f[action]-} == rollback && ${f[from_digest]-} =~ $DIGEST_RE ]]; then
      revoked[${f[from_digest]}]=1
    fi
    unset "revoked[${f[digest]}]"
    ok_tags+=("${f[tag]}")
    ok_digests+=("${f[digest]}")
    ok_lines+=("$line")
  done <"$1"
}
# read_history <releases.log>: load_history, or stop with its reason.
read_history() { load_history "$1" || fail "${history_error:-cannot read $1}"; }

# known_good <tag or ""> [digests to skip...]: from the loaded history, the newest
# known-good release (of <tag>, when given) whose digest isn't one of those skipped, as
# "<tag> <digest>"; or nothing. keep_release_images (pruning) walks the same list: a
# change to what counts as known-good (a rollback floor, #165) applies to both.
known_good() {
  local want=$1 i d skip
  shift
  for ((i = ${#ok_digests[@]} - 1; i >= 0; i--)); do
    d=${ok_digests[i]}
    [[ -z ${revoked[$d]-} ]] || continue
    [[ -z $want || ${ok_tags[i]} == "$want" ]] || continue
    for skip in "$@"; do
      [[ $d != "$skip" ]] || continue 2
    done
    printf '%s %s' "${ok_tags[i]}" "$d"
    return 0
  done
}

# is_known_good <tag> <digest>: that exact release is known-good in the loaded history.
is_known_good() {
  local i
  [[ -z ${revoked[$2]-} ]] || return 1
  for ((i = 0; i < ${#ok_digests[@]}; i++)); do
    [[ ${ok_tags[i]} == "$1" && ${ok_digests[i]} == "$2" ]] && return 0
  done
  return 1
}

# ran_tag <tag>: the loaded history has an ok line for <tag>, known-good or not.
ran_tag() {
  local t
  for t in "${ok_tags[@]}"; do
    [[ $t != "$1" ]] || return 0
  done
  return 1
}

# last_ok_line <tag> <digest>: the loaded history's newest ok line for that release.
last_ok_line() {
  local i
  for ((i = ${#ok_digests[@]} - 1; i >= 0; i--)); do
    if [[ ${ok_tags[i]} == "$1" && ${ok_digests[i]} == "$2" ]]; then
      printf '%s' "${ok_lines[i]}"
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

# promoted <tag> <digest>: the source environment ran exactly this release successfully
# and hasn't rolled back from it since.
promoted() {
  read_history "$FOCUS_ROOT/$promote_from/releases.log"
  is_known_good "$1" "$2" && return 0
  if [[ -n ${revoked[$2]-} ]]; then
    printf 'focus-ci: %s rolled back from %s %s, so it is not promotable: deploy a release %s runs or ran without rolling back\n' \
      "$promote_from" "$1" "$2" "$promote_from" >&2
  else
    printf 'focus-ci: %s ran no release %s %s successfully: deploy it to %s first\n' \
      "$promote_from" "$1" "$2" "$promote_from" >&2
  fi
  return 1
}

# pull_image <tag> <digest>: the image by digest, built from <tag>, tagged :<tag> locally.
# The local :<tag> is shared by every environment on the host and moved by their deploys,
# so it's never trusted: it's re-pointed at <digest> here, under the lock, right before
# `up`, and start_app checks the running container's image afterwards (#110 review).
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

# pull_dependencies <tag>: every image of this environment's project but the app's
# (Postgres, the collector), as compose.prod.yml pins it (name:tag@sha256:<digest>), on
# this host: pulled by that digest when it's missing (#170). Compose runs with --pull
# never, so without this a missing image (a first deploy, a version bump, a pruned
# image) would fail `migrate` or `up`. An image that isn't pinned is refused: pulling it
# by tag could change what runs under a deploy.
pull_dependencies() {
  local images ref
  images=$(compose "$1" config --images) || return 1
  while IFS= read -r ref; do
    [[ -n $ref && $ref != "$IMAGE_REPO:$1" ]] || continue
    if [[ ! $ref =~ $PINNED_RE ]]; then
      printf 'focus-ci: the image %q in %s/compose.prod.yml is not pinned by tag and digest (name:tag@sha256:<digest>), so it is not pulled\n' \
        "${ref:0:120}" "$INFRA_DIR" >&2
      return 1
    fi
    if clean docker image inspect "$ref" >/dev/null 2>&1; then
      log "$ref is already on this host"
    elif clean docker pull --quiet "$ref"; then
      log "pulled $ref"
    else
      printf 'focus-ci: could not pull %s, which focus-%s needs\n' "$ref" "$env_name" >&2
      return 1
    fi
  done <<<"$images"
}

# pull_release <tag> <digest>: everything a start of that release needs, on this host and
# checked, before anything is migrated or started: the other images, then the app's.
pull_release() { pull_dependencies "$1" && pull_image "$1" "$2"; }

migrate() { compose "$1" run --rm --pull never app alembic upgrade head; }

# check_endpoint <tag> <path>: GET http://127.0.0.1:8000<path> inside the app container
# answers 2xx, retried a few times.
check_endpoint() {
  local attempt
  for ((attempt = 1; attempt <= CHECK_ATTEMPTS; attempt++)); do
    if compose "$1" exec -T app python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000$2', timeout=5)"; then
      return 0
    fi
    ((attempt == CHECK_ATTEMPTS)) || sleep 2
  done
  echo "focus-ci: $2 doesn't answer inside the app container" >&2
  return 1
}

# start_app <tag> <digest>: up -d --wait (the healthcheck is /healthz), then check that the
# app runs exactly this image and that /healthz and /readyz (database) answer.
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
  check_endpoint "$1" /healthz || return 1
  check_endpoint "$1" /readyz || return 1
  log "the app runs $IMAGE_REPO@$2 and /healthz and /readyz answer"
}

# history_line <action> <outcome> [extra fields...], using $tag $digest $previous_*.
history_line() {
  local action=$1 outcome=$2
  shift 2
  end_history_line
  printf 'time=%s env=%s action=%s outcome=%s tag=%s digest=%s previous_tag=%s previous_digest=%s infra=%s%s\n' \
    "$(now)" "$env_name" "$action" "$outcome" "$tag" "$digest" "${previous_tag:--}" \
    "${previous_digest:--}" "${infra_revision:--}" "${*:+ $*}" >>"$history"
}
# A log whose last line has no newline (edited by hand) gets one first, so the next line
# isn't glued onto it.
end_history_line() {
  if [[ -s $history && -n $(tail -c 1 "$history") ]]; then
    echo >>"$history"
  fi
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

# start_or_revert <action> <tag to go back to> <its digest>: the start step of a deploy or
# rollback. If it fails, the app may run the new release unhealthy, so start the release
# that ran before again: by its digest, re-tagged under the lock, no migration, the same
# checks. Then fail either way: the action didn't happen, and the record is unchanged.
start_or_revert() {
  local action=$1 back_tag=$2 back_digest=$3
  local new_tag=$tag new_digest=$digest
  log "$action: start"
  start_app "$tag" "$digest" && return 0
  history_line "$action" failed step=start
  if [[ -z $back_tag ]]; then
    fail "$action of $new_tag failed at 'start', and $env_name had no release before it to go back to: it may be running $new_tag unhealthy"
  fi
  if [[ $back_digest == "$new_digest" ]]; then
    fail "$action of $new_tag failed at 'start'. It was already the current release, so there is nothing else to go back to: roll back to a known-good release (_docs/runbooks/rollback.md)"
  fi
  tag=$back_tag digest=$back_digest
  previous_tag=$(record_get previous_tag) previous_digest=$(record_get previous_digest)
  audit "revert to tag=$tag digest=$digest after failed $action of tag=$new_tag digest=$new_digest"
  log "revert: $new_tag failed its checks; starting $tag ($IMAGE_REPO@$digest) again, no migration"
  if pull_release "$tag" "$digest" && start_app "$tag" "$digest"; then
    history_line revert ok "failed_action=$action" "failed_tag=$new_tag" "failed_digest=$new_digest"
    fail "$action of $new_tag failed at 'start' (its checks failed): reverted to $tag, which runs again and passes the checks. The release record is unchanged"
  fi
  history_line revert failed "failed_action=$action" "failed_tag=$new_tag" "failed_digest=$new_digest"
  fail "$action of $new_tag failed at 'start', and reverting to $tag failed too: $env_name may be down (_docs/runbooks/rollback.md)"
}

write_record() { # <action> [extra fields for the history line...]
  local tmp action=$1
  shift
  tmp=$(mktemp "$state_dir/.release.XXXXXX")
  {
    echo "env=$env_name"
    echo "tag=$tag"
    echo "digest=$digest"
    echo "image=$IMAGE_REPO@$digest"
    echo "action=$action"
    echo "deployed_at=$(now)"
    echo "previous_tag=$previous_tag"
    echo "previous_digest=$previous_digest"
    echo "infra_revision=$infra_revision"
  } >"$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$record"
  history_line "$action" ok "$@"
  log "recorded in $record:"
  sed 's/^/    /' "$record"
  audit "$action ok tag=$tag digest=$digest"
}

# --- Image pruning (#117) ---------------------------------------------------------------

# keep_release_images <env>: add to keep_digests the app images <env> may start again:
# its record's digest and previous_digest (the next rollback target), and its newest
# KEEP_KNOWN_GOOD known-good releases (the rollbacks after that). Returns 1, with the
# reason in $prune_error, when that can't be read with certainty.
declare -A keep_digests=()
prune_error=""
keep_release_images() {
  local dir=$FOCUS_ROOT/$1 key value i d n=0
  local -A counted=()
  if [[ ! -d $dir || ! -x $dir ]]; then
    prune_error="can't read $dir"
    return 1
  fi
  if [[ -e $dir/release ]]; then
    if [[ ! -r $dir/release ]]; then
      prune_error="can't read $dir/release"
      return 1
    fi
    for key in digest previous_digest; do
      value=$(record_get "$key" "$dir/release")
      if [[ -n $value && ! $value =~ $DIGEST_RE ]]; then
        prune_error="$dir/release has a malformed $key"
        return 1
      fi
      [[ -z $value ]] || keep_digests[$value]=1
    done
  fi
  if [[ -e $dir/releases.log && ! -r $dir/releases.log ]]; then
    prune_error="can't read $dir/releases.log"
    return 1
  fi
  if ! load_history "$dir/releases.log"; then
    prune_error=${history_error:-cannot read $dir/releases.log}
    return 1
  fi
  for ((i = ${#ok_digests[@]} - 1; i >= 0 && n < KEEP_KNOWN_GOOD; i--)); do
    d=${ok_digests[i]}
    [[ -z ${revoked[$d]-} && -z ${counted[$d]-} ]] || continue
    counted[$d]=1
    keep_digests[$d]=1
    n=$((n + 1))
  done
}

# app_refs <image id>: that image's IMAGE_REPO references (<repo>:<tag>, <repo>@<digest>),
# one per line. Fails when they can't be read, or the image is gone.
app_refs() {
  local out ref
  out=$(clean docker image inspect --format \
    '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' "$1") || return 1
  while IFS= read -r ref; do
    case $ref in
      "$IMAGE_REPO@"* | "$IMAGE_REPO:"*) printf '%s\n' "$ref" ;;
    esac
  done <<<"$out"
}

# prune_images: after a successful deploy or rollback, still under the lock, remove the
# IMAGE_REPO images that no environment may start again (keep_release_images, for prod
# and dev, whichever profile runs), so each deploy's new image doesn't fill the disk.
# Only IMAGE_REPO's references are removed, never another repository's: the pinned
# dependency images (Postgres, the collector, Caddy) are never touched, nor an image
# that also carries another name. Never forced, so an image a container uses stays. An
# image is removed only when its references were read and name no kept digest. It
# never fails the request: a problem is a warning, and an image in doubt is kept.
#
# Removing an image's last tag can delete it before its digest reference is reached
# (Docker's classic image store does), and `image rm` then fails on that reference. So
# success is judged by what's left: no IMAGE_REPO reference on that image any more.
prune_images() {
  local env listing repo id refs_out ref keep left rm_errors removed=0 kept=0
  local -a refs
  local -A seen=()
  keep_digests=()
  for env in prod dev; do
    if ! keep_release_images "$env"; then
      warn "not pruning old images: $prune_error"
      return 0
    fi
  done
  if ! listing=$(clean docker image ls --no-trunc --format '{{.Repository}} {{.ID}}'); then
    warn "not pruning old images: docker image ls failed"
    return 0
  fi
  while read -r repo id; do
    [[ $repo == "$IMAGE_REPO" && -n $id && -z ${seen[$id]-} ]] || continue
    seen[$id]=1
    if ! refs_out=$(app_refs "$id"); then
      warn "kept image $id: can't read its references"
      kept=$((kept + 1))
      continue
    fi
    refs=() keep=0
    while IFS= read -r ref; do
      [[ -n $ref ]] || continue
      refs+=("$ref")
      if [[ $ref == "$IMAGE_REPO@"* && -n ${keep_digests[${ref#*@}]-} ]]; then
        keep=1
      fi
    done <<<"$refs_out"
    if ((keep || ${#refs[@]} == 0)); then
      kept=$((kept + 1))
      continue
    fi
    rm_errors=$(clean docker image rm "${refs[@]}" 2>&1 >/dev/null) || true
    # The image is gone ("No such image", not shown), or has no app reference left.
    if left=$(app_refs "$id" 2>/dev/null) && [[ -n $left ]]; then
      rm_errors=${rm_errors//$'\n'/; }
      warn "kept ${refs[*]}: docker couldn't remove it${rm_errors:+ ($rm_errors)}"
      kept=$((kept + 1))
    else
      removed=$((removed + 1))
      log "pruned ${refs[*]}"
    fi
  done <<<"$listing"
  log "pruned $removed old $IMAGE_REPO image(s); $kept kept for prod and dev (current, previous and up to $KEEP_KNOWN_GOOD known-good releases each)"
  audit "pruned removed=$removed kept=$kept"
}

# --- Verbs ----------------------------------------------------------------------------

do_status() {
  if [[ -f $record ]]; then
    cat "$record"
  else
    echo "focus-ci: no release recorded for $env_name yet" >&2
  fi
}

# candidate [<sha>]: what a prod deploy may take from dev, read-only.
do_candidate() {
  local source_record=$FOCUS_ROOT/$promote_from/release found line
  read_history "$FOCUS_ROOT/$promote_from/releases.log"
  if [[ -z $tag ]]; then
    tag=$(record_get tag "$source_record")
    digest=$(record_get digest "$source_record")
    [[ -n $tag ]] || fail "$promote_from has no release recorded yet"
    [[ $tag =~ $SHA_RE && $digest =~ $DIGEST_RE ]] || fail "$promote_from's release record is malformed"
    is_known_good "$tag" "$digest" ||
      fail "$promote_from's current release $tag $digest has no promotable ok line in its releases.log"
  else
    found=$(known_good "$tag")
    if [[ -z $found ]]; then
      ran_tag "$tag" &&
        fail "$promote_from rolled back from every release of $tag it ran, so none is promotable"
      fail "$promote_from ran no release of $tag successfully: deploy it to $promote_from first"
    fi
    digest=${found#* }
  fi
  line=$(last_ok_line "$tag" "$digest")
  parse_line "$line"
  echo "source=$promote_from"
  echo "tag=$tag"
  echo "digest=$digest"
  echo "source_time=${f[time]-}"
  echo "source_action=${f[action]-}"
}

do_deploy() {
  detach_output
  take_lock
  check_install
  local current_tag current_digest
  current_tag=$(record_get tag)
  current_digest=$(record_get digest)
  [[ -z $current_tag || ($current_tag =~ $SHA_RE && $current_digest =~ $DIGEST_RE) ]] ||
    fail "the release record $record is malformed"
  # The rollback target once this release is current: the newest known-good release
  # other than this one (normally the current release).
  read_history "$history"
  read -r previous_tag previous_digest <<<"$(known_good "" "$digest")"
  if [[ -z $previous_tag && -n $current_tag && $current_digest != "$digest" ]]; then
    previous_tag=$current_tag previous_digest=$current_digest
  fi
  audit "deploy tag=$tag digest=$digest"
  log "deploying $tag ($IMAGE_REPO@$digest) to $env_name, infra $infra_revision; current: ${current_tag:-none}"
  if [[ -n $promote_from ]]; then
    step deploy promote promoted "$tag" "$digest"
  fi
  step deploy pull pull_release "$tag" "$digest"
  step deploy migrate migrate "$tag"
  start_or_revert deploy "$current_tag" "$current_digest"
  write_record deploy
  prune_images || warn "pruning old images failed"
}

do_rollback() {
  detach_output
  take_lock
  check_install
  local from_tag from_digest found want=$tag
  from_tag=$(record_get tag)
  from_digest=$(record_get digest)
  [[ -n $from_tag ]] || fail "nothing to roll back to: $env_name has no release recorded"
  [[ $from_tag =~ $SHA_RE && $from_digest =~ $DIGEST_RE ]] || fail "the release record $record is malformed"
  if [[ -n $expect && $expect != "$from_digest" ]]; then
    fail "$env_name runs $from_tag ($from_digest) now, not the expected $expect: a deploy or rollback ran in between. Nothing changed; check what runs and start again"
  fi
  read_history "$history"
  found=$(known_good "$want" "$from_digest")
  if [[ -z $found && -n $want ]]; then
    fail "no known-good release of $want is recorded on $env_name: it must have passed the checks here, not be the current release and not have been rolled back from (see status and _docs/deployment.md)"
  fi
  [[ -n $found ]] || fail "nothing to roll back to: $env_name has no known-good release recorded other than the current one ($from_tag)"
  read -r tag digest <<<"$found"
  # The next rollback target: the newest known-good release other than this one and the
  # one left, which this rollback revokes. Rolling back again goes further back.
  read -r previous_tag previous_digest <<<"$(known_good "" "$digest" "$from_digest")"
  audit "rollback from tag=$from_tag digest=$from_digest to tag=$tag digest=$digest"
  log "rolling $env_name back from $from_tag to $tag ($IMAGE_REPO@$digest), no migration"
  step rollback pull pull_release "$tag" "$digest"
  start_or_revert rollback "$from_tag" "$from_digest"
  write_record rollback "from_tag=$from_tag" "from_digest=$from_digest"
  echo "result from_tag=$from_tag from_digest=$from_digest tag=$tag digest=$digest"
  if [[ $env_name == dev ]]; then
    log "$from_tag ($from_digest) is marked as rolled back from: prod won't take it from dev"
  fi
  prune_images || warn "pruning old images failed"
}

cd /
case $verb in
  status) do_status ;;
  deploy) do_deploy ;;
  rollback) do_rollback ;;
  candidate) do_candidate ;;
esac
