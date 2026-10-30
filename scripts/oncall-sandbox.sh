#!/usr/bin/env bash
# The sandbox that an on-call session's Bash commands run in, on the Linux runner (#266).
#
#   scripts/oncall-sandbox.sh install   # apt packages, the AppArmor allowance, then check
#   scripts/oncall-sandbox.sh check     # versions, and bwrap can start a sandbox
#
# With CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, Claude Code on Linux runs every Bash command a
# session starts inside bubblewrap (bwrap: a new user and PID namespace, the filesystem
# read-only but for the working folder and a few others), and needs socat as well. Without
# them a session stops before its first turn ("bubblewrap is required for subprocess env
# scrubbing and isolation", then "Sandbox is required but failed to initialize ... socat
# not installed"). macOS has its own sandbox built in, so this script is for Linux only.
#
# Versions: the upstream ones Ubuntu 24.04 ships, pinned. The Ubuntu revision after the
# dash may move: the archive keeps only the newest security update, so an exact pin would
# stop every session the day one is published.
#
# AppArmor: Ubuntu 24.04 runners set kernel.apparmor_restrict_unprivileged_userns=1, so an
# unconfined program gets no capabilities in a user namespace it creates and bwrap can't
# build its sandbox. Ubuntu's documented fix is a profile that grants `userns` to that one
# program; this loads one for /usr/bin/bwrap only, and leaves the restriction on for
# everything else. Used by ci.yml and by each session job of oncall.yml.
set -euo pipefail

BWRAP_VERSION=0.9.0
SOCAT_VERSION=1.8.0.0
PROFILE=/etc/apparmor.d/oncall-bwrap
RESTRICT=/proc/sys/kernel/apparmor_restrict_unprivileged_userns

smoke() {
  # The namespaces Claude Code's sandbox asks for (user, PID, a fresh /proc).
  bwrap --new-session --die-with-parent --ro-bind / / --dev /dev --unshare-user \
    --unshare-pid --proc /proc -- /bin/true
}

check() {
  local bwrap socat
  bwrap=$(bwrap --version)
  socat=$(socat -V 2>/dev/null | sed -n 's/^socat version \([^ ]*\).*/\1/p')
  [[ $bwrap == "bubblewrap $BWRAP_VERSION" ]] || { echo "::error title=Sandbox::found $bwrap, want bubblewrap $BWRAP_VERSION"; exit 1; }
  [[ $socat == "$SOCAT_VERSION" ]] || { echo "::error title=Sandbox::found socat ${socat:-none}, want $SOCAT_VERSION"; exit 1; }
  if ! smoke; then
    echo "::error title=Sandbox::bwrap can't start a sandbox here (userns restriction: $(cat "$RESTRICT" 2> /dev/null || echo n/a))"
    exit 1
  fi
  echo "sandbox ok: $bwrap, socat $socat, userns restriction $(cat "$RESTRICT" 2> /dev/null || echo n/a)"
}

case ${1:-} in
  install)
    [[ $(uname -s) == Linux ]] || { echo "Linux only: macOS has its own sandbox" >&2; exit 2; }
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      "bubblewrap=$BWRAP_VERSION-*" "socat=$SOCAT_VERSION-*"
    if [[ $(cat "$RESTRICT" 2> /dev/null || echo 0) == 1 ]] && ! smoke 2> /dev/null; then
      sudo tee "$PROFILE" > /dev/null << 'EOF'
abi <abi/4.0>,
include <tunables/global>

profile oncall-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
EOF
      sudo apparmor_parser --replace "$PROFILE"
    fi
    check
    ;;
  check) check ;;
  *)
    echo "usage: $0 install|check" >&2
    exit 2
    ;;
esac
