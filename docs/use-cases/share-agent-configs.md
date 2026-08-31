<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Share agent configs across harnesses

Your Organization has a reviewer Agent that works well in Claude Code. Now another project wants to use it in Kiro, Cursor, or Copilot, and maintainers want changes to move through review instead of copy-paste. Per-harness config snippets do not scale.

Caracal's registry gives you one Agent definition that installs into each harness according to that harness's declared capabilities.

## The shape of an agent

Every Agent is a YAML file that bundles:

* MCP servers it needs
* Skills to load
* Hooks to wire into the session lifecycle
* Prompts (with variables)

When someone runs `caracal agent pull <agent>`, Caracal resolves a version and writes the right native files for that harness: agent profile files, MCP config, Skills, Hooks, Prompts, and local lockfile entries where the harness supports them.

## Publish an agent

### Option A - the interactive wizard

```bash
caracal agent init
```

Step-by-step prompts: name, description, which MCP servers, which skills, which hooks. Results in a registry entry you can share by ID.

### Option B - the YAML workflow

```bash
caracal agent init                  # scaffold caracal-agent.yaml
caracal agent add mcp github-mcp    # add components
caracal agent add skill code-review-skill
caracal agent add hook pretooluse-logger

caracal agent build                 # validate (dry-run)
caracal agent publish               # submit to registry
```

The YAML workflow is PR-reviewable. The file lives in your repo; changes flow through your normal review process.

## Install an agent into any harness

Browse what exists:

```bash
caracal agent list
caracal agent list --search review
caracal agent show <agent-id>
```

Install with one command, pick the harness:

```bash
caracal agent pull <agent-id> --harness claude-code
caracal agent pull <agent-id> --harness kiro
caracal agent pull <agent-id> --harness cursor
caracal agent pull <agent-id> --harness codex
caracal agent pull <agent-id> --harness copilot
```

The CLI prompts for any environment variables the MCP servers declare as required (GitHub tokens, API keys). These are stored in your harness config, not uploaded to Caracal.

### Control what gets installed

```bash
# Preview without writing anything
caracal agent pull <agent-id> --harness claude-code --dry-run

# Install into a specific directory
caracal agent pull <agent-id> --harness claude-code --dir ./my-project

# Claude Code only: scope (project-local vs user-global)
caracal agent pull <agent-id> --harness claude-code --scope project
caracal agent pull <agent-id> --harness claude-code --scope user

# Claude Code only: sub-agent model
caracal agent pull <agent-id> --harness claude-code --model sonnet

# Claude Code only: tool allowlist
caracal agent pull <agent-id> --harness claude-code --tools Read,Write,Bash
```

## What portability actually means

The harness feature matrix is defined in `packages/harness-data/registry.json` and loaded by the Go CLI/server. If an Agent uses Skills and the target harness does not declare `skills`, the installer:

* Installs the compatible parts cleanly
* Warns about the unsupported parts
* Exits non-zero if the agent *requires* something the harness cannot provide

Useful when onboarding a new machine or swapping between "work setup" and "personal setup."

## Next

→ [Run an organization agent registry](team-registry.md): once publishing is routine, you need governance.
