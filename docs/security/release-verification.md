<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Verify an Caracal release

Caracal release artifacts have GitHub keyless Sigstore provenance attestations. Release tags created after this policy was introduced are signed separately with gitsign. These checks prove different things:

* Artifact verification binds a downloaded file and its SHA-256 digest to the Caracal release workflow.
* Tag verification binds a Git tag to the same GitHub Actions workflow identity.

Historical tags may be unsigned. Never treat an artifact checksum alone as proof of origin.

## Download the release

Replace `v1.0.0` with the release you want to verify:

```bash
gh release download v1.0.0 --repo Garudex-Labs/caracal --dir caracal-release
cd caracal-release
```

## Check the downloaded bytes

The release includes `checksums.txt`:

```bash
sha256sum --check checksums.txt
```

On macOS, use `shasum -a 256 --check checksums.txt`.

## Verify artifact provenance

Install the [GitHub CLI](https://cli.github.com/) and verify each artifact you intend to run:

```bash
gh attestation verify ./caracal-linux-x64 \
  --repo Garudex-Labs/caracal \
  --bundle ./build-provenance.intoto.jsonl \
  --signer-workflow Garudex-Labs/caracal/.github/workflows/release.yml@refs/heads/main
```

Use the downloaded server archive or another CLI binary in place of `caracal-linux-x64`. A successful result verifies the artifact digest, Sigstore certificate chain, source repository, and release workflow identity.

GitHub keyless signing uses short-lived credentials issued to the workflow. Caracal has no long-lived release private key stored on GitHub Releases or another download site.

## Verify a release tag

Install [gitsign](https://github.com/sigstore/gitsign), clone the repository, and fetch the tag:

```bash
git clone https://github.com/Garudex-Labs/caracal.git
cd caracal
git fetch origin tag v1.0.0
gitsign verify-tag v1.0.0 \
  --certificate-identity https://github.com/Garudex-Labs/caracal/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The expected Fulcio certificate identity is the release workflow on `refs/heads/main`. The expected OIDC issuer is GitHub Actions. Verification also checks the signature's transparency-log evidence.

A signed tag does not replace artifact provenance verification. Verify both when establishing the source commit and the exact downloaded bytes matters.
