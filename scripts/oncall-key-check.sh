#!/usr/bin/env bash
# The respond session's check that its commands can't read the Claude key (#266).
#
#   scripts/oncall-key-check.sh
#
# Prints exactly `absent` and exits 1 when ANTHROPIC_API_KEY is unset or empty in this
# process's environment, else exactly `present` and exits 0. It never prints the value:
# a check that can't print the key can't leak it, even if CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
# stopped working. The session runs it on every incident and reports only the word.
# Protected like every scripts/oncall* file (check-fix, the wrapper's deny rules).
if [[ -n ${ANTHROPIC_API_KEY:-} ]]; then
  echo present
  exit 0
fi
echo absent
exit 1
