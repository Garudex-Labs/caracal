// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent adapters: how each supported agent is launched, routed through the broker, and asked about tool calls.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ToolDecision = { allow: true } | { allow: false; reason: string }

export interface AgentLaunchPlan {
  argv: string[]
  env: Record<string, string | undefined>
}

export interface AgentLaunchInput {
  command: string
  args: string[]
  brokerUrl: string
  // Absolute paths of credential stores the agent's tool commands must not read.
  protectedPaths: string[]
}

export interface AgentAdapter {
  readonly name: string
  // Executable launched when the caller does not name one.
  readonly command: string
  // Broker path the agent's pre-tool hook posts to.
  readonly hookPath: string
  // Tool name from the agent's hook payload; undefined when the payload is unusable.
  toolName(payload: unknown): string | undefined
  // Hook response body for a decision, in the agent's own format.
  hookResponse(decision: ToolDecision): unknown
  // Executables the agent's tool sandbox and hook need on this platform; undefined when the
  // agent cannot be sandboxed there at all.
  requiredCommands(platform: NodeJS.Platform): string[] | undefined
  // Throws when host policy would silently switch off the agent's hook or sandbox.
  assertHostPolicy?(platform: NodeJS.Platform): void
  // argv and environment for one launch; throws when caller args would disable governance.
  plan(input: AgentLaunchInput): AgentLaunchPlan
}

// Placeholder for SDK-mandatory API keys; the Gateway strips it and injects the real credential.
export const GATEWAY_INJECTED_KEY = 'caracal-gateway-injected'

// The hook must answer before the agent's own timeout, or the agent treats it as an error and
// runs the tool anyway; the broker's decision deadline stays below this.
export const HOOK_TIMEOUT_SECONDS = 10

// Claude Code runs the tool when a hook errors, times out, or cannot reach its endpoint, and its
// sandbox blocks HTTP hooks from reaching loopback. A command hook runs outside the sandbox, and
// this one turns every failure to get a decision (broker gone, timeout, no curl) into exit 2, which
// Claude Code treats as a denial.
function claudeCodeHookCommand(url: string): string {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/[a-z/-]+$/.test(url)) throw new Error(`claude-code: unexpected hook url ${url}`)
  return `curl -fsS --max-time ${HOOK_TIMEOUT_SECONDS - 2} -H 'content-type: application/json' --data-binary @- '${url}' || { echo 'caracal: tool decision unavailable' >&2; exit 2; }`
}

// --bare skips every hook; the others can load settings that disable them, and --managed-settings
// outranks the launcher's own.
const CLAUDE_CODE_BLOCKED_FLAGS = ['--bare', '--settings', '--setting-sources', '--managed-settings']

const CLAUDE_CODE_MANAGED_DIRS: Partial<Record<NodeJS.Platform, string>> = {
  linux: '/etc/claude-code',
  darwin: '/Library/Application Support/ClaudeCode',
}

function readManagedSettings(path: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`claude-code: cannot read managed settings ${path}, so its effect on Caracal's hook is unknown`, { cause: err })
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    throw new Error(`claude-code: cannot parse managed settings ${path}, so its effect on Caracal's hook is unknown`, { cause: err })
  }
}

// Managed settings outrank the launcher's command-line settings, and Claude Code then drops the
// hook or sandbox without an error while the launch still succeeds. Server-managed settings and
// macOS managed preferences are not visible on the host, so only the managed files are checked.
export function assertClaudeCodeManagedSettings(dir: string): void {
  let dropIns: string[] = []
  try {
    dropIns = readdirSync(join(dir, 'managed-settings.d')).filter((name) => name.endsWith('.json'))
  } catch {
    /* no drop-in folder */
  }
  for (const path of [join(dir, 'managed-settings.json'), ...dropIns.map((name) => join(dir, 'managed-settings.d', name))]) {
    const settings = readManagedSettings(path)
    const sandbox = settings?.sandbox as Record<string, unknown> | undefined
    const conflict =
      settings?.disableAllHooks === true
        ? 'disableAllHooks'
        : settings?.allowManagedHooksOnly === true
          ? 'allowManagedHooksOnly'
          : sandbox?.enabled === false
            ? 'sandbox.enabled'
            : sandbox?.allowUnsandboxedCommands === true
              ? 'sandbox.allowUnsandboxedCommands'
              : undefined
    if (conflict) throw new Error(`claude-code: managed settings ${path} set ${conflict}, which would switch off Caracal's governance`)
  }
}

const claudeCode: AgentAdapter = {
  name: 'claude-code',
  command: 'claude',
  hookPath: '/hooks/claude-code/pre-tool-use',
  toolName(payload) {
    if (!payload || typeof payload !== 'object') return undefined
    const name = (payload as Record<string, unknown>).tool_name
    return typeof name === 'string' && name !== '' ? name : undefined
  },
  hookResponse(decision) {
    // An empty object defers to Claude Code's own permission rules: Caracal can only narrow
    // what the agent may do, never pre-approve a tool the user would otherwise be asked about.
    if (decision.allow) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } }
  },
  requiredCommands(platform) {
    // Claude Code silently runs commands unsandboxed when these are missing, so they are checked
    // before launch. Native Windows has no Claude Code sandbox.
    if (platform === 'linux') return ['bwrap', 'socat', 'sh', 'curl']
    if (platform === 'darwin') return ['sandbox-exec', 'sh', 'curl']
    return undefined
  },
  assertHostPolicy(platform) {
    const dir = CLAUDE_CODE_MANAGED_DIRS[platform]
    if (dir) assertClaudeCodeManagedSettings(dir)
  },
  plan({ command, args, brokerUrl, protectedPaths }) {
    for (const arg of args) {
      const flag = CLAUDE_CODE_BLOCKED_FLAGS.find((blocked) => arg === blocked || arg.startsWith(`${blocked}=`))
      if (flag) throw new Error(`claude-code: ${flag} is not allowed under a governed launch because it can disable Caracal's tool hooks`)
    }
    const settings = {
      // Command-line settings outrank project, local, and user settings files, which the agent
      // can write itself; only root-owned managed settings rank higher.
      disableAllHooks: false,
      // Bash commands run in Claude Code's OS sandbox (bubblewrap on Linux, Seatbelt on macOS):
      // no network and no writes outside the workspace, and the model cannot opt a command out.
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
      // The sandbox leaves reads open; these rules close credential stores to tool commands and
      // to the Read tool alike. A leading `//` marks an absolute path.
      permissions: { deny: protectedPaths.flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`]) },
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            // Without onFailure, Claude Code runs the tool when this hook errors or times out.
            hooks: [
              {
                type: 'command',
                command: claudeCodeHookCommand(`${brokerUrl}${claudeCode.hookPath}`),
                timeout: HOOK_TIMEOUT_SECONDS,
                onFailure: 'block',
              },
            ],
          },
        ],
      },
    }
    return {
      // Pinned first: anything after an `--` in the caller's args would be read as a positional.
      argv: [command, '--settings', JSON.stringify(settings), ...args],
      env: {
        ANTHROPIC_BASE_URL: `${brokerUrl}/model`,
        ANTHROPIC_API_KEY: GATEWAY_INJECTED_KEY,
        // Keeps telemetry and update checks from opening connections that bypass the broker.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    }
  },
}

const ADAPTERS: ReadonlyMap<string, AgentAdapter> = new Map([[claudeCode.name, claudeCode]])

export function agentAdapter(name: string): AgentAdapter {
  const adapter = ADAPTERS.get(name)
  if (!adapter) throw new Error(`unsupported agent '${name}'; supported: ${[...ADAPTERS.keys()].join(', ')}`)
  return adapter
}

export function agentNames(): string[] {
  return [...ADAPTERS.keys()]
}
