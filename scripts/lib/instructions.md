# scripts/lib

## Scope
- Covers shared helper modules under `scripts/lib/` for shell and Node automation.

## Architecture Design
- Helpers provide reusable Console style and selection primitives for root automation scripts.
- `stamp.mjs` is the single writer that propagates `release.config.json` versions into package and Helm files.
- `releaseSpec.mjs` is the single source for release repo identity, tag and digest patterns, registry defaults, image and chart references, run-name formats, and atomic JSON writes.
- `oci.mjs` is the single source for image and chart inspection with transient-failure retries.

## Required
- Must keep shell helpers sourceable by POSIX-compatible scripts that opt into them.
- Must keep `stamp.mjs` the only module that mutates artifact versions; consumers diff via `computeStamp` and write via `applyStamp`.
- Must import release patterns, registry defaults, and run-name formats from `releaseSpec.mjs` instead of redefining them.
- Must route OCI inspections through `oci.mjs` instead of invoking `docker buildx imagetools` or `helm show` directly.
- Must keep function names short, explicit, and non-conflicting with shell builtins.
- Must avoid side effects at source or import time except defining constants and functions.

## Forbidden
- Must not execute release, publish, test, or validation workflows directly.
- Must not read secrets or mutate the working tree outside `applyStamp`.
- Must not introduce stateful globals beyond presentation constants.

## Validation
- Validate shell helpers with `bash -n` on touched files and scripts that source them.
- Validate `stamp.mjs` via `node scripts/release.mjs stamp --check` from the repository root.

