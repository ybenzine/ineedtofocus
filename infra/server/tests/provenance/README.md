# Recorded attestations (#177)

Real images' manifests and their build provenance attestations, as ghcr.io served them, for the `make test-server` provenance tests (`focus_ci.sh`). `fake_registry.py` serves them to the real `cosign`, which checks them against the pinned Sigstore trusted root, so the tests verify real signatures offline. Each directory holds `image.json`, `referrers.json`, `attestation.json` and `bundle.json` (see `record.sh`). The files are byte-exact: their sha256 is their address, so never reformat them.

| Directory | Image | Signer (certificate SAN) | Commit | Used for |
|---|---|---|---|---|
| `ineedtofocus` | `ghcr.io/ybenzine/ineedtofocus@sha256:0ce366d5…`, `publish`'s image of `main`'s `15b5ce8` (#376) | `https://github.com/ybenzine/ineedtofocus/.github/workflows/ci.yml@refs/heads/main` | `15b5ce8891f2787d016a61beda9312ed00f2837d` | The attested release that deploys; a wrong sha; the attestation moved onto other bytes |
| `voyager` | `ghcr.io/aeharding/voyager:2.49.1` | `https://github.com/aeharding/voyager/.github/workflows/docker.yml@refs/tags/2.49.1` | `05d74220b142f9409579ca52c72cb36edab7cbd9` | Another workflow on another ref |
| `photofield` | `ghcr.io/smilyorg/photofield:v0.24.1-58-g6b820bd` | `https://github.com/SmilyOrg/photofield/.github/workflows/ci.yml@refs/heads/main` | `6b820bd8c854c50db47125f908713162e22da88c` | Another repository's `ci.yml` on `refs/heads/main` |

All three were signed on the public-good Sigstore instance (Fulcio, Rekor v1) and recorded on 2026-10-30. The other repositories' files are public signatures and metadata, recorded only so the tests have real certificates for signers other than ours: an attestation by another workflow or ref of this repository can't be made without adding a workflow that may sign, which `scripts/tests/test_ci_workflow.py` forbids.

They stay verifiable as long as the pinned trusted root (`TRUSTED_ROOT_SHA256` in `infra/server/bootstrap.sh`) keeps the keys they were signed with. Sigstore keeps old keys in it, with their validity periods, so a newer trusted root still verifies them. If a bump ever drops one, record a newer image:

```bash
infra/server/tests/provenance/record.sh ybenzine/ineedtofocus <commit sha on main> infra/server/tests/provenance/ineedtofocus
```

Then update the commit, digest and SAN in this table and in `focus_ci.sh` (`T_OURS`, `VOY_SHA`, `PHOTO_SHA` and the digest sanity check).
