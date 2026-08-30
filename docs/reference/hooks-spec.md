<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hooks specification

The schema Caracal uses for hook definitions -- both the registry hook type (`caracal registry hook`) and hooks wired into harness configs by `caracal agent pull` / `caracal doctor patch`.

Current version: `"11"` - written into the `_caracal` metadata marker by the hook installers in `cmd/caracal/doctorcmd.go` and recorded in the CLI config as `hooks_spec_version`.

## Where hooks live

Two distinct things share the name "hook":

1. **Registry hooks**: packaged, versioned hook definitions in the Caracal registry. Install them via `caracal registry hook install`.
2. **harness hooks**: entries in `~/.claude/settings.json`, `.kiro/agents/<name>.json`, etc. These are written by `caracal agent pull` and `caracal doctor patch`.

Both use the same event vocabulary.

## Events

| Event | When it fires |
| --- | --- |
| `SessionStart` | New harness session begins |
| `Stop` | Session ends |
| `SubagentStop` | Sub-agent session ends (Claude Code only) |
| `UserPromptSubmit` | User submits a prompt |
| `PreToolUse` | Before a tool call |
| `PostToolUse` | After a tool call (with result) |
| `Notification` | harness surfaces a notification |

Source: `internal/registry/submit_direct.go:hookEvents`.

## Handler types

| Type | Payload | Used by |
| --- | --- | --- |
| `command` | Shell command with templated args | All managed harness hooks (invoke the `caracal` binary) |
| `http` | URL + method + headers + body | Registry hooks targeting harnesses with native HTTP hook support |

## Execution modes

| Mode | Semantics |
| --- | --- |
| `async` | Fire and forget - harness doesn't wait |
| `sync` | harness waits for handler to return before continuing |
| `blocking` | Handler can veto the event (e.g. block a tool call) |

Source: `internal/registry/submit_direct.go:hookExecutionModes`.

## Scopes

| Scope | Effect |
| --- | --- |
| `agent` | Applies only to one agent |
| `session` | Applies for the duration of a session |
| `global` | Applies across everything |

## Metadata marker

Caracal writes a `_caracal` key into hook matcher groups so subsequent runs of `doctor patch` / `pull` can find and update only Caracal-managed hooks without stomping on user-authored ones.

```json
{
  "_caracal": {
    "version": "11"
  },
  "hooks": [ ... ]
}
```

Older installs (pre-metadata) are detected with a fallback heuristic that scans hook commands for Caracal markers.

## Claude Code: managed hook group example

`caracal doctor patch` writes command hook groups into `~/.claude/settings.json` under the `UserPromptSubmit` and `Stop` events. Each command invokes the `caracal` binary:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "_caracal": { "version": "11" },
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/caracal hook session-push --harness claude-code"
          }
        ]
      }
    ]
  }
}
```

## Kiro: agent-profile hook example

Kiro hooks live inside each managed agent profile (`.kiro/agents/<name>.json`). `caracal doctor patch` pins the agent identity through `CARACAL_AGENT_ID` so sessions attribute correctly:

```json
{
  "name": "my-agent",
  "hooks": {
    "userPromptSubmit": [
      { "command": "CARACAL_AGENT_ID=<agent-id> /path/to/caracal hook session-push --harness kiro" }
    ],
    "stop": [
      { "command": "CARACAL_AGENT_ID=<agent-id> /path/to/caracal hook session-push --harness kiro" }
    ]
  }
}
```

## Event name mapping (Claude Code ↔ Kiro)

Kiro uses camelCase / lowercase event names; Claude Code uses PascalCase. Caracal maps between them.

| Claude Code | Kiro |
| --- | --- |
| `SessionStart` | `agentSpawn` |
| `Stop` | `stop` |
| `SubagentStop` | *(no equivalent)* |
| `UserPromptSubmit` | `userPromptSubmit` |
| `PreToolUse` | `preToolUse` |
| `PostToolUse` | `postToolUse` |
| `Notification` | *(no equivalent)* |

## Registry hook payload shape

When submitting a hook to the registry (`caracal registry hook submit`):

```json
{
  "name": "pretooluse-logger",
  "description": "Logs every tool call to a local file",
  "event": "PreToolUse",
  "handler_type": "command",
  "command": "echo \"$TOOL_NAME $(date)\" >> ~/.caracal/tool-log.txt",
  "execution_mode": "async",
  "scope": "agent",
  "harness": ["claude-code", "kiro"]
}
```

Each field is validated server-side against the lists in `internal/registry/submit_direct.go`.

## Source of truth

* `cmd/caracal/doctorcmd.go`: managed hook groups, metadata marker, spec version, per-harness install/cleanup
* `cmd/caracal/hookentry.go`: the `caracal hook session-push` entrypoint the installed hooks invoke
* `internal/registry/submit_direct.go`: valid events, handler types, execution modes, scopes
* `packages/harness-data/registry.json`: per-harness hook paths and event-name maps

## Related

* [`caracal registry hook`](../cli/registry.md)
* [Session tracking and reconciliation](../core-concepts/session-tracking.md)
