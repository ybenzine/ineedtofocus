#!/usr/bin/env bash
# Shared helpers for the `make test-server` container tests (in_container.sh, focus_ci.sh).
# Source it; `failures` counts failed checks and `finish` reports them.

failures=0

check() {
  local desc=$1
  shift
  if "$@"; then
    printf 'ok   %s\n' "$desc"
  else
    printf 'FAIL %s\n' "$desc"
    failures=$((failures + 1))
  fi
}
eq() {
  [[ $1 == "$2" ]] && return 0
  printf '     expected %q\n     got      %q\n' "$2" "$1"
  return 1
}
contains() {
  grep -qF -- "$2" <<<"$1" && return 0
  printf '     %q not found in:\n%s\n' "$2" "$1"
  return 1
}
not_contains() {
  grep -qF -- "$2" <<<"$1" || return 0
  printf '     %q unexpectedly found in:\n%s\n' "$2" "$1"
  return 1
}
mode_owner() { stat -c '%a %U:%G' "$1"; }

finish() {
  echo
  if ((failures)); then
    echo "$failures check(s) failed"
    exit 1
  fi
  echo "all checks passed"
}
