# releases

## Scope
- Covers release metadata and validation artifacts under `releases/`.

## Architecture Design
- Each release tag has one `vX.Y.Z` directory; rc trains use `vX.Y.Z-rc.N`.
- `manifest.json` records the exact published artifact versions.
- Release evidence lives in `docs/src/data/releases/<tag>.json`, generated from the manifest by `scripts/generateReleaseRecord.mjs` during release prep and rendered on the docs Releases page.

## Required
- Must keep one manifest per release directory.
- Must keep all package, binary, container, and helm versions equal to the release tag without the leading `v` (PyPI uses the PEP 440 form of the same version).
- Must generate release records through `scripts/generateReleaseRecord.mjs`.

## Forbidden
- Must not edit a published manifest in place after release.
- Must not hand-edit generated release records under `docs/src/data/releases/`.
- Must not store generated validation output, secrets, signing keys, unpublished artifacts, or narrative release notes here.

## Validation
- Validate release entries by comparing the manifest to published registries and the docs release records.

