#!/usr/bin/env bash
# Test infra/server/bootstrap.sh (#25) in a fresh Ubuntu 24.04 container: run it, check
# the result (including real SSH logins against the hardened sshd), run it again and
# check that nothing changed. `make test-server`; needs Docker and network access.
#
# A container has no systemd, so the script skips service management there; everything
# else (packages, Docker's apt repo, users, sshd config, files and permissions) is the
# same as on the Droplet.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
server_dir=$(dirname "$here")
image=${UBUNTU_IMAGE:-ubuntu:24.04}

docker run --rm --pull missing \
  -v "$server_dir:/src:ro" \
  "$image" bash /src/tests/in_container.sh
