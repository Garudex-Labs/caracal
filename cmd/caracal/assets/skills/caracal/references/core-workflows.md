<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Core workflows

## Contents

- Authentication and account
- CLI configuration
- Local inventory and update checks
- Diagnosis and telemetry setup
- Inbox
- API escape hatch
- Error handling

## Authentication and account

Do not run an authentication probe before every command. Execute the requested read operation first. If authentication fails, inspect identity and then log in.

```bash
caracal auth whoami --output json
caracal auth login
caracal auth login --sso --output json
caracal auth logout --output json
caracal auth status --output json
caracal auth set-username new-handle --output json
```

For noninteractive password authentication, keep passwords out of arguments:

```bash
CARACAL_PASSWORD_FILE=/path/to/password caracal auth login --server https://caracal.example.com --email me@example.com --name 'Example User' --output json
CARACAL_CURRENT_PASSWORD_FILE=/path/to/current CARACAL_NEW_PASSWORD_FILE=/path/to/new caracal auth change-password --output json
```

Fresh-server JSON bootstrap can require `--name`. SSO JSON emits an authorization event followed by an authenticated event. A username becomes the Registry namespace; changing it stays allowed after publishing and moves every Agent and component you own to the new namespace atomically.

At every CLI startup, bundled Caracal skill trees are hash-checked against the packaged copies. Drift causes complete replacement of only the six Caracal-managed skill directories, including stale extra files.

## CLI configuration

```bash
caracal config show --output json
caracal config path --output json
caracal config set server_url https://caracal.example.com --output json
caracal config set timeout 60 --output json
caracal config aliases --output json
caracal config alias MY_AGENT namespace/slug --output json
```

Only use keys accepted by `config set`. Authentication fields are managed by `auth`. Config output must not contain token values or fragments.

## Local inventory and synchronization

`scan` is read-only and never writes harness files.

```bash
caracal scan --output json
caracal scan --harness kiro --output json
caracal sync --dry-run --output json
caracal sync --output json
caracal sync --harness claude-code --report --output json
```

For scan results, report detected harnesses, installed components, Agents, and unregistered items. `sync` verifies the selected context (`caracal use`), compares installed items against the registry, and applies pending updates; `--dry-run` only plans, `--report` files pending updates to the web inbox. Inspect `planned`, `applied`, and `failed` in the JSON result.

## Diagnosis and telemetry setup

Diagnosis does not mutate unless the user explicitly requests a fix option.

```bash
caracal doctor --output json
caracal doctor patch --all-harnesses --dry-run --output json
caracal doctor patch --all-harnesses --output json
caracal doctor patch --harness kiro --output json
caracal doctor cleanup --dry-run --output json
caracal doctor cleanup --yes --output json
```

Patch requires at least one harness or `--all-harnesses`. Cleanup removes only Caracal-managed artifacts. JSON cleanup requires confirmation. For Pi, patch installs the bundled extension directly.

Support bundles are sensitive diagnostic artifacts:

```bash
caracal doctor support bundle --file /tmp/caracal-support.tar.gz --output json
caracal doctor support inspect /tmp/caracal-support.tar.gz --output json
```

Verify `healthy`, `issues`, `warnings`, and per-harness results. Exit status zero means checks ran, not necessarily that every check is healthy.

## API escape hatch

Use only when no dedicated command exists. It preserves raw endpoint JSON and uses configured authentication.

```bash
caracal api GET /api/v1/orgs --output json
caracal api GET /api/v1/agents --param limit=10 --output json
caracal api POST /api/v1/orgs/acme/projects --from-file project.json --output json
```

Mutation bodies come from one JSON object in a file or standard input. Full URLs and arbitrary authorization headers are rejected. Prefer dedicated commands for validation and confirmations.

## Error handling

- Authentication: run `auth whoami`, then login only when needed.
- Permission: report the role or ownership requirement.
- Not found: re-list and use the returned UUID or canonical name.
- Conflict: inspect current state and server detail before choosing an action.
- Version mismatch: use `caracal-advanced` for CLI version recovery.
- Unavailable or not configured: stop. Use explicit local fallback only if the user requests it after the failure.
