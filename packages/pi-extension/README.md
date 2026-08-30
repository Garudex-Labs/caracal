<!--
SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
SPDX-License-Identifier: Apache-2.0
-->

# caracal-pi

Session telemetry extension for [Pi](https://pi.dev) that pushes conversation traces to your [Caracal](https://obs-sync.dev) server.

## Install

```bash
caracal doctor patch --harness pi
```

Doctor installs the bundled TypeScript extension directly at `~/.pi/agent/extensions/caracal.ts`. It removes the legacy `npm:caracal-pi` package registration to prevent duplicate loading.

## Prerequisites

1. An Caracal account (run `caracal auth login` to authenticate)
2. Pi installed (`>=0.74.0`)

## What it does

- **Incremental push:** After each user prompt (`agent_end`), durably stages new JSONL lines before sending them to Caracal
- **Acknowledged checkpoints:** Advances byte and line cursors only after a contiguous server acknowledgement
- **Final push:** On session exit, sends remaining lines and a SHA-256 audit manifest; mismatches replay from the requested range
- **Crash recovery:** Retries durable pending batches and rebuilds missing/corrupt cursors from the authenticated server checkpoint
- **Status indicator:** Shows `● caracal` in the footer with line count

## Commands

| Command | Description |
|---------|-------------|
| `/obs-sync` | Show sync status (lines pushed, server URL) |
| `/obs-sync flush` | Force push pending lines now |
| `/obs-sync config` | Show config file path and server URL |

## Design

- **Zero dependencies**: only `node:*` built-ins
- **Fail-open**: never throws, never crashes pi. If the server is unreachable, pi continues normally
- **5s timeout**: all HTTP calls abort after 5 seconds
- **Chunked uploads**: batches of 500 lines max per request
- **Retry-safe**: pending batches retain stable source indexes and are retried until acknowledged

## Configuration

The extension reads credentials from `~/.caracal/config.json` (written by `caracal auth login`):

```json
{
  "server_url": "https://your-server.caracal.run",
  "access_token": "..."
}
```

Acknowledged cursors are stored atomically in `~/.caracal/sync_state.json`. Unacknowledged Pi batches remain in `~/.caracal/pi_session_outbox/` until the server confirms a contiguous checkpoint.

## License

Apache-2.0. See [LICENSE](./LICENSE)
