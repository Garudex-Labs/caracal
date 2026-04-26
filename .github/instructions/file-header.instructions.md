---
description: "Use when creating or editing any source file. Enforces the mandatory copyright header format for all files."
applyTo: "**"
---
# File Header

Every source file must begin with this exact header:

```python
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

{One short, clear one-line description of the file}
"""
```

## Rules

- The header is mandatory. Never omit it.
- The description line must be a single sentence — concise and direct.
- Describe what the file *is*, not what was changed or why it exists.
- No extra metadata, version notes, author lines, or blank lines inside the block.
- Preserve the exact spacing: two spaces after "All Rights Reserved." before closing the sentence.
- The blank line between the copyright block and the description is required.
- The format should match the language the file is written in.