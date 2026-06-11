# docs

## Scope
- Covers the Astro Starlight documentation site under `docs/`.

## Architecture Design
- `src/content/docs/` owns documentation pages.
- `src/pages/` owns generated indexes and LLM-facing text endpoints.
- `src/components/`, `src/styles/`, `src/data/`, `public/`, and `assets/` support the site shell.

## Required
- Must keep documentation aligned with current package names, service ports, APIs, and release artifacts.
- Must write concise agent-useful pages; link to source-owned behavior instead of copying implementation detail.
- Must keep generated `dist/` and `.astro/` output out of authored guidance.
- Must use the Starlight content structure already configured in `astro.config.mjs`.
- Must append every new FAQ entry to the bottom of the FAQ list so existing FAQ numbers and shared FAQ URLs remain stable.

## Forbidden
- Must not document speculative features, deprecated plans, or enterprise-only behavior as OSS behavior.
- Must not place source code or tests in this directory.
- Must not edit generated documentation output by hand.

## Validation
- Validate documentation structure with `pnpm --dir docs build` when authored docs or site config changes.
