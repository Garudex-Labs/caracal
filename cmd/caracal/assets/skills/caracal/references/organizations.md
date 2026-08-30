<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Context Workflows

The CLI selects an organization/project context once and reuses it for
synchronization. Organization and project management — creation, members,
roles, ownership, deletion — lives in the web UI, not the CLI.

## Inspect and enumerate

```bash
caracal use --output json
caracal use --list --output json
```

`caracal use` without arguments reads the persisted context from local
config and never touches the network. `--list` enumerates the
organizations you belong to and the projects you can access in each.

## Select the context

```bash
caracal use acme --output json
caracal use acme/payments --output json
```

Selection validates access against the server before persisting
`default_org` (and `default_project` for the `ORG/PROJECT` form). A
denied or unknown target fails without changing local config. Switching
organizations clears a project selected in another one; the JSON result
carries `default_project_cleared` when that happens.

## How the context is used

`caracal sync` verifies the stored context against the server before
acting; a revoked or stale selection fails with a remediation pointing
back at `caracal use`. Component submissions attribute to the selected
organization when one is set.
