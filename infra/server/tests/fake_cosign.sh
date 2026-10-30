#!/usr/bin/env bash
# Fake cosign for focus_ci.sh (#177): installed, root-owned, as /opt/focus/sigstore/cosign
# in the throwaway test container, in place of the real one bootstrap.sh installed. Like
# fake_docker.sh, it appends every call to /tmp/fake-docker/calls.log, with the names of
# the environment variables it got:
#
#   <epoch> uid=<uid> env=<names> app_tag=<APP_TAG> :: cosign <args>
#
# so the ordering checks see it among the docker calls. State, in /tmp/fake-docker:
#
#   cosign-real        while it exists: log, then run the real cosign it names (the one
#                      bootstrap.sh installed, moved aside). The recorded-bundle tests
#                      use that, against fake_registry.py
#   attested/<digest>  otherwise, the commit that digest's attestation says it was built
#                      from (empty: no attestation). Without the file, labels/<digest>,
#                      as `publish` attests what it built; without either, none
#   fail/cosign        the tool fails (status 1, an error that isn't a verdict)
#   probe-lock         while it exists, each call appends to cosign-lock-probe.log
#                      whether /opt/focus/deploy.lock was held
#
# Otherwise it answers like `cosign verify-attestation`: status 0, the statement on
# stdout and "Verification for ..." on stderr when the attestation names the commit in
# --certificate-github-workflow-sha; status 1 and cosign's error on stderr when not.
set -euo pipefail

state=/tmp/fake-docker
names=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' |
  grep -vxE 'PWD|SHLVL|_|OLDPWD' | sort | paste -sd, -)
printf '%s uid=%s env=%s app_tag=%s :: cosign %s\n' "$(date +%s.%N)" "$(id -u)" "$names" \
  "${APP_TAG:--}" "$*" >>"$state/calls.log"
ref=${*: -1}
if [[ -e $state/probe-lock ]]; then
  if flock -n /opt/focus/deploy.lock true; then held=free; else held=held; fi
  echo "cosign $ref lock=$held" >>"$state/cosign-lock-probe.log"
fi

if [[ -f $state/cosign-real ]]; then
  exec "$(cat "$state/cosign-real")" "$@"
fi

if [[ ${1:-} != verify-attestation ]]; then
  echo "fake cosign: unexpected call: $*" >&2
  exit 1
fi
if [[ -e $state/fail/cosign ]]; then
  echo "Error: fake cosign: the tool failed" >&2
  exit 1
fi
args=("$@")
sha=""
for ((i = 0; i + 1 < ${#args[@]}; i++)); do
  [[ ${args[i]} != --certificate-github-workflow-sha ]] || sha=${args[i + 1]}
done
digest=${ref#*@}
built=""
if [[ -f $state/attested/$digest ]]; then
  built=$(cat "$state/attested/$digest")
elif [[ -f $state/labels/$digest ]]; then
  built=$(cat "$state/labels/$digest")
fi
if [[ -z $built ]]; then
  echo "Error: no matching attestations: " >&2
  exit 1
fi
if [[ $built != "$sha" ]]; then
  echo "Error: no matching attestations: failed to verify certificate identity: no matching CertificateIdentity found, last error: expected GithubWorkflowSHA to be \"$sha\", got \"$built\"" >&2
  exit 1
fi
echo '{"payloadType":"application/vnd.in-toto+json","payload":"","signatures":[]}'
echo "Verification for $ref --" >&2
