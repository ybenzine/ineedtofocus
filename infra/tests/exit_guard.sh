#!/usr/bin/env bash
# Source it from a test harness that runs on the host and sets an EXIT trap
# (check_config.sh, prod_stack.sh), so that a shell error can't end in a pass (#183).
#
# macOS's /bin/bash is 3.2. When a syntax error or a bad substitution stops a script there
# (bash-4-only syntax such as `[[ -v name ]]` or `${name,,}` is one), bash 3.2 runs the
# EXIT trap with $? still holding the status of the last command that ran, usually 0,
# and the script then exits 0: the harness stops halfway and reports success. Bash 4 and
# later (CI) give the trap the error's status. So a harness only passes if it reached
# its last line:
#
#   . "$here/exit_guard.sh"
#   cleanup() {
#     local status=$?
#     exit_guard "$status" || status=$?
#     ...
#     exit "$status"
#   }
#   trap cleanup EXIT
#   ...
#   harness_done # the last line
#
# A harness that means to stop early with success calls harness_done first.

harness_finished=

harness_done() { harness_finished=1; }

# exit_guard <status>: returns the status the harness should exit with: <status>, or 1
# when it's 0 but the harness never reached harness_done.
exit_guard() {
  if (($1 == 0)) && [[ -z $harness_finished ]]; then
    echo "FAIL  ${0##*/} stopped before its last line, yet with status 0: look for a shell error above (bash $BASH_VERSION; see _docs/testing.md, #183)" >&2
    return 1
  fi
  return "$1"
}
