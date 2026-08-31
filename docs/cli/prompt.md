<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `caracal registry prompt`

Manage reusable prompt templates in the Registry. Prompts can be submitted, listed, rendered, edited, archived, restored, transferred, and shared with co-authors. Standalone prompt installation has been removed; attach prompts to agents instead.

## Commands

| Command | Description |
| --- | --- |
| `submit` | Submit a prompt or save a draft |
| `list` | List approved visible prompts |
| `my` | List your prompts across all statuses |
| `show` | Show one prompt and its template |
| `render` | Render a prompt with variables |
| `edit` | Edit a draft, pending, or rejected prompt |
| `archive` | Archive an approved prompt |
| `unarchive` | Restore an archived prompt |
| `transfer-owner` | Transfer ownership |
| `co-authors` | List, add, or remove co-authors |

All structured commands support table and JSON output.

## Submit

```bash
caracal registry prompt submit \
  --name review \
  --description "Review code" \
  --category code-review \
  --template "Review {{code}}" \
  --output json

caracal registry prompt submit --from-file prompt.json --output json
caracal registry prompt submit --submit acme/review --output json
```

JSON mode never prompts. A plain template file requires explicit name, description, and category options. A JSON file may contain the complete payload.

Recommended categories are `general`, `code-review`, `code-generation`, `debugging`, `documentation`, and `testing`. You may also supply a custom category: any value is normalized to a slug (lowercase letters, digits, and hyphens, up to 32 characters), so `Code Review`, `code_review`, and `code-review` all resolve to the same stored value. The server normalizes and remains authoritative.

## List and show

```bash
caracal registry prompt list --category code-review --output json
caracal registry prompt my --output json
caracal registry prompt show acme/review --output json
```

Row numbers are scoped to the latest Prompt list. Empty Prompt lists clear previous Prompt row references. Human output escapes template text so bracketed content is rendered literally.

## Render

```bash
caracal registry prompt render acme/review --var code=main.py --output json
```

Every variable must use `key=value` syntax with a non-empty key. JSON returns the direct server result. Human output prints the rendered prompt as literal text.

## Edit

```bash
caracal registry prompt edit acme/review --description "Updated" --output json
caracal registry prompt edit acme/review --from-file updates.json --output json
```

Invalid categories, versions, files, and edit-lock conflicts preserve their shared error category and stable exit code.

## Agent usage

Prompts are agent components rather than standalone harness installations:

```bash
caracal agent add prompt <prompt-uuid>
caracal agent build
```

## Related

* [`caracal registry`](registry.md): complete Registry reference
* [`caracal agent`](agent.md): compose and publish agents
