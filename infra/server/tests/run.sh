#!/usr/bin/env bash
# Test the server side in a fresh Ubuntu 24.04 container (`make test-server`; needs
# Docker and network access):
#
#   in_container.sh  infra/server/bootstrap.sh (#25): run it, check the result (including
#                    real SSH logins against the hardened sshd), run it again and check
#                    that nothing changed, then check that a failing write stops it.
#   focus_ci.sh      then, on that bootstrapped server: infra/server/install.sh and the
#                    forced command focus-ci (#28-#30: the dev, prod and rollback-prod
#                    profiles, the automatic revert with deliberately broken images,
#                    rollback) behind the real sshd, with a fake docker CLI that records
#                    every call.
#
# A container has no systemd, so bootstrap.sh skips service management there; everything
# else (packages, Docker's apt repo, users, sshd config, files and permissions) is the
# same as on the Droplet.
#
# This runs in the required "Backend unit tests" check, so it must not turn red on its
# own (#80): the image is pinned by digest, so a new ubuntu:24.04 build can't change it,
# and the network steps retry (the image pull here, apt inside the container).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
infra_dir=$(dirname "$(dirname "$here")")

# ubuntu:24.04's multi-platform index digest, read on 2026-10-25. To bump it, read the
# `Digest:` line at the top of
#   docker buildx imagetools inspect ubuntu:24.04
# and replace it here in its own PR; `make test-server` then runs on the new image.
# UBUNTU_IMAGE overrides it. A tag is used as it is locally if it's already there (the run
# is --pull never), so to try the latest build, `docker pull ubuntu:24.04` first and then
# run with UBUNTU_IMAGE=ubuntu:24.04.
image=${UBUNTU_IMAGE:-ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac}

# Retries for a short registry outage: 4 attempts, 5, 10 then 20 s apart (about 35 s of
# waiting at most), then fail with the last error.
pull_attempts=4
if ! docker image inspect "$image" >/dev/null 2>&1; then
  delay=5
  for ((attempt = 1; ; attempt++)); do
    if docker pull --quiet "$image"; then
      break
    fi
    if ((attempt >= pull_attempts)); then
      echo "ERROR: couldn't pull $image after $pull_attempts attempts" >&2
      exit 1
    fi
    echo "pulling $image failed (attempt $attempt of $pull_attempts); retrying in ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
fi

# apt inside the container (bootstrap.sh's apt-get, Docker's repo, focus_ci.sh's git)
# retries a failed download 5 times with apt's backoff. Test-only: bootstrap.sh leaves the
# Droplet's apt defaults alone.
apt_retries='Acquire::Retries "5";'

docker run --rm --pull never \
  -v "$infra_dir:/src:ro" \
  -e "APT_RETRIES=$apt_retries" \
  "$image" bash -c '
    set -euo pipefail
    printf "%s\n" "$APT_RETRIES" >/etc/apt/apt.conf.d/80focus-test-retries
    bash /src/server/tests/in_container.sh
    bash /src/server/tests/focus_ci.sh
  '
