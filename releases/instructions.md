# Releases

## Scope
- Only release metadata that pins every Caracal artifact to a single GitHub release tag, plus the post-release validation report for that tag.

## Required
- One directory per release tag, named exactly `vYYYY.MM.DD` (with `.N` suffix on same-day re-cuts).
- Each directory must contain exactly one `manifest.json`, exactly one `validation.md`, and a `findings/` sub-directory holding the raw JSONL findings copied by `aggregateReport.ts`.
- All release metadata for a tag lives in that directory and nowhere else.
- `manifest.json` must list `release`, `publishedAt`, `binaries` (cli, tui), `containers`, `pypi`, and `npm` with every published artifact mapped to its version string. It may optionally set `registry` and `imagePrefix` (defaults: `ghcr.io/garudex-labs`, `caracal-`).
- Container versions and binary versions must equal the CalVer release tag without the leading `v`.
- PyPI and npm versions must equal the semver string actually published to each registry.
- `validation.md` and `findings/*.jsonl` must be produced only by `caracal/scripts/postRelease/aggregateReport.ts`.
- Every release cut must add `manifest.json` in the same commit as the changeset version bump; `validation.md` and `findings/` land later via the post-release workflow PR.

## Forbidden
- Must not edit a published `manifest.json` after the release lands; cut a new tag instead.
- Must not hand-edit `validation.md` or the `findings/` JSONL; rerun the workflow.
- Must not omit artifacts that were published under the release tag.
- Must not publish floating `latest` or `dryrun` container tags; only pinned CalVer tags (`v<calver>` and `v<MajorMinor>`) ship to GHCR.
- Must not store secrets, signing keys, or narrative release notes here.
