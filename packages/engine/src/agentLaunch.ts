// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Governed agent launch: Session lifecycle, delegated authority, broker, and process supervision.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { Authority, Caracal } from '@caracalai/sdk'
import type { SessionHandle } from '@caracalai/sdk'
import type { AgentAdapter, ToolDecision } from './agentAdapters.js'
import type { AgentProfile } from './agentProfile.js'
import { startAgentBroker, type AgentBroker } from './agentBroker.js'
import { findExecutable, spawnSyncTree } from './processTree.js'
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
  // Lifetime of the authority delegated to the agent Session; the launch stops when it ends.
  ttlSeconds?: number
  // Launcher diagnostics: Session ids, tool denials, and why the agent was stopped.
  onLine?: RunLineSink
}

const HEARTBEAT_INTERVAL_MS = 5_000
const TTL_SECONDS = 8 * 60 * 60
const VERSION_TIMEOUT_MS = 15_000

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
  adapter.assertHostPolicy?.(process.platform)
}

function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number)) as [number[], number[]]
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!
  }
  return 0
}

// Refuses an agent whose version cannot be read or is older than the launch was verified against.
function assertAgentVersion(adapter: AgentAdapter, command: string, env: NodeJS.ProcessEnv, log: (line: string) => void): void {
  if (!adapter.versions) return
  const { pattern, minimum, tested } = adapter.versions
  // Only what a version check needs, so no credential in the launcher's environment reaches it.
  const result = spawnSyncTree(command, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    env: { PATH: env.PATH, HOME: env.HOME },
  })
  const version = pattern.exec(String(result.stdout ?? ''))?.[1]
  if (!version) throw new Error(`${adapter.name}: cannot read the version of ${command}, so a governed launch cannot rely on it`)
  if (compareVersions(version, minimum) < 0)
    throw new Error(`${adapter.name}: version ${version} is older than ${minimum}, the oldest verified under a governed launch`)
  if (compareVersions(version, tested) > 0) log(`${adapter.name} ${version} is newer than ${tested}, the newest verified version`)
}

// Runs one governed agent to completion and resolves its exit code. The agent holds no Caracal
// or upstream credential: model calls and tool decisions go through the loopback broker, which
// acts under a delegated agent Session the launcher keeps alive and tears down.
export async function launchAgent(opts: AgentLaunchOptions): Promise<number> {
  assertSandboxAvailable(opts.adapter, opts.env)
  const log = (line: string) => opts.onLine?.(`caracal: ${line}`, 'stderr')
  const command = opts.command ?? opts.adapter.command
  // runExec never uses a shell, which Windows requires for these shims. A bare name such as
  // `openclaw` can resolve to one, as an npm install does.
  const onWindowsPath =
    process.platform === 'win32'
      ? findExecutable([command, `${command}.exe`, `${command}.cmd`, `${command}.bat`], opts.env.PATH)
      : undefined
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(onWindowsPath ?? command))
    throw new Error(
      `${opts.adapter.name}: ${command} is a shell shim, which a governed launch cannot run; pass the agent's executable with --command`,
    )
  assertAgentVersion(opts.adapter, command, opts.env, log)
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
    void child?.dispose()
  }

  let launcher: SessionHandle | undefined
  let agent: SessionHandle | undefined
  let broker: AgentBroker | undefined
  // Private to this launch and outside the workspace: holds agent config the agent must not edit.
  const stateDir = mkdtempSync(join(tmpdir(), 'caracal-launch-'))
  // Nothing renews the delegated authority, so the agent stops when it runs out rather than
  // running on with every tool and model call denied.
  const authorityExpiry = setTimeout(() => stop('delegated authority expired'), ttlSeconds * 1000)
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

    const workspace = resolve(opts.cwd ?? '.')
    const plan = opts.adapter.plan({
      command,
      args: opts.args,
      brokerUrl: broker.url,
      protectedPaths: protectedPaths(opts.env),
      workspace,
      stateDir,
    })
    for (const [name, content] of Object.entries(plan.files ?? {})) {
      const path = resolve(stateDir, name)
      if (!path.startsWith(`${stateDir}${sep}`)) throw new Error(`${opts.adapter.name}: plan file ${name} is outside the launch directory`)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, content, { mode: 0o600 })
    }
    // The agent gets the PATH its requirements were checked against and the HOME its credential
    // stores were protected under.
    const env = {
      ...(opts.env.HOME === undefined ? {} : { HOME: opts.env.HOME }),
      ...(opts.env.PATH === undefined ? {} : { PATH: opts.env.PATH }),
      ...plan.env,
    }
    child = runExec({ argv: plan.argv, env, cwd: plan.cwd ?? workspace })
    if (stopReason) void child.dispose()
    return await child.exitCode
  } finally {
    clearTimeout(authorityExpiry)
    await child?.dispose()
    await broker?.close()
    for (const session of [agent, launcher]) {
      try {
        await session?.close()
      } catch (err) {
        log(`Session close failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await caracal.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
}
