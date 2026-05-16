// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for `caracal run` and the safe child-process spawn helper.

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import { scrubTokens } from '@caracalai/core/crash'
import { InteractionRequiredError, OAuthClient } from '@caracalai/oauth'
import type { CliConfig, Credential } from '@caracalai/core/cli'

const SIGNAL_EXIT_MAP: Record<string, number> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
  SIGHUP: 1,
  SIGQUIT: 3,
}

const STEP_UP_POLL_MS = 2000
const STEP_UP_TIMEOUT_MS = 300_000
const TOKEN_TTL_SECONDS = 3600
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BLOCKED_CREDENTIAL_ENV = new Set([
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
])

export type RunLineSink = (line: string, stream: 'stdout' | 'stderr') => void

export interface RunExecOpts {
  argv: string[]
  env?: Record<string, string | undefined>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  cwd?: string
  // Default true (CLI ergonomics). Hosts that own the keymap — TUI, REPL, embedded
  // libraries — must pass false so engine signals don't tear the parent down.
  forwardSignals?: boolean
}

export interface RunExecHandle {
  child: ChildProcess
  dispose: () => void
  exitCode: Promise<number>
}

export interface BuildRunEnvOptions {
  readonly onLine?: RunLineSink
}

export function checkMcpGovernance(args: readonly string[] | string, cfg: CliConfig, onLine?: RunLineSink): void {
  const haystack = (Array.isArray(args) ? args : [args]).join(' ')
  const isUnauthorized = ['mcp-server', 'fastmcp', '@modelcontextprotocol'].some((indicator) => haystack.includes(indicator))
  if (!isUnauthorized) return

  const mode = cfg.mcp_governance?.mode ?? 'block'
  const action = mode === 'log' ? 'log' : 'blocked'
  onLine?.(JSON.stringify({ event: 'mcp_governance', action, cmd: haystack }), 'stderr')
  if (mode !== 'log') throw new Error('mcp_governance_blocked')
}

async function waitForChallenge(zoneUrl: string, challengeId: string): Promise<boolean> {
  const deadline = Date.now() + STEP_UP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${zoneUrl}/step-up/${challengeId}`)
      if (res.status === 404 || res.status === 410) {
        throw new Error(`step_up_challenge_expired (${res.status})`)
      }
      if (res.ok) {
        const data = (await res.json()) as { satisfied: boolean }
        if (data.satisfied) return true
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('step_up_challenge_expired')) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, STEP_UP_POLL_MS))
  }
  return false
}

async function exchangeWithStepUp(client: OAuthClient, cfg: CliConfig, resource: string, onLine?: RunLineSink): Promise<string> {
  try {
    const token = await client.exchange('', resource, {
      clientSecret: cfg.app_client_secret,
      ttlSeconds: TOKEN_TTL_SECONDS,
    })
    return token.accessToken
  } catch (err) {
    if (!(err instanceof InteractionRequiredError) || !err.challengeId) throw err
    onLine?.(JSON.stringify({ resource, challenge_id: err.challengeId, reason: 'step_up_required' }), 'stderr')
    const satisfied = await waitForChallenge(cfg.zone_url, err.challengeId)
    if (!satisfied) throw new Error('step_up_challenge_timed_out')
    const token = await client.exchange('', resource, {
      clientSecret: cfg.app_client_secret,
      ttlSeconds: TOKEN_TTL_SECONDS,
    })
    return token.accessToken
  }
}

function credentialFailureLine(cred: Credential, err: unknown): string {
  const reason = scrubTokens(err instanceof Error ? err.message : String(err))
  const requestId = err instanceof InteractionRequiredError ? err.challengeId : undefined
  return JSON.stringify({ resource: cred.resource, reason, requestId })
}

function validateCredentialEnv(cred: Credential, used: Set<string>): void {
  if (!ENV_NAME.test(cred.env)) throw new Error(`invalid_credential_env:${cred.env}`)
  if (BLOCKED_CREDENTIAL_ENV.has(cred.env)) throw new Error(`blocked_credential_env:${cred.env}`)
  if (used.has(cred.env)) throw new Error(`duplicate_credential_env:${cred.env}`)
  used.add(cred.env)
}

export async function buildRunEnv(cfg: CliConfig, opts: BuildRunEnvOptions = {}): Promise<Record<string, string>> {
  const client = new OAuthClient(cfg.zone_url, cfg.zone_id, cfg.application_id)
  const env: Record<string, string> = {}
  const usedEnv = new Set<string>()

  for (const cred of cfg.credentials ?? []) {
    validateCredentialEnv(cred, usedEnv)
    try {
      env[cred.env] = await exchangeWithStepUp(client, cfg, cred.resource, opts.onLine)
    } catch (err) {
      opts.onLine?.(credentialFailureLine(cred, err), 'stderr')
      if (!cfg.continue_on_failure) throw err
    }
  }

  for (const cred of cfg.optional_credentials ?? []) {
    validateCredentialEnv(cred, usedEnv)
    try {
      env[cred.env] = await exchangeWithStepUp(client, cfg, cred.resource, opts.onLine)
    } catch (err) {
      if (cred.on_failure === 'error') {
        opts.onLine?.(credentialFailureLine(cred, err), 'stderr')
        throw err
      }
      const reason = scrubTokens(err instanceof Error ? err.message : String(err))
      opts.onLine?.(`optional credential skipped resource=${cred.resource} reason=${reason}`, 'stdout')
    }
  }

  return env
}

function validateArgv(argv: string[]): void {
  if (argv.length === 0) throw new Error('runExec: argv is empty')
  for (const tok of argv) {
    if (typeof tok !== 'string') throw new Error('runExec: non-string argv token')
    if (tok.indexOf('\u0000') !== -1) throw new Error('runExec: argv token contains NUL byte')
  }
}

function buildChildEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  // Always derive from a copy of process.env; never mutate the caller's env.
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
  }
  return env
}

function exitFromSignal(signal: NodeJS.Signals | null): number {
  if (!signal) return 1
  return 128 + (SIGNAL_EXIT_MAP[signal] ?? 15)
}

export function runExec(opts: RunExecOpts): RunExecHandle {
  validateArgv(opts.argv)
  const [cmd, ...args] = opts.argv
  const env = buildChildEnv(opts.env)

  const stdio: StdioOptions = opts.onLine ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  // shell:true is forbidden — argv tokens are passed verbatim to the OS.
  const child = spawn(cmd!, args, { env, stdio, cwd: opts.cwd })

  if (opts.onLine) {
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => opts.onLine!(line, 'stdout'))
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr })
      rl.on('line', (line) => opts.onLine!(line, 'stderr'))
    }
  }

  let signalHandlers: ReadonlyArray<readonly [NodeJS.Signals, (...args: unknown[]) => void]> = []
  if (opts.forwardSignals !== false) {
    const forward: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']
    signalHandlers = forward.map((sig) => {
      const h = (): void => {
        try { child.kill(sig) } catch { /* already exited */ }
      }
      process.on(sig, h)
      return [sig, h] as const
    })
  }

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const [sig, h] of signalHandlers) process.off(sig, h)
    try { child.kill('SIGTERM') } catch { /* already exited */ }
  }

  const exitCode = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const [sig, h] of signalHandlers) process.off(sig, h)
      if (typeof code === 'number') return resolve(code)
      resolve(exitFromSignal(signal))
    })
    child.on('error', () => {
      for (const [sig, h] of signalHandlers) process.off(sig, h)
      resolve(127)
    })
  })

  return { child, dispose, exitCode }
}
