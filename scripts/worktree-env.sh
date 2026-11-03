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
#       (`make worktree-gc`) Stop the stacks of subagent worktrees whose folder is gone and
#       free their slots, then list the slots in use.
#   scripts/worktree-env.sh list
#       List the slots in use.
#
# claim and release do nothing in a checkout whose .env has no WORKTREE_SLOT line: the main
# checkout, a session worktree, CI, or a .env copied by hand.
#
# Slots 10-17: slot k adds 10k to each default port (app 8000 + 10k, Vite 5173 + 10k, Grafana
# 3000 + 10k, OTLP 4317/4318 + 10k, Postgres 5432 + 10k), so they never meet the main
# checkout (+0), a second session worktree (+10) or a third (+20). Eight slots: two parallel
# sessions of at most 4 subagents each (#172).
#
# A slot is a directory, <git common dir>/focus-worktree-slots/<k>, holding the owning
# worktree's path. `mkdir` either creates it or fails, so two agents starting at once never
# get the same slot. A slot whose owner folder no longer exists is stale and can be taken
# over. A new slot is only taken if none of its ports answers on 127.0.0.1.
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
PORTS="APP_PORT:8000 VITE_PORT:5173 GRAFANA_PORT:3000 OTLP_GRPC_PORT:4317 OTLP_HTTP_PORT:4318 POSTGRES_PORT:5432"
# Lines of the session's .env this script sets itself.
OWN_KEYS="WORKTREE_SESSION|WORKTREE_SLOT|COMPOSE_PROJECT_NAME|APP_PORT|GRAFANA_PORT|OTLP_GRPC_PORT|OTLP_HTTP_PORT|POSTGRES_PORT|DATABASE_URL"

die() {
  printf 'worktree-env: %s\n' "$*" >&2
  exit 1
}

slot_dir() {
  if [[ -n ${WORKTREE_SLOT_DIR:-} ]]; then
    printf '%s\n' "$WORKTREE_SLOT_DIR"
    return
  fi
  local common
  common=$(cd "$root" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
    die "not in a git checkout, so there is nowhere shared to keep the slots"
  printf '%s/focus-worktree-slots\n' "$common"
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

# 0 if the slot is taken by a worktree folder that no longer exists.
is_stale() {  # <slot>
  local owner
  owner=$(owner_of "$1")
  [[ -n $owner && ! -d $owner ]]
}

# Take <slot> for this worktree. 0 on success (also when it already holds it).
take() {  # <slot>
  local dir
  dir="$(slot_dir)/$1"
  [[ $(owner_of "$1") == "$root" ]] && return 0
  if is_stale "$1"; then
    # Move the stale claim aside first: of two agents doing this at once, only one rename
    # succeeds, and only one mkdir below.
    mv "$dir" "$dir.stale.$$" 2>/dev/null && clear_slot "$dir.stale.$$"
  fi
  mkdir "$dir" 2>/dev/null || return 1
  printf '%s\n' "$root" >"$dir/owner"
  printf '%s\n' "$(env_get "$env_file" COMPOSE_PROJECT_NAME)" >"$dir/project"
}

clear_slot() {  # <slot directory>
  rm -f "$1/owner" "$1/project"
  rmdir "$1" 2>/dev/null || true
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
    if ! slot_ports_free "$slot" && [[ -z $(owner_of "$slot") ]]; then
      continue  # something outside the slots (another process, an old stack) holds a port
    fi
    if take "$slot"; then
      if slot_ports_free "$slot"; then
        printf '%s\n' "$slot"
        return
      fi
      clear_slot "$(slot_dir)/$slot"  # a stale owner's stack still runs there
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
  printf 'focus-%s-%s\n' "$session" "$worktree" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_\n-' '-'
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
  printf '%s\n' "$project" >"$(slot_dir)/$slot/project"
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
DATABASE_URL=postgresql+asyncpg://${user:-focus}:${password:-focus}@localhost:$((5432 + offset))/${database:-focus}
EOF
    } >"$tmp"
  )
  mv "$tmp" "$env_file"

  local extra
  for extra in $(held_slots); do
    [[ $extra == "$slot" ]] || clear_slot "$(slot_dir)/$extra"
  done
  printf 'Wrote %s from %s\n' "$env_file" "$source"
  printf '  project %s, slot %s: app http://localhost:%s, Vite %s, Grafana %s, Postgres %s\n' \
    "$project" "$slot" $((8000 + offset)) $((5173 + offset)) $((3000 + offset)) $((5432 + offset))
  printf '  next: make up-test (app + Postgres), then make test; make down when done\n'
}

claim() {
  local slot session
  slot=$(env_get "$env_file" WORKTREE_SLOT)
  [[ -n $slot ]] || return 0
  mkdir -p "$(slot_dir)"
  if take "$slot"; then
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
    clear_slot "$(slot_dir)/$slot"
    printf 'Freed slot %s.\n' "$slot"
  done
}

list() {
  local slot owner project state
  printf '%-5s %-9s %-45s %s\n' Slot App Project Worktree
  for ((slot = FIRST_SLOT; slot <= LAST_SLOT; slot++)); do
    [[ -d "$(slot_dir)/$slot" ]] || continue
    owner=$(owner_of "$slot")
    project=$(cat "$(slot_dir)/$slot/project" 2>/dev/null || true)
    state=$owner
    [[ -d $owner ]] || state="$owner (gone)"
    printf '%-5s %-9s %-45s %s\n' "$slot" $((8000 + 10 * slot)) "${project:-?}" "$state"
  done
}

# Stop a stack by project name (no compose file needed for that) and remove its app image.
stop_project() {  # <project>
  printf 'Stopping %s\n' "$1"
  docker compose --project-directory "$root" -f "$root/compose.yaml" -p "$1" \
    down --rmi local --remove-orphans
}

gc() {
  local slot owner project stopped=" " name files
  for ((slot = FIRST_SLOT; slot <= LAST_SLOT; slot++)); do
    is_stale "$slot" || continue
    owner=$(owner_of "$slot")
    project=$(cat "$(slot_dir)/$slot/project" 2>/dev/null || true)
    if [[ -n $project ]]; then
      stop_project "$project"
      stopped+="$project "
    fi
    clear_slot "$(slot_dir)/$slot"
    printf 'Freed slot %s (%s is gone).\n' "$slot" "$owner"
  done
  # Stacks started from a subagent worktree that's gone, with or without a slot record.
  while IFS=$'\t' read -r name files; do
    [[ -n $name && $files == */.claude/worktrees/* ]] || continue
    [[ $stopped == *" $name "* ]] && continue
    [[ -e ${files%%,*} ]] && continue
    stop_project "$name"
  done < <(docker compose ls --all --format json | jq -r '.[] | [.Name, .ConfigFiles] | @tsv')
  list
}

case "${1:-}" in
  write) write_env "${2:-}" ;;
  claim) claim ;;
  release) release ;;
  gc) gc ;;
  list) list ;;
  *)
    echo "usage: scripts/worktree-env.sh write <session folder> | claim | release | gc | list" >&2
    exit 2
    ;;
esac
