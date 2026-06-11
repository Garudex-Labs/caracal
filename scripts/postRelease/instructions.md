# scripts/postRelease

## Scope
- Covers post-release validation scripts under `scripts/postRelease/`.

## Architecture Design
- Each validation script checks already-published artifacts and emits JSONL findings.
- `aggregateReport.ts` converts findings into the release record at `docs/src/data/releases/<tag>.json`.
- `lib/common.sh` owns shared finding and filtering helpers.

## Required
- Must source `lib/common.sh` from shell validators.
- Must honor `DRY_RUN=1` and the `ONLY` filter.
- Must emit findings through `logFinding`; the orchestrator decides final status.
- Must validate published binaries, containers, registry metadata, provenance, installers, npm, and PyPI without rebuilding local artifacts.

## Forbidden
- Must not consume secrets beyond tokens explicitly provided by release workflows.
- Must not mutate the working tree outside findings output or temporary scratch directories.
- Must not treat local build artifacts as release evidence.

## Validation
- Validate with the touched post-release script in `DRY_RUN=1` mode when possible.
