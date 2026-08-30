<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Observe MCP activity in sessions

Caracal identifies MCP and tool activity from the session transcript recorded by each coding harness. It does not intercept MCP transport traffic.

## What you get

When the harness records the relevant detail, session events can include:

- Tool or MCP name
- Tool input and result
- Event ordering within the session
- Harness, user, agent, and model attribution
- Token totals and timing derived from the session

Coverage varies by harness because Caracal can only index fields present in the local transcript or native message API. Transport-level latency and payload data are not synthesized when the harness does not record them.

## Discover and install session hooks

```bash
caracal scan
caracal doctor patch --all-harnesses
```

`scan` is read-only. `doctor patch` installs supported session hooks or extensions and leaves every MCP command and remote URL unchanged.

Scope hook installation to selected harnesses:

```bash
caracal doctor patch --harness claude-code
caracal doctor patch --harness kiro
caracal doctor patch --harness copilot-cli
```

Restart the harness after hook changes, then run a coding session. If a hook was missed or the machine was offline, reconcile local session sources:

```bash
caracal reconcile
```

## Query collected sessions

Open `/traces` in the web UI to filter sessions by harness, agent, user, model, and time range. Expand a session to inspect parsed prompts, responses, tool calls, tool results, and lifecycle events.

The CLI can list recent sessions and unfold their events:

```bash
caracal ops traces --limit 20
caracal ops traces --turn --limit 10
```

## Caveats

- MCP visibility depends on the harness transcript format.
- Caracal does not modify, proxy, or wrap MCP traffic.
- Monetary cost and structured transport errors are unavailable unless the harness records equivalent session fields.

## Next

[Debug agent failures](debug-agent-failures.md) explains how to investigate failures using session evidence.
