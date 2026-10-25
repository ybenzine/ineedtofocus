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
# `… | first_line`: the first line of stdin, read to the end. Never `| head -n1` (or any
# reader that stops early: `grep -q`, `grep -m`, awk's `exit`): it exits after one line,
# and a writer with more left to write then dies of SIGPIPE. tail writes a file 8 KiB at
# a time, so `new_calls | head -n1` did whenever the new calls crossed an 8 KiB boundary
# of calls.log and head won the race between two of tail's writes. Under pipefail that
# made the pipeline's status 141, and in an assignment set -e stopped the whole harness
# with it, right after a passing check (#256).
first_line() { sed -n 1p; }

finish() {
  echo
  if ((failures)); then
    echo "$failures check(s) failed"
    exit 1
  fi
  echo "all checks passed"
}
