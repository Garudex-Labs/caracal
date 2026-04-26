---
description: "Use when creating or editing any source file. Enforces the mandatory copyright header format for all files."
applyTo: "**"
---
# File Header

- Applies to every source file in the codebase.

## Required

- Every source file must begin with this exact header (adapted to the file's comment syntax):
  ```
  Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
  Caracal, a product of Garudex Labs

  {One short, clear one-line description of the file}
  ```
- The description must be a single sentence — concise and direct.
- Describe what the file *is*.
- Preserve exact spacing: two spaces after `All Rights Reserved.`
- Include the blank line between the copyright block and the description.
- Adapt the comment syntax to match the file's language (e.g., `"""` for Python, `//` for JS/TS).

## Forbidden

- Must not omit the header from any source file.
- Must not add metadata, version notes, or author lines inside the header block.
- Must not add blank lines inside the copyright block itself.
- Must not describe what was changed or why the file exists.