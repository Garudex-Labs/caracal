<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Operational workflows

## Contents

- Rankings
- Traces and sessions
- Telemetry diagnosis
- Logs

## Rankings

```bash
caracal ops top --type agent --output json
caracal ops top --type mcp --output json
```

## Traces and sessions

Start with a narrow window and increase it only if needed.

```bash
caracal ops traces --limit 20 --output json
caracal ops traces --platform kiro --days 7 --output json
caracal ops traces --turn --limit 5 --output json
caracal ops traces --span --limit 3 --output json
```

Report filters, count, time range, platforms, and notable failure signals. Avoid reproducing raw prompts, tool arguments, or outputs unless they are needed and authorized.

## Telemetry diagnosis

```bash
caracal ops telemetry status --output json
```

Inspect server event counts, local outbox state, warnings, and health fields. Diagnose in this order:

1. Authentication and server reachability.
2. Local outbox backlog or delivery failure.
3. Whether recent sessions exist for the requested harness.
4. Hook or extension installation with `doctor`.
5. Reconciliation only for sessions that were missed.

Use core diagnosis before patching:

```bash
caracal doctor --output json
caracal doctor patch --harness kiro --dry-run --output json
```

Do not fabricate synthetic telemetry or telemetry environment variables.

## Logs

Use a finite read by default:

```bash
caracal ops logs --no-follow --output json
caracal ops logs --remote --level WARNING --output json
```

Following logs emit JSON Lines. Remote logs require admin authority. Summarize relevant events and redact tokens, credentials, request bodies, and customer data.
