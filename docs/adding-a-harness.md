<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Adding a New Harness to Caracal

This guide covers everything needed to add full harness support. Caracal manages
four component types per harness: **MCP servers**, **skills**, **hooks**, and
**sandboxes**. Each harness needs scanning (discovery), config generation (install),
hook instrumentation (telemetry), and session parsing (reconciliation).

## Overview: What "Supporting a harness" Means

When a user runs `caracal agent pull <agent>`, Caracal writes harness-specific files:

| Component | What gets written | Example |
|-----------|------------------|---------|
| MCP servers | Native JSON/TOML config with direct commands or URLs | `.cursor/mcp.json` |
| Skills | Markdown skill files in harness's skill directory | `.claude/skills/my-skill/SKILL.md` |
| Hooks | Telemetry hook config that fires on tool use, session start/stop | `settings.json` hooks section |
| Sandboxes | MCP entry pointing to `caracal sandbox run` | Added to MCP config |

When a user runs `caracal scan`, Caracal reads those same locations to discover what's installed.

## File Checklist

| # | File | What it does |
|---|------|-------------|
| 1 | `packages/harness-data/registry.json` | Shared harness metadata: paths, keys, event maps, formats (embedded on both the CLI and server sides by the Go `internal/harness` package) |
| 2 | `cmd/caracal/scancmd.go` | Per-harness scanning functions, the `scanHarness` dispatch, and `detectHooksFor` hook detection |
| 3 | `cmd/caracal/registry.go` | Add the harness to the `validHarnesses` list |
| 4 | `internal/harnessgen/adapters.go` | Server-side adapter: config generation for install and pull |
| 5 | `cmd/caracal/doctorcmd.go` (+ `doctorchecks.go`) | Doctor diagnose, patch, and cleanup implementations; defines the hooks `doctor patch` installs |
| 6 | `internal/cli/sessions/discover.go` + `source.go` | Session source discovery: a `discover<Name>` function registered in the `Discoverers` map |
| 7 | `cmd/caracal/hookentry.go` | `caracal hook session-push --harness <harness_name>` session push entrypoint (shared; usually no change needed) |
| 8 | `internal/ingest` | Server-side session classification keyed by the registry's `session_parser`, pinned by `contracts/session-goldens/` |
| 9 | Colocated `*_test.go` files | Unit tests next to each package touched |
| 10 | `/api/v1/config/harnesses` consumers | Frontend uses server harness metadata through `useHarnesses()` |

## Step 1: Research the harness

Before writing code, document these for the target harness:

**MCP configuration:**
- Where does the harness look for MCP server config? (path, format: JSON/TOML/YAML)
- What's the top-level key? (`mcpServers`, `servers`, `mcp`, etc.)
- Does it support stdio, SSE, or both transports?
- Home-level config path vs project-level config path?

**Skills:**
- Does the harness have a skill/rules/instruction file concept?
- What format? (Markdown with YAML frontmatter, plain markdown, MDC, JSON)
- Where do skill files live? (project path, user/global path)

**Hooks:**
- Does the harness fire lifecycle events? (tool use, session start/stop, errors)
- How are hooks registered? (JSON config, settings file, plugin system)
- What events are available? Map them to Caracal's canonical events:
  - `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`, `SubagentStop`
- Does the harness support command hooks, HTTP hooks, or plugin hooks?

**Sessions:**
- Does the harness write session logs? (JSONL, SQLite, custom format)
- Where are session files stored?
- What's the schema? (messages, tool calls, thinking blocks)

**Sandboxes:**
- Sandboxes are delivered as MCP servers, so if MCP works, sandboxes work.

## Step 2: Add Harness Registry Entry

Add one entry to `packages/harness-data/registry.json`. The Go code (CLI and
server) embeds this shared registry through `internal/harness`.

```json
"my-harness": {
    "display_name": "My harness",
    "capabilities": ["hooks", "mcp_servers", "skills"],
    "session_parser": "my_harness",
    "scopes": ["project", "user"],
    "default_scope": "project",
    "scope_labels": ["project (.my-harness/)", "user (~/.my-harness/)"],

    "mcp_config": {
        "project": ".my-harness/mcp.json",
        "user": "~/.my-harness/mcp.json"
    },
    "mcp_servers_key": "mcpServers",
    "home_mcp_config": "~/.my-harness/mcp.json",

    "skills": {
        "project": ".my-harness/skills/{name}/SKILL.md",
        "user": "~/.my-harness/skills/{name}/SKILL.md"
    },
    "skill_format": "yaml_frontmatter",

    "agent_profile": {
        "project": ".my-harness/agents/{name}.md",
        "user": "~/.my-harness/agents/{name}.md"
    },
    "agent_profile_format": "yaml_frontmatter",

    "hook_type": "command",
    "hooks": {
        "project": ".my-harness/settings.json",
        "user": "~/.my-harness/settings.json"
    },
    "hook_scripts_dir": ".my-harness/hooks",
    "hook_events_map": {
        "PreToolUse": "preToolUse",
        "PostToolUse": "postToolUse",
        "Stop": "sessionEnd",
        "SessionStart": "sessionStart",
        "UserPromptSubmit": "beforeSubmitPrompt"
    },

    "guidance_files": ["AGENTS.md"],
    "config_dir": ".my-harness"
}
```

Notes: `session_parser` may be `null` when the harness writes no session
logs. `hook_type` is `"command"`, `"http"`, or `"plugin"`. `scope_labels`
may be `null` for single-scope harnesses.

## Step 2.5: Update Doctor Coverage (required)

Before moving on, always wire the new harness into these shared paths:

- `cmd/caracal/doctorcmd.go`:
  - Add `patch<Name>()` and `cleanup<Name>()` implementations and dispatch them from the per-harness `adapterChange` switch
  - Add the matching diagnose check in `cmd/caracal/doctorchecks.go`
- `internal/cli/sessions/source.go`:
  - Add `HomeMarkers` for active harness detection when the harness has a reliable home config marker. Glob patterns are supported.

If these are skipped, the harness can appear supported in pull/scan while doctor and telemetry observability remain incomplete.

## Step 3: Add CLI Scanning

Scanning lives in `cmd/caracal/scancmd.go`. Add per-harness functions and wire
them into the `scanHarness` dispatch:

1. Write `scanMyHarnessHome(home string) scanResult` and
   `scanMyHarnessProject(projectDir string) scanResult`. Reuse the shared
   helpers: `scanMCPFile` (JSON MCP configs; accepts the top-level key names),
   `scanCodexTOML` (TOML configs), and `scanSkillFiles` (SKILL.md trees).
   Simple harnesses can inline these calls in the `scanHarness` case, as the
   Cursor and Codex cases do.
2. Add a `case "my-harness":` arm to `scanHarness` in the same file.
3. Extend `detectHooksFor` so `caracal scan` reports whether managed hooks are
   `installed`, `partial`, or `missing`. Managed hook entries are recognized by
   the shared `caracalHookMarkers` list in `cmd/caracal/doctorchecks.go`.
4. Add the harness to `validHarnesses` in `cmd/caracal/registry.go` so
   `--harness` filters accept it.

Discovered items use the `discoveredMcp`, `discoveredSkill`, `discoveredHook`,
and `discoveredAgent` types in `scancmd.go`. MCP deduplication is
first-discovered-wins, home before project.

## Step 4: Create the Server-Side Config Generator (Install)

Config generation for `caracal agent pull` and installs lives in
`internal/harnessgen`. Add an adapter in `internal/harnessgen/adapters.go`:

1. Define a `myHarnessAdapter struct{ base }` implementing the unexported
   `adapter` interface (the `base` embedding provides defaults).
2. Register it in the `adapters` map keyed by the harness name.
3. Emit the harness's native files (agent profile, MCP config, hooks config,
   steering/guidance) through the generation engine in
   `internal/harnessgen/generate.go`; shared fragments such as the managed
   hook commands live in `internal/harnessgen/fragments.go`.
4. Pin the output with a case in `internal/harnessgen/generate_test.go`.

## Step 5: Define What Doctor Patch Installs

Hook specs are defined by the doctor implementation in
`cmd/caracal/doctorcmd.go`. Your `patch<Name>()` writes managed hook entries
into the harness's hook config file; each entry's command invokes the CLI
binary:

```text
<path-to-caracal> hook session-push --harness my-harness
```

Use `hookCommandFor("my-harness")` (in `cmd/caracal/doctorchecks.go`) to build
that command - it resolves the running binary's path - and `hookGroupFor` for
harnesses that take Claude-style matcher groups; it stamps the `_caracal`
metadata marker so later runs update only managed entries. `cleanup<Name>()`
must remove exactly what patch installs while preserving user-authored hooks.

## Step 6: Add the Session Source Adapter and Parser (required)

Transport and parsing are intentionally separate. The CLI adapter locates raw source records; it must not normalize them. The server parser remains harness-specific and converts stored raw rows into frontend events.

For a JSONL harness, add a `discoverMyHarness(home string, sinceHours int) ([]Source, error)`
function in `internal/cli/sessions/discover.go` and register it in the
`Discoverers` map in `internal/cli/sessions/source.go` with the harness's
`HomeMarkers`. Each `Source` carries the session ID, source path, cwd, and
optional parent session ID; the shared engine (`DrainSessionSource`,
`DrainOutbox`) handles cursors, spooling, chunking, acknowledgement, checkpoint
recovery, and final audit. Reuse
`caracal hook session-push --harness my-harness`; add harness-specific handling
in `cmd/caracal/hookentry.go` only when the host requires special stdout or
runtime behavior. Do not add another cursor, direct POST path, or
harness-specific reconcile scanner.

The shared engine reads complete records, spools them before network delivery, retries stable source indexes, advances only after a contiguous acknowledgement, recovers from the server checkpoint, and hashes full history only during final audit.

Implement the server-side classification in `internal/ingest` (one classifier per harness in the row builder, keyed by the registry's `session_parser` value). It should handle user and assistant messages, tool calls/results, reasoning blocks, errors, and boundaries. Record a fixture set under `contracts/session-goldens/` and add its mapping in `internal/ingest/goldens_test.go`; the parity suite is the gate for classification changes.

For a non-JSONL host, add a native source/exporter only when the supported harness actually requires one. It must persist pending indexed records before delivery and obey the same acknowledgement/checkpoint/final-hash protocol. OpenCode and Pi are the reference native implementations (the OpenCode plugin in `cmd/caracal/assets/opencode-plugin.ts` and the Pi extension in `packages/pi-extension/`).

## Step 7: Configure the Shared Session Hook

Point generated hook commands at:

```text
caracal hook session-push --harness my-harness
```

A thin compatibility bridge is acceptable for required host responses, but all recovery and delivery still route through the shared engine.

## Step 8: Register Everything

1. `cmd/caracal/registry.go`: add the harness to `validHarnesses`.
2. `cmd/caracal/scancmd.go`: add the `scanHarness` case and `detectHooksFor` logic.
3. `cmd/caracal/doctorcmd.go`: add the `adapterChange` case dispatching your patch and cleanup functions.
4. `internal/harnessgen/adapters.go`: register the adapter in the `adapters` map.
5. `internal/cli/sessions/source.go`: register the discoverer with its `HomeMarkers` in the `Discoverers` map.

## Step 9: Tests

Cover the new code with colocated Go tests:

- Session discovery: table-driven cases in `internal/cli/sessions/discover_test.go`
  (empty home, sessions inside and outside the time window, subagent layouts).
- Config generation: a case per harness in `internal/harnessgen/generate_test.go`.
- Session classification: a fixture set under `contracts/session-goldens/` mapped
  in `internal/ingest/goldens_test.go`.

Use `t.TempDir()` for any home or project directory; never touch the real home.

## Step 10: Verify

```bash
# CLI and session packages compile and pass
go test ./cmd/caracal/... ./internal/cli/...

# Scan discovers your harness
caracal scan --harness my-harness

# Config generation works
go test ./internal/harnessgen/

# Classification parity holds
go test ./internal/ingest/

# Install produces correct files
caracal agent pull <some-agent> --harness my-harness --dry-run

# Hooks install correctly
caracal doctor patch --harness my-harness --dry-run

# Recovery discovers and drains an unfinished fixture through the shared engine
caracal reconcile --harness my-harness --dry-run
```

## Architecture Notes

**Skills are mostly universal.** All harnesses that support skills use the same
pattern: a `SKILL.md` file with YAML frontmatter (or plain markdown) placed
in the harness's skill directory. The only things that vary are the directory path
(defined in `skills` in the registry) and the frontmatter format (defined
in `skill_format`). No harness-specific skill generation code is needed beyond
setting those two registry fields correctly. The shared skill generation in
`internal/harnessgen` handles all harnesses.

**Sandboxes are just MCP servers.** They use `caracal sandbox run` as the
command. If MCP install works for your harness, sandboxes work automatically.
No additional sandbox-specific code is needed per harness.

Other notes:

- Each concern has one per-harness implementation: scanning in `cmd/caracal/scancmd.go`, hook install/cleanup in `cmd/caracal/doctorcmd.go`, session discovery in `internal/cli/sessions`, config generation in `internal/harnessgen`
- Server parsers remain format-specific; transport, recovery, acknowledgement, and final audit behavior stay shared
- Shared scan helpers in `cmd/caracal/scancmd.go`: `scanMCPFile`, `scanSkillFiles`, `scanCodexTOML`; managed-hook markers in `cmd/caracal/doctorchecks.go` (`caracalHookMarkers`)
- Capability gating comes from the registry: check `Spec.HasCapability` from `internal/harness` before capability-specific operations
- MCP deduplication in scan uses first-discovered-wins
- MCP commands and remote URLs are emitted directly in each harness's native format
- Sandboxes are MCP servers backed by `caracal sandbox run`, so if MCP install works, sandboxes work automatically
- Skills use the harness's native skill/rule file format, resolved from `skills` and `skill_format` in the registry
