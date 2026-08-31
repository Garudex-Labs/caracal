<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent workflows

## Contents

- Discover and inspect
- Pull and verify
- Direct create
- Local authoring
- Update in place
- Release a version
- Bulk create
- Lifecycle and collaboration
- Error decisions

## Discover and inspect

```bash
caracal agent list --search 'incident resolution' --output json
caracal agent list --namespace platform-tools --output json
caracal agent show NAMESPACE/AGENT_SLUG --output json
caracal agent versions NAMESPACE/AGENT_SLUG --output json
```

Use `qualified_name` or UUID from JSON for later commands. Do not use displayed row numbers.

Before choosing a model, query models for every selected harness:

```bash
caracal registry models --harness kiro --output json
caracal registry models --harness claude-code --output json
```

Use an exact returned model name.

## Pull and verify

```bash
caracal agent pull NAMESPACE/AGENT_SLUG --harness kiro --no-prompt --dir . --output json
caracal agent pull NAMESPACE/AGENT_SLUG --harness claude-code --scope project --dry-run --no-prompt --output json
```

JSON pull requires `--no-prompt` and is appropriate only when no secret values are required. The `--env` and `--header` options expose values in shell history and process arguments, so use them only for non-secret configuration.

For credentials or tokens, omit `--no-prompt` and JSON output, then enter values through the interactive prompts. This keeps values out of process arguments. Treat generated harness configuration as sensitive because the harness may store those values.

Inspect `files`, `warnings`, `setup_commands`, and lockfile results. Then verify installation:

```bash
caracal scan --harness kiro --output json
```

For Pi, use the exact local profile name returned by pull with the harness profile command.

## Local authoring

Use this workflow when the Agent needs component references, review before publication, or repeatable source files.

1. Scaffold:

```bash
caracal agent init --dir ./my-agent --name reviewer --description 'Reviews pull requests' --prompt-file ./PROMPT.md --model claude-sonnet-4-6 --harness kiro --output json
```

2. Find components and add returned UUIDs:

```bash
caracal registry mcp list --search 'github' --output json
caracal registry skill list --search 'code review' --output json
caracal agent add mcp COMPONENT_UUID --dir ./my-agent --output json
caracal agent add skill COMPONENT_UUID --dir ./my-agent --output json
```

3. Validate, then publish:

```bash
caracal agent build --dir ./my-agent --output json
caracal agent publish --dir ./my-agent --output json
```

Use `--draft` to save without review and `--submit AGENT_UUID` to submit an existing draft. Project visibility uses the active Organization/Project context selected with `caracal use`:

```bash
caracal agent publish --dir ./my-agent --visibility project --output json
caracal agent publish --dir ./my-agent --visibility private --output json
```

## Update in place

Use only when the user wants to change the current listing without a reviewed version.

1. Read current state with `agent show`.
2. Preserve required fields in `caracal-agent.yaml`, including `model_config_json: {}` and `external_mcps: []`.
3. Build before mutation.
4. Publish update and verify.

```bash
caracal agent build --dir ./my-agent --output json
caracal agent publish --update --dir ./my-agent --output json
caracal agent show NAMESPACE/AGENT_SLUG --output json
```

## Release a version

Use when the user asks for a patch, minor, major, release, or reviewed version.

```bash
caracal agent release NAMESPACE/AGENT_SLUG --bump patch --dir ./my-agent --output json
caracal agent versions NAMESPACE/AGENT_SLUG --output json
```

The YAML must include all required fields. Report the returned review status and version. A submitted release is not approved until review says so.

## Lifecycle and collaboration

Archiving, ownership transfer, and co-author management for agents live
in the web UI, not the CLI. Verify ownership and lifecycle state with
`agent show`.

## Error decisions

- 409 ambiguous name: re-list and use `qualified_name` or UUID.
- 409 existing Agent: choose update only for in-place change, release for a new version.
- Validation names a required YAML field: correct the source file, rebuild, and retry once.
- Unavailable or not configured: stop. Load `caracal-advanced` only for an explicit fallback request.
