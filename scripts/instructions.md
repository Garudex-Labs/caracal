# scripts

## Scope
- Covers repository-level automation under `scripts/`.

## Architecture Design
- Root scripts orchestrate release, publish, and CI workflows.
- Shared shell presentation and selection helpers live under `scripts/lib/`.
- Release identity, tag patterns, registry defaults, and run-name contracts live only in `scripts/lib/releaseSpec.mjs`.
- Release provenance verification lives only in `scripts/verifyAttestation.mjs`; workflows must call it instead of inlining `gh attestation` checks.
- Workflow invariants are enforced by `scripts/validateWorkflows.mjs`; it must pass before any workflow change merges.
- Release records for the docs Releases page are generated from manifests by `scripts/generateReleaseRecord.mjs`.
- Documentation minor snapshots and immutable digests are managed by `scripts/docsVersion.mjs`.

## Required
- Must keep scripts executable, fail-fast, and runnable from the repository root.
- Must reuse `pnpm`, Go, Python, and package-manager commands already declared by the workspace.
- Must keep release and publish scripts deterministic and registry-explicit.
- Must create documentation snapshots only for stable `X.Y.0` releases and leave stable patch releases on the current minor.

## Forbidden
- Must not embed secrets, tokens, or registry credentials.
- Must not duplicate complex package logic that belongs in package scripts.
- Must not stage unrelated working-tree changes from release automation.

## Validation
- Validate touched scripts with shell syntax checks and the narrow workflow command they wrap.

