<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Caracal CLI Command Reference

<!-- BEGIN AUTO-GENERATED COMMAND REFERENCE -->
Every command available in the installed CLI. If a flag you need is missing here, run `<command> --help` for full options.

Removed surfaces: organization/project management, submission review, server administration, the inbox, and the embedded server lifecycle are managed in the web UI or by the deployment operator scripts, not the CLI. `caracal use` replaces `org use`/`project use`; `caracal sync` replaces `caracal outdated`.

**Root commands**

- `caracal api`: Call an authenticated Caracal JSON API endpoint.
- `caracal use`: Show or select the organization/project this machine syncs against. `caracal use` shows the context, `caracal use ORG` or `caracal use ORG/PROJECT` selects it, `caracal use --list` enumerates your organizations and projects. Switching organizations clears a project selected in another one. Organization and project management (create, members, roles) lives in the web UI.
- `caracal sync`: Bring local harness installs up to date with the registry. Verifies the selected context, compares every installed agent and component against the registry, and applies pending updates. `--dry-run` shows the plan without changing anything; `--report` files pending updates to your web inbox; `--harness` limits to one harness.
- `caracal pull TARGET`: Materialize an agent or component into your harness. Resolves TARGET across agents and component families (agent, mcp, skill, hook, prompt) and installs it through the same path as the dedicated commands. Pass `--type` to skip detection, `--harness` to pick the harness.
- `caracal reconcile`: Backfill local session records missed by automatic hook delivery.
- `caracal scan`: Show a read-only inventory of your local harness setup.

**`caracal agent`**: Agent registry (reads plus local authoring; management lives in the web UI)

- `caracal agent list`: List active agents (paginated).
- `caracal agent show`: Show full agent details.
- `caracal agent versions`: List all versions for an agent.
- `caracal agent init`: Scaffold a caracal-agent.yaml definition file.
- `caracal agent add`: Add a component reference to caracal-agent.yaml.
- `caracal agent build`: Validate the agent definition against the registry (dry-run).
- `caracal agent publish`: Publish the agent definition to the registry.
- `caracal agent release`: Bump version and push a versioned release to the registry.
- `caracal agent pull`: Fetch agent config and write harness files to disk.

**`caracal auth`**: Authentication and account commands

- `caracal auth login`: Connect to Caracal.
- `caracal auth logout`: Clear saved credentials.
- `caracal auth whoami`: Show current authenticated user.
- `caracal auth status`: Check authenticated server connectivity and local outbox health.
- `caracal auth change-password`: Change your password.
- `caracal auth set-username`: Set or update your username.

**`caracal config`**: CLI configuration

- `caracal config alias`: Set or remove a local registry reference alias.
- `caracal config aliases`: List all local aliases.
- `caracal config path`: Show the config file path.
- `caracal config set`: Set a validated user-managed CLI setting.
- `caracal config show`: Show effective CLI configuration without exposing credentials.

**`caracal doctor`**: Diagnose and patch harness settings for Caracal telemetry

- `caracal doctor support`: Generate and inspect diagnostic support bundles. Bundles contain no customer data or row contents.
  - `caracal doctor support bundle`: Generate a diagnostic support bundle. No customer data or row contents included.
  - `caracal doctor support inspect`: Inspect a support bundle without extracting it.
- `caracal doctor cleanup`: Remove Caracal-managed telemetry artifacts while preserving user configuration.
- `caracal doctor patch`: Install Caracal-managed session telemetry for selected harnesses.

**`caracal ops`**: Observability and operational commands (sessions, telemetry, rankings, insights)

- `caracal ops insights`: Agent insight reports
  - `caracal ops insights generate`: Trigger generation of a new insight report.
  - `caracal ops insights list`: List insight reports for an agent.
  - `caracal ops insights show`: Show an insight report with pretty-printed narrative.
- `caracal ops logs`: Live log viewer (open in a separate tab)
- `caracal ops telemetry`: Telemetry health commands
  - `caracal ops telemetry status`: Check telemetry data flow status.
- `caracal ops top`: Show top MCP servers or agents by usage.
- `caracal ops traces`: List recent traces (sessions).

**`caracal registry`**: Component registry (MCPs, skills, hooks, prompts, sandboxes)

- `caracal registry bulk`: Submit mixed Registry components from one JSON file.
  - `caracal registry bulk submit`: Submit mixed MCP, skill, hook, prompt, and sandbox entries.
- `caracal registry hook`: Hook registry commands
  - `caracal registry hook co-authors`: Manage co-authors for hooks
    - `caracal registry hook co-authors add`: Add a co-author.
    - `caracal registry hook co-authors list`: List co-authors.
    - `caracal registry hook co-authors remove`: Remove a co-author.
  - `caracal registry hook archive`: Archive this component.
  - `caracal registry hook edit`: Edit a draft, rejected, or pending hook submission.
  - `caracal registry hook install`: Install a hook for a specific harness.
  - `caracal registry hook list`: List approved hooks from the registry.
  - `caracal registry hook show`: Show detailed information for a single hook.
  - `caracal registry hook submit`: Submit a new hook for review.
  - `caracal registry hook transfer-owner`: Transfer ownership to another username.
  - `caracal registry hook unarchive`: Restore an archived component.
- `caracal registry mcp`: MCP server registry commands
  - `caracal registry mcp co-authors`: Manage co-authors for mcps
    - `caracal registry mcp co-authors add`: Add a co-author.
    - `caracal registry mcp co-authors list`: List co-authors.
    - `caracal registry mcp co-authors remove`: Remove a co-author.
  - `caracal registry mcp submit`: Submit an MCP server to the registry.
  - `caracal registry mcp show`: Show full details of an MCP server.
  - `caracal registry mcp install`: Generate an install config snippet for an MCP server.
  - `caracal registry mcp archive`: Archive this component.
  - `caracal registry mcp edit`: Edit an MCP server submission.
  - `caracal registry mcp list`: List approved MCP servers in the registry.
  - `caracal registry mcp my`: List your own MCP servers across all statuses.
  - `caracal registry mcp transfer-owner`: Transfer ownership to another username.
  - `caracal registry mcp unarchive`: Restore an archived component.
- `caracal registry models`: Inspect registry-backed harness model data.
  - `caracal registry models list`: List registry-backed harness models.
- `caracal registry prompt`: Prompt registry commands
  - `caracal registry prompt co-authors`: Manage co-authors for prompts
    - `caracal registry prompt co-authors add`: Add a co-author.
    - `caracal registry prompt co-authors list`: List co-authors.
    - `caracal registry prompt co-authors remove`: Remove a co-author.
  - `caracal registry prompt archive`: Archive this component.
  - `caracal registry prompt edit`: Edit a draft, rejected, or pending prompt submission.
  - `caracal registry prompt list`: List approved prompts in the registry.
  - `caracal registry prompt my`: List your own prompts across all statuses.
  - `caracal registry prompt render`: Render a prompt template with variable substitution.
  - `caracal registry prompt show`: Show detailed information about a prompt.
  - `caracal registry prompt submit`: Submit a new prompt template for review.
  - `caracal registry prompt transfer-owner`: Transfer ownership to another username.
  - `caracal registry prompt unarchive`: Restore an archived component.
- `caracal registry recommend`: Components recommended for you, based on your own sessions
  - `caracal registry recommend dismiss`: Stop recommending a component to you.
  - `caracal registry recommend list`: Show components recommended for you.
- `caracal registry sandbox`: Sandbox registry commands
  - `caracal registry sandbox co-authors`: Manage co-authors for sandboxes
    - `caracal registry sandbox co-authors add`: Add a co-author.
    - `caracal registry sandbox co-authors list`: List co-authors.
    - `caracal registry sandbox co-authors remove`: Remove a co-author.
  - `caracal registry sandbox archive`: Archive this component.
  - `caracal registry sandbox edit`: Edit a draft, rejected, or pending sandbox submission.
  - `caracal registry sandbox list`: List approved sandboxes in the registry.
  - `caracal registry sandbox show`: Show detailed information about a sandbox.
  - `caracal registry sandbox submit`: Submit a new sandbox environment for review.
  - `caracal registry sandbox transfer-owner`: Transfer ownership to another username.
  - `caracal registry sandbox unarchive`: Restore an archived component.
- `caracal registry skill`: Skill registry commands
  - `caracal registry skill co-authors`: Manage co-authors for skills
    - `caracal registry skill co-authors add`: Add a co-author.
    - `caracal registry skill co-authors list`: List co-authors.
    - `caracal registry skill co-authors remove`: Remove a co-author.
  - `caracal registry skill archive`: Archive this component.
  - `caracal registry skill edit`: Edit a draft, rejected, or pending skill submission.
  - `caracal registry skill install`: Install a skill by fetching the full skill directory from git.
  - `caracal registry skill list`: List approved skills in the registry.
  - `caracal registry skill my`: List your own skills across all statuses.
  - `caracal registry skill show`: Show detailed information about a skill.
  - `caracal registry skill submit`: Submit a new skill for review.
  - `caracal registry skill transfer-owner`: Transfer ownership to another username.
  - `caracal registry skill unarchive`: Restore an archived component.
- `caracal registry version`: Manage component versions
  - `caracal registry version list`: List version history for a registry component.
  - `caracal registry version publish`: Publish a new version for a registry component.

**`caracal self`**: CLI self-management commands (upgrade, downgrade, rollback, status)

- `caracal self upgrade`: Upgrade the Caracal CLI to the latest or specified version.
- `caracal self downgrade`: Downgrade the Caracal CLI to a previous version.
- `caracal self rollback`: Restore the CLI binary saved before the last version change.
- `caracal self status`: Show the CLI version, install method, and update availability.
<!-- END AUTO-GENERATED COMMAND REFERENCE -->
