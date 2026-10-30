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
#       Note the current release (the one to go back to). Check the digest's build
#       provenance (see Build provenance): nothing is pulled for a digest ci.yml on main
#       didn't attest as built from <commit sha>. Pull every other image of the
#       environment's project the host lacks (Postgres, the collector: pinned by tag and
#       digest in compose.prod.yml, #170), then pull
#       ghcr.io/ybenzine/ineedtofocus@sha256:<digest> and check that it was built from
#       <commit sha> (its org.opencontainers.image.revision label). Then tag it
#       :<commit sha> locally, read its schema (see Rollback floor), run the migrations
#       as a one-shot container, start the app (`up -d --wait`, which waits for the
#       /healthz healthcheck), check that the app runs exactly that image and that
#       /healthz and /readyz answer inside it, and record the release. If the start or a
#       check fails, it starts the release that ran before again (the automatic revert:
#       by its recorded digest, the same pulls, no migration; never a release below the
#       rollback floor) and still fails, so the workflow goes red. After a success,
#       prune old app images (see Pruning).
#   rollback [<commit sha>] [expect sha256:<digest>]
#       Start a known-good release again, by its recorded digest, without migrating
#       (migrations are expand-only), never one below the rollback floor (see Rollback
#       floor). With no sha: the newest known-good release other than the current one.
#       With a sha: the newest known-good release of that commit.
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
# so it runs on today's schema without migrating. Only known-good releases at or above
# the rollback floor are rollback targets; promotion to prod (`candidate`, `promote`)
# reads dev's known-good releases whatever dev's floor, since prod's schema is prod's.
#
# Build provenance (#177). A deploy, under the lock and before any pull, runs the pinned
# cosign (/opt/focus/sigstore/cosign, root-owned, installed by bootstrap.sh) on the digest:
# `cosign verify-attestation` reads the attestation `publish` pushed next to the image in
# GHCR and checks it offline against the pinned Sigstore trusted root
# (/opt/focus/sigstore/trusted_root.json, root-owned too): no TUF, Rekor or GitHub API
# call and no token. It passes only for a SLSA provenance statement about exactly that
# digest, signed with a certificate GitHub's OIDC issuer got for
# .github/workflows/ci.yml on refs/heads/main of ybenzine/ineedtofocus, for a push, at
# the requested commit (SIGNER_* below). Anything else (no attestation, another commit,
# another workflow, ref or repository, a tool that fails or times out, a verifier or
# trusted root that is missing or not root's) stops the deploy at step=provenance before
# any docker call, with nothing changed. This binds whatever the workflows run: their
# own `gh attestation verify` steps are early warnings. rollback, candidate and the
# automatic revert don't verify and need no network for it: they only restore digests
# recorded with an ok line, which passed this check when they were deployed.
#
# Rollback floor (#165). A contract migration (a migration file with a
# `# contract-migration: <reason>` comment, which test_migration_safety.py lets remove
# things) breaks the expand-only promise for the releases from before it. So before
# migrating, a deploy reads the release's schema from its own image: infra/app/
# migration_info.py, fed to a one-shot app container (`run --no-deps`, no database),
# prints its alembic head and its contract revisions. Every deploy line then records
# schema=<head>. When the release brings a contract revision this environment's log
# hasn't recorded, focus-ci first writes a floor line (action=floor outcome=set ...
# contracts=<all of the release's contract revisions>), before the migration runs, so
# it holds even if the migration fails half-way. Known-good counts only the ok lines
# after the environment's newest floor line: `rollback`, `rollback <sha>`, the record's
# previous_tag, the automatic revert and pruning never reach below it. Each environment
# has its own floor, set when its own deploy runs the contract migration.
#
# Pruning (#117). After a successful deploy or rollback, still under the lock, focus-ci
# removes the ghcr.io/ybenzine/ineedtofocus images that neither environment may start
# again, whichever profile runs: each environment keeps its record's current and
# previous release and its newest KEEP_KNOWN_GOOD known-good releases at or above its
# rollback floor (#165), like rollback. Older known-good releases stay rollback targets:
# a rollback to one pulls it again by its recorded digest. No other image is touched:
# the dependency images (Postgres, the collector, Caddy) stay, so a rollback never
# depends on Docker Hub. Pruning never fails the request, and whatever it can't read
# with certainty (a malformed log, an image whose references it can't read) keeps
# images rather than removing them.
# What pruning prints, whichever environment it concerns (#186). To the client only
# (log, stdout): a `pruned <refs>` line with the references (<repo>:<sha>,
# <repo>@<digest>) of each image it removed, and a summary of how many it removed and
# kept. To the client and syslog (warn): the references of each image it meant to
# remove but docker refused, with docker's own error (which can name the container
# using it); the ID of an image whose references it couldn't read; and, when it doesn't
# prune, why: an unreadable directory or file by its path, a malformed record by its
# path and key (not the value), a malformed releases.log by its path and line number
# only, never what the line holds, or `docker image ls failed`. To syslog only (audit):
# `pruned removed=<n> kept=<n>`. Docker's own error output from `image ls` and `image
# inspect` also reaches the client. The images it keeps on purpose (some environment's
# window) are only counted, never named. (A deploy, rollback or `candidate` that reads
# a malformed log shows up to 40 characters of the bad word: those read only logs their
# key may read anyway, dev's included for the prod key. Pruning reads the other
# environment's log whichever key runs.)
#
# Profiles:
#   dev            deploy, rollback, status       on focus-dev
#   prod           deploy, status, candidate      on focus-prod. A prod deploy also needs
#                  dev to have run that exact sha and digest successfully, and not to
#                  have rolled back from it (dev's releases.log), checked under the lock:
#                  prod only gets bytes dev ran. Its own provenance check then holds
#                  even if dev ran bytes `publish` didn't attest.
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
# comes from the records, which only focus-ci writes. Of the other environment's
# records, the client sees only what Pruning lists above: image references and IDs
# (shas and digests), counts, and where a record or log is malformed, never its content.
# Add a profile in the `case` below, and keep each one to the verbs its key needs.
#
# Anything else is refused with exit status 2, before anything runs. That covers
# another verb, extra or malformed arguments, a shell, scp or sftp, and an unknown
# profile. Exit status 1 means an accepted request failed.
#
# Safety:
#   - Exact matches only: 40 lowercase hex for the commit, sha256: plus 64 lowercase hex
#     for the digest, in the C locale, so nothing the client sends is interpreted.
#   - Every docker, compose and cosign call gets a clean environment (env -i): PATH,
#     HOME and, for compose, APP_TAG. Variables from the SSH session can't override
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
#   releases.log   one line per deploy, rollback or revert attempt, with its outcome,
#                  and a floor line before each contract migration (see Rollback floor)
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
# Rollback floor (#165): reads a release's schema from its own image (see the header).
readonly MIGRATION_INFO=$INFRA_DIR/app/migration_info.py
# Build provenance (#177): the verifier and trust material bootstrap.sh pins, and the one
# signer a deploy accepts. The identity is the certificate's SAN: the signing workflow
# (a reusable workflow would be its own file), its repository and ref.
readonly SIGSTORE_DIR=$FOCUS_ROOT/sigstore
readonly COSIGN=$SIGSTORE_DIR/cosign
readonly TRUSTED_ROOT=$SIGSTORE_DIR/trusted_root.json
readonly PROVENANCE_TIMEOUT_SECONDS=120
readonly SIGNER_REPOSITORY=ybenzine/ineedtofocus
readonly SIGNER_REF=refs/heads/main
readonly SIGNER_IDENTITY=https://github.com/$SIGNER_REPOSITORY/.github/workflows/ci.yml@$SIGNER_REF
readonly SIGNER_ISSUER=https://token.actions.githubusercontent.com
export PATH=$CLEAN_PATH

readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly DEPLOY_RE='^deploy ([0-9a-f]{40}) (sha256:[0-9a-f]{64})$'
readonly ROLLBACK_RE='^rollback( ([0-9a-f]{40}))?( expect (sha256:[0-9a-f]{64}))?$'
readonly CANDIDATE_RE='^candidate( ([0-9a-f]{40}))?$'
# name:tag@sha256:<digest>, the form compose.prod.yml pins every image but the app's in
# (#170). The same pattern is in install.sh and scripts/check_prod_compose.py.
readonly PINNED_RE='^[a-z0-9]+([._/-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:[0-9a-f]{64}$'
# An alembic revision id, and a release's contract revisions (#165): one word each, so
# they fit a releases.log line. The same rule is REVISION in infra/app/migration_info.py.
readonly REVISION_RE='^[A-Za-z0-9_]{1,64}$'
readonly CONTRACTS_RE='^(-|[A-Za-z0-9_]{1,64}(,[A-Za-z0-9_]{1,64}){0,99})$'

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
# $history_error and the line's number in $history_bad_line, for a malformed line:
# callers fail on it (read_history), except the image pruning, which then keeps every
# image instead.
#
# Its newest floor line (#165) sets floor_start, the index in ok_* of the first ok line
# after it (0 without one), and floor_note, which names it for messages. Every floor
# line's contract revisions go into `floored`. A floor line counts whatever else it
# holds: it only ever retires releases, so reading it loosely can't widen anything.
declare -A revoked=() floored=()
ok_tags=() ok_digests=() ok_lines=()
history_error="" history_bad_line=0
floor_start=0 floor_note=""
load_history() {
  local line number=0 contract
  local -a contracts
  ok_tags=() ok_digests=() ok_lines=() revoked=() floored=() history_error="" history_bad_line=0
  floor_start=0 floor_note=""
  [[ -f $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    number=$((number + 1))
    [[ -n $line ]] || continue
    if ! parse_line "$line"; then
      history_bad_line=$number
      history_error="$1 line $number is malformed ($bad): nothing that reads that log runs until it's fixed (see _docs/deployment.md, The release record)"
      return 1
    fi
    if [[ ${f[action]-} == floor ]]; then
      floor_start=${#ok_digests[@]}
      floor_note="contract migration ${f[contracts]-?} ran with the deploy of ${f[tag]-?} at ${f[time]-?}"
      IFS=, read -ra contracts <<<"${f[contracts]-}"
      for contract in "${contracts[@]}"; do
        [[ ! $contract =~ $REVISION_RE ]] || floored[$contract]=1
      done
      continue
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
# known-good release at or above the rollback floor (of <tag>, when given) whose digest
# isn't one of those skipped, as "<tag> <digest>"; or nothing. A rollback target.
# keep_release_images (pruning) walks the same list, from the same floor.
known_good() { known_good_since "$floor_start" "$@"; }
# promotable <tag or ""> [digests to skip...]: the same, below the floor too. What prod
# may take from dev: dev's floor is about dev's schema, and prod moves its own floor
# when it runs the contract migration itself.
promotable() { known_good_since 0 "$@"; }
known_good_since() {
  local start=$1 want=$2 i d skip
  shift 2
  for ((i = ${#ok_digests[@]} - 1; i >= start; i--)); do
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

# above_floor <tag> <digest>: the loaded history has no floor line, or an ok line for that
# release after its newest one: it ran on the schema the last contract migration left.
above_floor() {
  local i
  [[ -n $floor_note ]] || return 0
  for ((i = floor_start; i < ${#ok_digests[@]}; i++)); do
    [[ ${ok_tags[i]} == "$1" && ${ok_digests[i]} == "$2" ]] && return 0
  done
  return 1
}

# is_known_good <tag> <digest>: that exact release is known-good in the loaded history,
# whatever its floor (promotion only, like `promotable`).
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

# root_owned <path>: it exists, root owns it, and neither group nor others can write it.
root_owned() {
  local owner mode
  owner=$(stat -c %u -- "$1" 2>/dev/null) || return 1
  mode=$(stat -c %a -- "$1") || return 1
  [[ $owner == 0 ]] && (((8#$mode & 8#022) == 0))
}

# verify_provenance <tag> <digest> (#177): the pinned cosign, offline against the pinned
# trusted root, finds an attestation of exactly <digest> that ci.yml on main signed for a
# push of <tag> (see Build provenance). Its reason goes to the client on a refusal.
verify_provenance() {
  local path out rc=0
  for path in "$SIGSTORE_DIR" "$COSIGN" "$TRUSTED_ROOT"; do
    if ! root_owned "$path"; then
      printf "focus-ci: %s is missing, or isn't root's and writable by root only: run infra/server/bootstrap.sh (see _docs/deployment.md, Build provenance)\n" "$path" >&2
      return 1
    fi
  done
  out=$(clean timeout --kill-after=10 "$PROVENANCE_TIMEOUT_SECONDS" "$COSIGN" verify-attestation \
    --trusted-root "$TRUSTED_ROOT" \
    --type slsaprovenance1 \
    --certificate-oidc-issuer "$SIGNER_ISSUER" \
    --certificate-identity "$SIGNER_IDENTITY" \
    --certificate-github-workflow-repository "$SIGNER_REPOSITORY" \
    --certificate-github-workflow-ref "$SIGNER_REF" \
    --certificate-github-workflow-trigger push \
    --certificate-github-workflow-sha "$1" \
    "$IMAGE_REPO@$2" 2>&1 >/dev/null) || rc=$?
  if ((rc == 0)); then
    log "build provenance: .github/workflows/ci.yml on $SIGNER_REF attested $IMAGE_REPO@$2 as built from $1"
    return 0
  fi
  [[ -z $out ]] || printf '%s\n' "$out" | sed 's/^/cosign: /' >&2
  if ((rc == 124 || rc == 137)); then
    printf 'focus-ci: cosign timed out after %ss\n' "$PROVENANCE_TIMEOUT_SECONDS" >&2
  fi
  printf "focus-ci: %s has no valid build provenance attestation from .github/workflows/ci.yml on %s for %s (cosign's reason is above), so nothing is pulled\n" \
    "$IMAGE_REPO@$2" "$SIGNER_REF" "$1" >&2
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

# read_schema <tag>: the release's alembic head and contract revisions (#165), into
# schema_head and schema_contracts: MIGRATION_INFO, fed on stdin to a one-shot app
# container of that release (the app service's limits; --no-deps: no database), reads
# the image's own migrations. Its output is checked strictly: exactly one line of each.
schema_head="" schema_contracts=""
read_schema() {
  local out line head="" list="" heads=0 lists=0
  if [[ ! -r $MIGRATION_INFO ]]; then
    echo "focus-ci: $MIGRATION_INFO is missing: run infra/server/install.sh (see _docs/deployment.md)" >&2
    return 1
  fi
  # Like `compose`, but with the helper on stdin instead of /dev/null.
  out=$(env -i PATH="$CLEAN_PATH" HOME="$home" APP_TAG="$1" "$INFRA_DIR/compose.sh" "$env_name" \
    run --rm -T --pull never --no-deps app python - <"$MIGRATION_INFO" 9<&-) || return 1
  while IFS= read -r line; do
    case $line in
      schema=*) head=${line#schema=} heads=$((heads + 1)) ;;
      contracts=*) list=${line#contracts=} lists=$((lists + 1)) ;;
    esac
  done <<<"$out"
  if ((heads != 1 || lists != 1)) || [[ ! $head =~ $REVISION_RE || ! $list =~ $CONTRACTS_RE ]]; then
    printf "focus-ci: can't read %s's schema: expected one schema=<revision> and one contracts=<revisions> line, got %q\n" \
      "$1" "${out:0:200}" >&2
    return 1
  fi
  schema_head=$head schema_contracts=$list
  log "$1 migrates to alembic head $head; contract migrations: $list"
}

# new_contracts: schema_contracts this environment's loaded history has no floor line
# for, comma-separated; empty when there's none.
new_contracts() {
  local contract new=""
  local -a contracts
  [[ $schema_contracts != - ]] || return 0
  IFS=, read -ra contracts <<<"$schema_contracts"
  for contract in "${contracts[@]}"; do
    [[ -n ${floored[$contract]-} ]] || new+=${new:+,}$contract
  done
  printf '%s' "$new"
}

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

# history_line <action> <outcome> [extra fields...], using $tag $digest $previous_*. A
# deploy's lines also carry schema=<alembic head> once it's read (#165).
history_line() {
  local action=$1 outcome=$2
  shift 2
  if [[ $action == deploy && -n $schema_head ]]; then
    set -- "$@" "schema=$schema_head"
  fi
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
# checks; unless it's below the rollback floor (#165), which needs the schema a contract
# migration removed. Then fail either way: the action didn't happen, and the record is
# unchanged.
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
  if ! above_floor "$back_tag" "$back_digest"; then
    fail "$action of $new_tag failed at 'start', and $back_tag, the release that ran before, is below $env_name's rollback floor ($floor_note), so it isn't started again: $env_name may be running $new_tag unhealthy. Fix forward (_docs/runbooks/rollback.md)"
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
# KEEP_KNOWN_GOOD known-good releases at or above its rollback floor (the rollbacks after
# that; like known_good). Returns 1, with the reason in $prune_error, when that can't be
# read with certainty. prune_error names a malformed releases.log by its path and line
# number only, never the bad word (#186): pruning reads the other environment's log too,
# and what that line holds is no business of this key. Its own log can't be malformed
# here: the deploy or rollback read it first, under the same lock, and stopped on it.
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
    if ((history_bad_line > 0)); then
      prune_error="$dir/releases.log line $history_bad_line is malformed (see _docs/deployment.md, The release record)"
    else
      prune_error="can't read $dir/releases.log"
    fi
    return 1
  fi
  for ((i = ${#ok_digests[@]} - 1; i >= floor_start && n < KEEP_KNOWN_GOOD; i--)); do
    d=${ok_digests[i]}
    [[ -z ${revoked[$d]-} && -z ${counted[$d]-} ]] || continue
    counted[$d]=1
    keep_digests[$d]=1
    n=$((n + 1))
  done
}

# app_refs <image id>: that image's IMAGE_REPO references (<repo>:<tag>, <repo>@<digest>),
# one per line, each once. Fails when they can't be read, or the image is gone. The
# containerd image store lists an image's digest reference once per name it has (its
# <repo>@<digest> and each <repo>:<tag>), so the same reference can come twice (#186).
app_refs() {
  local out ref
  local -A listed=()
  out=$(clean docker image inspect --format \
    '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' "$1") || return 1
  while IFS= read -r ref; do
    case $ref in
      "$IMAGE_REPO@"* | "$IMAGE_REPO:"*)
        [[ -n ${listed[$ref]-} ]] && continue
        listed[$ref]=1
        printf '%s\n' "$ref"
        ;;
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
    found=$(promotable "$tag")
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

# set_floor: before a deploy migrates (#165). If the release brings a contract revision
# this environment hasn't run, write the floor line first: the releases before it are no
# longer rollback targets, whatever the migration does next (it can't be undone, and one
# cut short may have run part of it). So this release's rollback target is none, and a
# failed start doesn't revert below the floor either. It (re)loads this environment's
# history, which start_or_revert reads next: a prod deploy's `promote` loaded dev's.
set_floor() {
  local new
  read_history "$history"
  new=$(new_contracts)
  [[ -n $new ]] || return 0
  previous_tag="" previous_digest=""
  history_line floor set "schema=$schema_head" "contracts=$schema_contracts"
  read_history "$history"
  audit "floor tag=$tag digest=$digest contracts=$new"
  log "contract migration $new: $env_name's rollback floor is now $tag. The releases before it are no longer rollback targets"
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
  # other than this one (normally the current release), never below the rollback floor.
  read_history "$history"
  read -r previous_tag previous_digest <<<"$(known_good "" "$digest")"
  if [[ -z $previous_tag && -n $current_tag && $current_digest != "$digest" ]] &&
    above_floor "$current_tag" "$current_digest"; then
    previous_tag=$current_tag previous_digest=$current_digest
  fi
  audit "deploy tag=$tag digest=$digest"
  log "deploying $tag ($IMAGE_REPO@$digest) to $env_name, infra $infra_revision; current: ${current_tag:-none}"
  if [[ -n $promote_from ]]; then
    step deploy promote promoted "$tag" "$digest"
  fi
  step deploy provenance verify_provenance "$tag" "$digest"
  step deploy pull pull_release "$tag" "$digest"
  step deploy schema read_schema "$tag"
  set_floor
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
  # Known-good, but below the rollback floor (#165): say so, rather than "not recorded".
  if [[ -z $found && -n $(promotable "$want" "$from_digest") ]]; then
    local why="$floor_note. The releases from before it may need what that migration removed, so they are no longer rollback targets. Nothing changed: fix forward (_docs/runbooks/rollback.md)"
    [[ -z $want ]] ||
      fail "$want is below $env_name's rollback floor: $why"
    fail "nothing to roll back to above $env_name's rollback floor: every known-good release other than the current one ($from_tag) is below it: $why"
  fi
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
