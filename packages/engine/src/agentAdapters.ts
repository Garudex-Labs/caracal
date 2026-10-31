// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Agent adapters: how each supported agent is launched, routed through the broker, and asked about tool calls.

export type ToolDecision = { allow: true } | { allow: false; reason: string }

export interface AgentLaunchPlan {
  argv: string[]
  env: Record<string, string | undefined>
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
  // argv and environment for one launch; throws when caller args would disable governance.
  plan(command: string, args: string[], brokerUrl: string): AgentLaunchPlan
}

// Placeholder for SDK-mandatory API keys; the Gateway strips it and injects the real credential.
export const GATEWAY_INJECTED_KEY = 'caracal-gateway-injected'

// The hook must answer before the agent's own timeout, or the agent treats it as an error and
// runs the tool anyway; the broker's decision deadline stays below this.
export const HOOK_TIMEOUT_SECONDS = 10

// --bare skips every hook; --settings and --setting-sources can load settings that disable them.
const CLAUDE_CODE_BLOCKED_FLAGS = ['--bare', '--settings', '--setting-sources']

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
  plan(command, args, brokerUrl) {
    for (const arg of args) {
      const flag = CLAUDE_CODE_BLOCKED_FLAGS.find((blocked) => arg === blocked || arg.startsWith(`${blocked}=`))
      if (flag) throw new Error(`claude-code: ${flag} is not allowed under a governed launch because it can disable Caracal's tool hooks`)
    }
    const settings = {
      // Command-line settings outrank project, local, and user settings files, which the agent
      // can write itself; only root-owned managed settings rank higher.
      disableAllHooks: false,
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: `${brokerUrl}${claudeCode.hookPath}`, timeout: HOOK_TIMEOUT_SECONDS }] }],
      },
    }
    return {
      argv: [command, ...args, '--settings', JSON.stringify(settings)],
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
