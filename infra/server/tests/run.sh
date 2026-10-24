#!/usr/bin/env bash
# Test the server side in a fresh Ubuntu 24.04 container (`make test-server`; needs
# Docker and network access):
#
#   in_container.sh  infra/server/bootstrap.sh (#25): run it, check the result (including
#                    real SSH logins against the hardened sshd), run it again and check
#                    that nothing changed.
#   focus_ci.sh      then, on that bootstrapped server: infra/server/install.sh and the
#                    forced command focus-ci (#28-#30: the dev, prod and rollback-prod
#                    profiles, the automatic revert with deliberately broken images,
#                    rollback) behind the real sshd, with a fake docker CLI that records
#                    every call.
#
# A container has no systemd, so bootstrap.sh skips service management there; everything
# else (packages, Docker's apt repo, users, sshd config, files and permissions) is the
# same as on the Droplet.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
infra_dir=$(dirname "$(dirname "$here")")
image=${UBUNTU_IMAGE:-ubuntu:24.04}

docker run --rm --pull missing \
  -v "$infra_dir:/src:ro" \
  "$image" bash -c 'bash /src/server/tests/in_container.sh && bash /src/server/tests/focus_ci.sh'
