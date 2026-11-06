#!/usr/bin/env bash
# One local stack per subagent worktree (#442): its own Compose project and a slot of host
# ports, so parallel subagents never drive one another's stack.
#
# A subagent the lead starts with worktree isolation works in
# <main checkout>/.claude/worktrees/<id>/ (_docs/process.md, Parallel sessions, Subagent
# worktrees). This script gives that worktree a .env of its own, made from the session's:
#
#   scripts/worktree-env.sh write <session folder>
#       (`make worktree-env SESSION=<session folder>`) Claim a free slot and write .env: the
#       session's .env (or .env.example if it has none) with COMPOSE_PROJECT_NAME
#       focus-<session>-<worktree id> and every host port + 10 x slot. Run it again and it
#       keeps the slot it holds.
#   scripts/worktree-env.sh claim
#       (`make up`, `make up-test`) Hold the slot named in .env again. If another worktree
#       took it after a `make down`, write .env again on a new slot.
#   scripts/worktree-env.sh release
#       (`make down`) Free the slot this worktree holds.
#   scripts/worktree-env.sh gc
#       (`make worktree-gc`) Stop the stacks this script set up for subagent worktrees whose
#       folder is gone and free their slots, list leftover database volumes (never removes
#       them), then list the slots in use.
#   scripts/worktree-env.sh list
#       List the slots in use.
#   scripts/worktree-env.sh require-compose
#       (`make up-test`) Stop unless Docker Compose is 2.24 or later, which compose.test.yaml's
#       `!override` and `!reset` tags need.
#
# claim and release do nothing in a checkout whose .env has no WORKTREE_SLOT line: the main
# checkout, a session worktree, CI, or a .env copied by hand.
#
# Slots 10-17: slot k adds 10k to each default port (app 8000 + 10k, Vite 5173 + 10k, Grafana
# 3000 + 10k, OTLP 4317/4318 + 10k, Postgres 5432 + 10k, Mailpit's web UI and API 8025 + 10k),
# so they never meet the main checkout (+0), a second session worktree (+10) or a third (+20).
# Eight slots: two parallel sessions of at most 4 subagents each (#172).
#
# A slot is a directory, <git common dir>/focus-worktree-slots/<k>, with `owner` (the owning
# worktree's path) and `project` (its Compose project). `mkdir` either creates it or fails,
# so two agents starting at once never get the same slot. A new slot is only taken if none
# of its ports answers on 127.0.0.1.
#
# A slot is stale when its owner folder no longer exists, or when it has had no owner for
# over a minute (an agent killed between `mkdir` and writing `owner`). Clearing a stale slot
# happens only under a lock (<slots>/.lock) and after checking again that it's still
# stale, so a claim another agent just made is never cleared.
#
# `project` is written only by the slot's owner, and only with a name this script gives that
# worktree (focus-<session>-<its id>). gc stops a recorded project only when it still has
# that form for the slot's owner, so it never stops a session's shared stack (focus-local,
# focus-m3) or another worktree's.
#
# Environment: WORKTREE_SLOT_DIR overrides where slots live (tests).
# WORKTREE_SLOT_TEST_BUSY_PORTS, when set, replaces the real port check with that
# space-separated list of ports in use (tests only).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
env_file=$root/.env

FIRST_SLOT=10
LAST_SLOT=17
# name:default port. Vite has no .env variable but its port is checked and documented too.
PORTS="APP_PORT:8000 VITE_PORT:5173 GRAFANA_PORT:3000 OTLP_GRPC_PORT:4317 OTLP_HTTP_PORT:4318 POSTGRES_PORT:5432 MAILPIT_PORT:8025"
# Lines of the session's .env this script sets itself.
OWN_KEYS="WORKTREE_SESSION|WORKTREE_SLOT|COMPOSE_PROJECT_NAME|APP_PORT|GRAFANA_PORT|OTLP_GRPC_PORT|OTLP_HTTP_PORT|POSTGRES_PORT|MAILPIT_PORT|DATABASE_URL"
# How long, in minutes, an owner-less slot or the lock may sit before it counts as left over.
GRACE_MINUTES=1
# compose.test.yaml's `!override` and `!reset` need this Compose version or later.
COMPOSE_MIN_MAJOR=2
COMPOSE_MIN_MINOR=24

die() {
  printf 'worktree-env: %s\n' "$*" >&2
  exit 1
}

git_common_dir() {
  (cd "$root" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
}

slot_dir() {
  if [[ -n ${WORKTREE_SLOT_DIR:-} ]]; then
    printf '%s\n' "$WORKTREE_SLOT_DIR"
    return
  fi
  local common
  common=$(git_common_dir) || die "not in a git checkout, so there is nowhere shared to keep the slots"
  printf '%s/focus-worktree-slots\n' "$common"
}

# Where subagent worktrees live: <main checkout>/.claude/worktrees.
worktrees_dir() {
  local common
  if [[ $root/ == */.claude/worktrees/* ]]; then
    printf '%s/.claude/worktrees\n' "${root%%/.claude/worktrees/*}"
  elif common=$(git_common_dir); then
    printf '%s/.claude/worktrees\n' "$(dirname "$common")"
  else
    printf '%s/.claude/worktrees\n' "$root"
  fi
}

# The last value of KEY in an env file, the way Compose reads it: `KEY=v` or `export KEY=v`,
# quotes and trailing comments dropped.
env_get() {  # <file> <key>
  local value
  [[ -f $1 ]] || return 0
  value=$(sed -En "s/^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -n 1)
  value=${value%%[[:space:]]#*}
  value=${value%"${value##*[![:space:]]}"}
  value=${value//\"/}
  value=${value//\'/}
  printf '%s\n' "$value"
}

# Lowercase, and anything Compose doesn't take in a project name becomes `-`.
sanitize() {
  tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_\n-' '-'
}

# 0 if <project> is a name this script gives the worktree at <path>: focus-<session>-<its id>.
is_own_project() {  # <project> <worktree path>
  local id
  id=$(basename "$2" | sanitize)
  [[ -n $id && $1 == focus-?*-"$id" ]]
}

port_in_use() {  # <port>
  if [[ -n ${WORKTREE_SLOT_TEST_BUSY_PORTS+set} ]]; then
    [[ " $WORKTREE_SLOT_TEST_BUSY_PORTS " == *" $1 "* ]]
    return
  fi
  (: <"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

slot_ports_free() {  # <slot>
  local entry
  for entry in $PORTS; do
    if port_in_use $((${entry#*:} + 10 * $1)); then
      return 1
    fi
  done
}

owner_of() {  # <slot>: the owning worktree's path, or nothing
  local file
  file="$(slot_dir)/$1/owner"
  if [[ -f $file ]]; then
    cat "$file"
  fi
}

project_of() {  # <slot>: the recorded Compose project, or nothing
  cat "$(slot_dir)/$1/project" 2>/dev/null || true
}

older_than_grace() {  # <path>
  [[ -n $(find "$1" -maxdepth 0 -mmin +"$GRACE_MINUTES" 2>/dev/null) ]]
}

# 0 if the slot is taken but left over: its owner folder is gone, or it has had no owner
# for longer than the grace period.
is_stale() {  # <slot>
  local dir owner
  dir="$(slot_dir)/$1"
  [[ -d $dir ]] || return 1
  owner=$(owner_of "$1")
  if [[ -n $owner ]]; then
    [[ ! -d $owner ]]
  else
    older_than_grace "$dir"
  fi
}

# Run a command holding the slots' lock. A lock older than the grace period was left by a
# killed run and is broken.
with_lock() {  # <command> [args]
  local lock tries=0 status=0
  lock="$(slot_dir)/.lock"
  until mkdir "$lock" 2>/dev/null; do
    if older_than_grace "$lock"; then
      rmdir "$lock" 2>/dev/null || true
      continue
    fi
    tries=$((tries + 1))
    ((tries < 300)) || die "the slots stayed locked for 30 s ($lock)"
    sleep 0.1
  done
  "$@" || status=$?
  rmdir "$lock" 2>/dev/null || true
  return "$status"
}

clear_slot() {  # <slot>
  local dir
  dir="$(slot_dir)/$1"
  rm -f "$dir/owner" "$dir/project"
  rmdir "$dir" 2>/dev/null || true
}

# Under the lock: clear the slot only if it's still stale now.
clear_if_stale() {  # <slot>
  if is_stale "$1"; then
    clear_slot "$1"
  fi
}

# Take <slot> for this worktree. 0 on success (also when it already holds it). Records only
# the owner; the project is recorded by record_project.
take() {  # <slot>
  local dir
  dir="$(slot_dir)/$1"
  [[ $(owner_of "$1") == "$root" ]] && return 0
  if is_stale "$1"; then
    with_lock clear_if_stale "$1"
  fi
  mkdir "$dir" 2>/dev/null || return 1
  printf '%s\n' "$root" >"$dir/owner"
  [[ $(owner_of "$1") == "$root" ]]
}

# Record <project> for <slot>, only while this worktree owns the slot and only if it's a
# name this script gives this worktree.
record_project() {  # <slot> <project>
  [[ $(owner_of "$1") == "$root" ]] || return 0
  is_own_project "$2" "$root" || return 0
  printf '%s\n' "$2" >"$(slot_dir)/$1/project"
}

# The slots this worktree holds.
held_slots() {
  local slot
  for ((slot = FIRST_SLOT; slot <= LAST_SLOT; slot++)); do
    if [[ $(owner_of "$slot") == "$root" ]]; then
      printf '%s\n' "$slot"
    fi
  done
}

allocate() {
  local slot
  slot=$(held_slots | head -n 1)
  if [[ -n $slot ]]; then
    printf '%s\n' "$slot"
    return
  fi
  for ((slot = FIRST_SLOT; slot <= LAST_SLOT; slot++)); do
    if ! slot_ports_free "$slot" && ! [[ -d "$(slot_dir)/$slot" ]]; then
      continue  # something outside the slots (another process, an old stack) holds a port
    fi
    take "$slot" || continue
    if ! slot_ports_free "$slot"; then
      clear_slot "$slot"  # a stale owner's stack still runs there
      continue
    fi
    # Still ours? Then it's the slot.
    if [[ $(owner_of "$slot") == "$root" ]]; then
      printf '%s\n' "$slot"
      return
    fi
  done
  list >&2
  die "no free slot ($FIRST_SLOT-$LAST_SLOT). Run make worktree-gc to stop stacks whose worktree is gone, or make down in a finished worktree."
}

project_name() {  # <session .env>
  local session worktree
  session=$(env_get "$1" COMPOSE_PROJECT_NAME)
  session=${session:-focus-local}
  session=${session#focus-}
  worktree=$(basename "$root")
  printf 'focus-%s-%s\n' "$session" "$worktree" | sanitize
}

# 0 if a `docker compose ls` entry is a stack this script named for a subagent worktree that
# no longer exists: project focus-<session>-<worktree id>, every config file under that
# worktree, none of them left. A session's own project (focus-local, focus-m3) is never
# one, even when its config files point into a removed worktree because a subagent started
# it there with a copied .env.
is_orphan_stack() {  # <project> <comma-separated config files>
  local file dir id="" ids
  IFS=, read -r -a ids <<<"$2"
  for file in "${ids[@]}"; do
    [[ -e $file ]] && return 1
    dir=$(dirname "$file")
    [[ $(dirname "$dir") == */.claude/worktrees ]] || return 1
    [[ -z $id || $id == "$(basename "$dir")" ]] || return 1
    id=$(basename "$dir")
  done
  [[ -n $id ]] && is_own_project "$1" "$id"
}

write_env() {  # <session folder>
  [[ $root/ == */.claude/worktrees/* ]] ||
    die "$root is not a subagent worktree (.claude/worktrees/). The main checkout and session worktrees set their .env by hand: _docs/process.md, Parallel sessions."
  [[ -n ${1:-} ]] || die "usage: scripts/worktree-env.sh write <session folder> (make worktree-env SESSION=<session folder>)"
  [[ -d $1 ]] || die "no such session folder: $1"
  local session source slot offset project user password database tmp
  session=$(cd "$1" && pwd -P)
  [[ $session != "$root" ]] || die "the session folder is this worktree itself; name the lead's folder"
  source=$session/.env
  [[ -f $source ]] || source=$root/.env.example

  project=$(project_name "$source")
  mkdir -p "$(slot_dir)"
  slot=$(allocate)
  record_project "$slot" "$project"
  offset=$((10 * slot))
  user=$(env_get "$source" POSTGRES_USER)
  password=$(env_get "$source" POSTGRES_PASSWORD)
  database=$(env_get "$source" POSTGRES_DB)

  tmp=$env_file.tmp.$$
  (
    umask 077
    {
      printf '# Written by scripts/worktree-env.sh (#442) from %s.\n' "$source"
      printf '# Run make worktree-env SESSION=<session folder> again rather than editing it.\n'
      grep -Ev "^[[:space:]]*(export[[:space:]]+)?($OWN_KEYS)[[:space:]]*=" "$source" || true
      cat <<EOF

# --- This subagent worktree's own stack: slot $slot, every host port + $offset ---
# make down frees the slot; make up and make up-test claim it again.
WORKTREE_SESSION=$session
WORKTREE_SLOT=$slot
COMPOSE_PROJECT_NAME=$project
APP_PORT=$((8000 + offset))
GRAFANA_PORT=$((3000 + offset))
OTLP_GRPC_PORT=$((4317 + offset))
OTLP_HTTP_PORT=$((4318 + offset))
POSTGRES_PORT=$((5432 + offset))
MAILPIT_PORT=$((8025 + offset))
DATABASE_URL=postgresql+asyncpg://${user:-focus}:${password:-focus}@localhost:$((5432 + offset))/${database:-focus}
EOF
    } >"$tmp"
  )
  mv "$tmp" "$env_file"

  local extra
  for extra in $(held_slots); do
    [[ $extra == "$slot" ]] || clear_slot "$extra"
  done
  printf 'Wrote %s from %s\n' "$env_file" "$source"
  printf '  project %s, slot %s: app http://localhost:%s, Vite %s, Grafana %s, Postgres %s, Mailpit %s\n' \
    "$project" "$slot" $((8000 + offset)) $((5173 + offset)) $((3000 + offset)) $((5432 + offset)) $((8025 + offset))
  printf '  next: make up-test (app + Postgres), then make test; make down when done\n'
}

claim() {
  local slot session
  slot=$(env_get "$env_file" WORKTREE_SLOT)
  [[ -n $slot ]] || return 0
  mkdir -p "$(slot_dir)"
  if take "$slot"; then
    # .env is one write_env made; record_project still refuses a name that isn't this
    # worktree's own, e.g. one edited in by hand.
    record_project "$slot" "$(env_get "$env_file" COMPOSE_PROJECT_NAME)"
    return 0
  fi
  session=$(env_get "$env_file" WORKTREE_SESSION)
  printf 'worktree-env: slot %s is now %s'"'"'s; moving this worktree to a free slot.\n' \
    "$slot" "$(owner_of "$slot")" >&2
  [[ -d $session ]] || die "the session folder recorded in .env ($session) is gone: run make worktree-env SESSION=<session folder>"
  write_env "$session" >&2
}

release() {
  local slot
  [[ -n $(env_get "$env_file" WORKTREE_SLOT) ]] || return 0
  for slot in $(held_slots); do
    clear_slot "$slot"
    printf 'Freed slot %s.\n' "$slot"
  done
}

list() {
  local slot owner project state
  printf '%-5s %-9s %-45s %s\n' Slot App Project Worktree
  for ((slot = FIRST_SLOT; slot <= LAST_SLOT; slot++)); do
    [[ -d "$(slot_dir)/$slot" ]] || continue
    owner=$(owner_of "$slot")
    project=$(project_of "$slot")
    if [[ -z $owner ]]; then
      state="(no owner yet)"
    elif [[ -d $owner ]]; then
      state=$owner
    else
      state="$owner (gone)"
    fi
    printf '%-5s %-9s %-45s %s\n' "$slot" $((8000 + 10 * slot)) "${project:-?}" "$state"
  done
}

# Stop a stack by project name (no compose file needed for that) and remove its app image.
stop_project() {  # <project>
  printf 'Stopping %s\n' "$1"
  docker compose --project-directory "$root" -f "$root/compose.yaml" -p "$1" \
    down --rmi local --remove-orphans
}

# Database volumes a full `make up` left in subagent worktrees (agent-<id>, as Claude Code
# names them) whose folder is gone and that no container uses.
leftover_volumes() {
  local name id dir
  dir=$(worktrees_dir)
  while read -r name; do
    [[ $name == focus-?*-agent-?*_db-data ]] || continue
    id=${name%_db-data}
    id=agent-${id##*-agent-}
    [[ -d $dir/$id ]] && continue
    [[ -n $(docker ps -aq --filter "volume=$name") ]] && continue
    printf '%s\n' "$name"
  done < <(docker volume ls --format '{{.Name}}')
}

gc() {
  local slot owner project stopped=" " name files volumes
  for ((slot = FIRST_SLOT; slot <= LAST_SLOT; slot++)); do
    is_stale "$slot" || continue
    owner=$(owner_of "$slot")
    project=$(project_of "$slot")
    if [[ -n $project && -n $owner ]] && is_own_project "$project" "$owner"; then
      stop_project "$project"
      stopped+="$project "
    elif [[ -n $project ]]; then
      printf 'Slot %s records project %s, which is not a name worktree-env gives %s: left running.\n' \
        "$slot" "$project" "${owner:-an owner-less slot}"
    fi
    with_lock clear_if_stale "$slot"
    if [[ -n $owner ]]; then
      printf 'Freed slot %s (%s is gone).\n' "$slot" "$owner"
    else
      printf 'Freed slot %s (no owner for over %s minute).\n' "$slot" "$GRACE_MINUTES"
    fi
  done
  # Stacks this script named for a subagent worktree that's gone, with or without a slot
  # record (e.g. the slot was freed but the stack kept running).
  while IFS=$'\t' read -r name files; do
    [[ -n $name && $stopped != *" $name "* ]] || continue
    is_orphan_stack "$name" "$files" || continue
    stop_project "$name"
  done < <(docker compose ls --all --format json | jq -r '.[] | [.Name, .ConfigFiles] | @tsv')
  volumes=$(leftover_volumes)
  if [[ -n $volumes ]]; then
    printf 'Database volumes left by a full make up in subagent worktrees that are gone.\n'
    printf 'Not removed: deleting data is a human gate (_docs/process.md). To remove them:\n'
    printf '  docker volume rm %s\n' "${volumes//$'\n'/ }"
  fi
  list
}

require_compose() {
  local version
  version=$(docker compose version --short 2>/dev/null || true)
  version=${version#v}
  [[ $version =~ ^([0-9]+)\.([0-9]+) ]] || return 0  # unknown: let Compose speak for itself
  local major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]}
  if ((major < COMPOSE_MIN_MAJOR || (major == COMPOSE_MIN_MAJOR && minor < COMPOSE_MIN_MINOR))); then
    die "make up-test needs Docker Compose $COMPOSE_MIN_MAJOR.$COMPOSE_MIN_MINOR or later (compose.test.yaml uses !override and !reset); this is $version. Update Docker, or run the full stack with make up."
  fi
}

case "${1:-}" in
  write) write_env "${2:-}" ;;
  claim) claim ;;
  release) release ;;
  gc) gc ;;
  list) list ;;
  require-compose) require_compose ;;
  *)
    echo "usage: scripts/worktree-env.sh write <session folder> | claim | release | gc | list | require-compose" >&2
    exit 2
    ;;
esac
