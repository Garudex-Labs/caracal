# docs

## Scope
- Covers the Astro Starlight documentation site under `docs/`.

## Architecture Design
- `src/content/docs/` owns the unreleased documentation source and release-generated minor snapshots.
- `versions.json` owns the documentation release target, current stable minor, and snapshot locks.
- `src/pages/` owns generated indexes and LLM-facing text endpoints.
- `src/components/`, `src/styles/`, `src/data/`, `public/`, and `assets/` support the site shell.

## Required
- Must keep documentation aligned with current package names, service ports, APIs, and release artifacts.
- Must write concise agent-useful pages; link to source-owned behavior instead of copying implementation detail.
- Must keep generated `dist/` and `.astro/` output out of authored guidance.
- Must use the Starlight content structure already configured in `astro.config.mjs`.
- Must edit unversioned pages before the first documentation release and for the next unreleased minor afterward.
- Must apply patch-release documentation updates to the unlocked `src/content/docs/vX.Y/` current stable snapshot.
- Must create snapshots only through `scripts/docsVersion.mjs` as part of a stable minor release.
- Must append every new FAQ entry to the bottom of the FAQ list so existing FAQ numbers and shared FAQ URLs remain stable.

## Forbidden
- Must not document speculative features, deprecated plans, or enterprise-only behavior as OSS behavior.
- Must not place source code or tests in this directory.
- Must not edit generated documentation output by hand.
- Must not edit a snapshot marked `locked` in `versions.json` or replace its digest.
- Must not create documentation snapshots for release candidates or patch releases.

## Validation
- Validate documentation structure and snapshot locks with `pnpm --dir docs build` when authored docs or site config changes.
