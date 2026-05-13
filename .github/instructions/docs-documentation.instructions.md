---
description: "Use when writing, editing, or reviewing Caracal documentation under caracal/docs/. Enforces production-grade technical writing, page-flow awareness, and scoped coherent docs edits."
applyTo: "caracal/docs/**"
---

# Documentation Quality

- Applies only to the Caracal documentation site under `caracal/docs/`, including MDX content, Astro and Starlight configuration, components, data, pages, styles, and public docs assets.

## Required

- Must treat all documentation as production-grade technical documentation for Caracal users, operators, contributors, and integrators.
- Must understand the docs structure before editing, including `astro.config.mjs` sidebar order, `src/content/docs/` page groups, shared components, generated pages, data files, styles, and public assets affected by the change.
- Must preserve the flow, tone, audience, and purpose of each page.
- Must edit the complete affected page or section coherently when updates are needed.
- Must keep titles, descriptions, headings, links, examples, and cross-references consistent with the surrounding section and sidebar journey.
- Must keep changes scoped to the affected pages, sections, navigation entries, components, data files, styles, and assets required for a coherent documentation update.
- Must keep documentation professional, clear, structurally consistent, and naturally integrated.
- Must use comments only when they explain documentation intent or structure.

## Forbidden

- Must not add or remove text in a way that breaks a page's narrative, section continuity, or reader journey.
- Must not use meta language about edits, removed text, prompt phases, implementation history, or task history.
- Must not make patchwork edits that read as isolated insertions.
- Must not spread edits across unrelated docs files when a focused page or section update is enough.
- Must not change docs organization, navigation, or page purpose without updating affected pages and configuration coherently.
- Must not add comments that restate content or describe editing activity.