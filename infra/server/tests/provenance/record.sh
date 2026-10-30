#!/usr/bin/env bash
# Record an attested image from ghcr.io for the build provenance tests (#177):
#
#   infra/server/tests/provenance/record.sh <owner/name> <tag or sha256:digest> <directory>
#
# Writes the exact bytes ghcr.io serves (an anonymous pull, no token of ours) into
# <directory>: image.json (the image's manifest or index), referrers.json (the index at
# its sha256-<hex> tag, where actions/attest-build-provenance's push-to-registry puts the
# attestation, since ghcr.io has no referrers API), attestation.json (the Sigstore
# bundle's manifest) and bundle.json (the bundle). fake_registry.py serves them by their
# sha256, so they must stay byte for byte as recorded (no reformatting, no final newline
# added: .pre-commit-config.yaml and .gitattributes leave this directory alone). Prints
# each attestation's signer (the certificate's SAN). Needs curl, jq and openssl.
set -euo pipefail

(($# == 3)) || {
  echo "usage: $0 <owner/name on ghcr.io> <tag or sha256:digest> <directory>" >&2
  exit 2
}
repo=$1 ref=$2 out=$3
bundle_type=application/vnd.dev.sigstore.bundle.v0.3+json
accept=application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json
accept+=,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json
token=$(curl -fsS "https://ghcr.io/token?scope=repository:${repo}:pull" | jq -r .token)
get() { curl -fsS -H "Authorization: Bearer $token" -H "Accept: $accept" "$@"; }
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

mkdir -p "$out"
get -o "$out/image.json" "https://ghcr.io/v2/${repo}/manifests/${ref}"
digest=sha256:$(sha256_of "$out/image.json")
echo "image: $repo@$digest"
get -o "$out/referrers.json" "https://ghcr.io/v2/${repo}/manifests/sha256-${digest#sha256:}"
attestation=$(jq -r --arg t "$bundle_type" '[.manifests[] | select(.artifactType == $t) | .digest][0] // empty' "$out/referrers.json")
[[ -n $attestation ]] || {
  echo "no Sigstore bundle among $repo@$digest's referrers" >&2
  exit 1
}
get -o "$out/attestation.json" "https://ghcr.io/v2/${repo}/manifests/${attestation}"
blob=$(jq -r '.layers[0].digest' "$out/attestation.json")
curl -fsSL -H "Authorization: Bearer $token" -o "$out/bundle.json" "https://ghcr.io/v2/${repo}/blobs/${blob}"
[[ sha256:$(sha256_of "$out/bundle.json") == "$blob" ]] || {
  echo "the bundle's sha256 isn't $blob" >&2
  exit 1
}
jq -r '.verificationMaterial.certificate.rawBytes' "$out/bundle.json" | base64 -d |
  openssl x509 -inform der -noout -ext subjectAltName
jq -r '.dsseEnvelope.payload' "$out/bundle.json" | base64 -d |
  jq -r '"commit: " + .predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit'
