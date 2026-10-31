// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Governed agent launch: Session lifecycle, delegated authority, broker, and process supervision.

import { isAbsolute, join, resolve } from 'node:path'
import { Authority, Caracal } from '@caracalai/sdk'
import type { SessionHandle } from '@caracalai/sdk'
import type { AgentAdapter, ToolDecision } from './agentAdapters.js'
import type { AgentProfile } from './agentProfile.js'
import { startAgentBroker, type AgentBroker } from './agentBroker.js'
import { findExecutable } from './processTree.js'
import { runExec, type RunExecHandle, type RunLineSink } from './run.js'

export interface AgentLaunchOptions {
  adapter: AgentAdapter
  profile: AgentProfile
  // Arguments passed through to the agent.
  args: string[]
  // Caracal SDK environment (CARACAL_ZONE_ID, CARACAL_APPLICATION_ID, client secret, URLs).
  env: NodeJS.ProcessEnv
  // Agent executable; defaults to the adapter's command on PATH.
  command?: string
  cwd?: string
  // Lease renewal cadence, which bounds how long a revoked agent keeps running.
  heartbeatIntervalMs?: number
  // Lifetime of the authority delegated to the agent Session.
  ttlSeconds?: number
  // Launcher diagnostics: Session ids, tool denials, and why the agent was stopped.
  onLine?: RunLineSink
}

const HEARTBEAT_INTERVAL_MS = 5_000
const TTL_SECONDS = 8 * 60 * 60

// Credential stores under the user's home that an agent's tool commands must not read: Caracal's
// own configuration, the agent's login, and the common cloud, VCS, and package registry stores.
const HOME_CREDENTIAL_STORES = [
  '.config/caracal',
  '.local/share/caracal',
  '.claude/.credentials.json',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.kube',
  '.docker/config.json',
  '.config/gh',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
]
// Caracal locations named in the launcher's environment, which may sit outside the home directory.
const CARACAL_PATH_VARIABLES = [
  'CARACAL_APP_CLIENT_SECRET_FILE',
  'CARACAL_CONFIG',
  'CARACAL_CONFIG_HOME',
  'CARACAL_HOME',
  'CARACAL_SECRETS_DIR',
]

export function protectedPaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? env.USERPROFILE
  const paths = home && isAbsolute(home) ? HOME_CREDENTIAL_STORES.map((store) => join(home, store)) : []
  for (const name of CARACAL_PATH_VARIABLES) {
    const value = env[name]
    if (value) paths.push(resolve(value))
  }
  return [...new Set(paths)]
}

function appResources(env: NodeJS.ProcessEnv, profile: AgentProfile): string {
  const listed = (env.CARACAL_APP_RESOURCES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set([...listed, profile.model.resource, profile.tools.resource])].join(',')
}

// Refuses a launch whose tool sandbox or hook could not work, before any Session exists.
function assertSandboxAvailable(adapter: AgentAdapter, env: NodeJS.ProcessEnv): void {
  const required = adapter.requiredCommands(process.platform)
  if (!required)
    throw new Error(
      `${adapter.name}: governed launch is not supported on ${process.platform} because its tool sandbox is unavailable there`,
    )
  const missing = required.filter((command) => !findExecutable([command], env.PATH))
  if (missing.length)
    throw new Error(`${adapter.name}: ${missing.join(', ')} not found on PATH; the agent's tool sandbox and hook need them`)
}

// Runs one governed agent to completion and resolves its exit code. The agent holds no Caracal
// or upstream credential: model calls and tool decisions go through the loopback broker, which
// acts under a delegated agent Session the launcher keeps alive and tears down.
export async function launchAgent(opts: AgentLaunchOptions): Promise<number> {
  assertSandboxAvailable(opts.adapter, opts.env)
  const log = (line: string) => opts.onLine?.(`caracal: ${line}`, 'stderr')
  const ttlSeconds = opts.ttlSeconds ?? TTL_SECONDS
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const { model, tools } = opts.profile
  const caracal = Caracal.fromEnv({ ...opts.env, CARACAL_APP_RESOURCES: appResources(opts.env, opts.profile) })
  const labels = opts.profile.labels ?? [(await caracal.identity()).applicationId]

  let child: RunExecHandle | undefined
  let stopReason: string | undefined
  const stop = (reason: string) => {
    if (stopReason) return
    stopReason = reason
    log(`stopping ${opts.adapter.name}: ${reason}`)
    child?.dispose()
  }

  let launcher: SessionHandle | undefined
  let agent: SessionHandle | undefined
  let broker: AgentBroker | undefined
  try {
    const metadata = { agent: opts.adapter.name }
    launcher = await caracal.startSession({
      task: `launch ${opts.adapter.name}`,
      labels,
      metadata,
      authority: Authority.none(),
      heartbeatIntervalMs,
      onLeaseLost: () => stop('launcher Session ended'),
    })
    agent = await caracal.bind(launcher.context, () =>
      caracal.startSession({
        task: `${opts.adapter.name} agent`,
        labels,
        metadata,
        authority: Authority.narrow(model.scopes, { resourceId: model.resource, ttlSeconds }),
        heartbeatIntervalMs,
        onLeaseLost: () => stop('agent Session ended'),
      }),
    )
    const agentSession = agent
    const toolsEdge = await caracal.bind(launcher.context, () =>
      caracal.delegate({ toSessionId: agentSession.sessionId, resourceId: tools.resource, scopes: tools.scopes, ttlSeconds }),
    )
    log(`${opts.adapter.name} Session ${agentSession.sessionId} (launcher ${launcher.sessionId})`)

    broker = await startAgentBroker({
      adapter: opts.adapter,
      // A tool call is allowed exactly when STS will mint its scope under the agent's tool
      // delegation, so grants, delegation narrowing, revocation, and audit all apply.
      decide: (scope) =>
        caracal.bind(agentSession.context, () =>
          caracal.acceptDelegation(toolsEdge.delegationId, async (): Promise<ToolDecision> => {
            await caracal.mintMandate(tools.resource, [scope])
            return { allow: true }
          }),
        ),
      forward: (path, init) =>
        caracal.bind(agentSession.context, () => caracal.fetch(model.resource, path, { ...init, scopes: model.scopes })),
      onDecision: (tool, decision) => {
        if (!decision.allow) log(`denied ${tool ?? 'tool call'}: ${decision.reason}`)
      },
    })

    const plan = opts.adapter.plan({
      command: opts.command ?? opts.adapter.command,
      args: opts.args,
      brokerUrl: broker.url,
      protectedPaths: protectedPaths(opts.env),
    })
    child = runExec({ argv: plan.argv, env: plan.env, cwd: opts.cwd })
    if (stopReason) child.dispose()
    return await child.exitCode
  } finally {
    child?.dispose()
    await broker?.close()
    for (const session of [agent, launcher]) {
      try {
        await session?.close()
      } catch (err) {
        log(`Session close failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await caracal.close()
  }
}
