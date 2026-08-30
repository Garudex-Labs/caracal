<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Discovery and installation

## Contents

- Search and inspect
- Personalized recommendations
- Install components
- Verification

## Search and inspect

Start broad with natural-language search, then narrow only when needed.

```bash
caracal registry mcp list --search 'github docker' --output json
caracal registry mcp list --category developer-tools --output json
caracal registry skill list --search 'frontend design' --harness claude-code --output json
caracal registry skill list --team platform-tools --output json
caracal registry hook list --event UserPromptSubmit --output json
caracal registry prompt list --category code-generation --output json
caracal registry sandbox list --runtime docker --output json
caracal registry models --harness kiro --output json
```

Summarize matches by `qualified_name`, description, version, supported harnesses, and why they match the request. If no result appears, retry once with fewer keywords.

Inspect a selected component with its canonical identity:

```bash
caracal registry mcp show NAMESPACE/SLUG --output json
caracal registry skill show NAMESPACE/SLUG --output json
caracal registry hook show NAMESPACE/SLUG --output json
caracal registry prompt show NAMESPACE/SLUG --output json
caracal registry sandbox show NAMESPACE/SLUG --output json
```

## Personalized recommendations

Use recommendations for open-ended requests such as "what should I install?" or "what am I missing?"

```bash
caracal registry recommend --output json
caracal registry recommend --limit 12 --type mcp --refresh --output json
```

Interpret fields precisely:

- `personalized: true`: ranked from this user's sessions.
- `personalized: false`: popularity fallback because no usable personal profile exists.
- Low `profile_sessions`: answer, but say evidence is thin.
- Empty `items`: successful result, not an error.
- `items[].reason`: quote or summarize this reason without inventing another.

Dismiss only after user confirmation because the preference is durable:

```bash
caracal registry recommend dismiss skill NAMESPACE/SLUG --action not_relevant --output json
```

## Install components

Choose the exact harness and scope before writing files.

```bash
caracal registry mcp install NAMESPACE/SLUG --harness kiro --no-prompt --output json
caracal registry mcp install NAMESPACE/SLUG --harness cursor --version 2.1.0 --no-prompt --output json
caracal registry skill install NAMESPACE/SLUG --harness claude-code --scope project --output json
caracal registry skill install NAMESPACE/SLUG --harness kiro --scope user --version 1.2.0 --output json
caracal registry hook install NAMESPACE/SLUG --harness kiro --output json
caracal registry hook install NAMESPACE/SLUG --harness claude-code --platform darwin --dir . --output json
```

Use raw output only when the user explicitly asks for a config snippet or raw response:

```bash
caracal registry mcp install NAMESPACE/SLUG --harness claude-code --raw
```

Never combine raw and JSON modes. Never print supplied environment or header values.

## Verification

Inspect returned files, setup instructions, warnings, and version. For harness writes, verify with:

```bash
caracal scan --harness kiro --output json
```

If installation reports a failed setup command or file write, report partial failure rather than success.
