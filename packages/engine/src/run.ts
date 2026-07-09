// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for `caracal run` and the safe child-process spawn helper.

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { scrubTokens } from './crash.js'
import { ApprovalRequiredError, fetchRunCredential, fetchRunManifest, pollStepUpState } from '@caracalai/oauth'
import type { RunBinding, RunCredentialResponse } from '@caracalai/oauth'
import { RuntimeConfigValidationError, assertCredentialEnvName } from './runtimeConfig.js'
import type { RuntimeIdentity } from './runtimeConfig.js'

const SIGNAL_EXIT_MAP: Record<string, number> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
  SIGHUP: 1,
  SIGQUIT: 3,
}

const STEP_UP_FALLBACK_TIMEOUT_MS = 300_000
const STEP_UP_MIN_TIMEOUT_MS = 5_000
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BLOCKED_CREDENTIAL_ENV = new Set([
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
])

const INHERITED_ENV_KEYS = new Set(
  [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'COLORTERM',
    'NO_COLOR',
    'FORCE_COLOR',
    'CI',
    'NODE_ENV',
    'CARACAL_ENV',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
  ].map((key) => key.toUpperCase()),
)

export type RunLineSink = (line: string, stream: 'stdout' | 'stderr') => void

export interface RunExecOpts {
  argv: string[]
  env?: Record<string, string | undefined>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  cwd?: string
  // Default true for runtime ergonomics. Hosts that own the keymap (UI hosts, embedded
  // libraries) must pass false so engine signals don't tear the parent down.
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

// RunProfile is the fully resolved launch profile a run executes with: the local
// workload identity plus the console-authored bindings served by STS. The launchId
// correlates every STS call of one launch in the zone audit stream.
export interface RunProfile {
  identity: RuntimeIdentity
  zoneId: string
  bindings: RunBinding[]
  launchId: string
}

// The wait window for a parked run is the hold's own approval window: polling stops when
// the hold can no longer be approved, not at an arbitrary earlier cutoff. A missing or
// unparseable expiry falls back to five minutes; a floor keeps a nearly expired hold from
// producing a zero-length wait that would misreport a still-pending hold as timed out.
function stepUpWaitMs(expiresAt: string | undefined): number {
  if (!expiresAt) return STEP_UP_FALLBACK_TIMEOUT_MS
  const remaining = Date.parse(expiresAt) - Date.now()
  if (Number.isNaN(remaining)) return STEP_UP_FALLBACK_TIMEOUT_MS
  return Math.max(STEP_UP_MIN_TIMEOUT_MS, remaining)
}

async function mintWithStepUp(
  identity: RuntimeIdentity,
  binding: RunBinding,
  launchId: string,
  onLine?: RunLineSink,
): Promise<RunCredentialResponse> {
  try {
    return await fetchRunCredential(identity.sts_url, identity.workload_id, identity.workload_secret, binding.env, { launchId })
  } catch (err) {
    if (!(err instanceof ApprovalRequiredError) || !err.challengeId) throw err
    // The hold's id and binding go to stderr so whatever surface supervises this
    // runtime can relay them to an approver; the runtime itself just waits.
    onLine?.(
      JSON.stringify({
        resource: binding.resource,
        challenge_id: err.challengeId,
        binding: err.binding,
        expires_at: err.expiresAt,
        reason: 'approval_required',
      }),
      'stderr',
    )
    const state = await pollStepUpState(identity.sts_url, err.challengeId, { timeoutMs: stepUpWaitMs(err.expiresAt) })
    if (state !== 'approved') throw new Error(`approval_${state}`)
    return fetchRunCredential(identity.sts_url, identity.workload_id, identity.workload_secret, binding.env, {
      challengeId: err.challengeId,
      launchId,
    })
  }
}

function credentialFailureLine(binding: RunBinding, err: unknown): string {
  const reason = scrubTokens(err instanceof Error ? err.message : String(err))
  const requestId = err instanceof ApprovalRequiredError ? err.challengeId : undefined
  return JSON.stringify({ resource: binding.resource, reason, requestId })
}

function validateCredentialEnv(binding: RunBinding, used: Set<string>): void {
  if (!ENV_NAME.test(binding.env)) throw new Error(`invalid_credential_env:${binding.env}`)
  if (BLOCKED_CREDENTIAL_ENV.has(binding.env.toUpperCase())) throw new Error(`blocked_credential_env:${binding.env}`)
  if (used.has(binding.env)) throw new Error(`duplicate_credential_env:${binding.env}`)
  used.add(binding.env)
}

// Resolves the full launch profile for a workload: authenticates against STS with the
// local identity, fetches the console-authored bindings, and revalidates them locally
// so a compromised control plane still cannot inject blocked env names.
export async function resolveRunConfig(identity: RuntimeIdentity): Promise<RunProfile> {
  const launchId = randomUUID()
  const manifest = await fetchRunManifest(identity.sts_url, identity.workload_id, identity.workload_secret, { launchId })
  const used = new Set<string>()
  for (const binding of manifest.bindings) {
    assertCredentialEnvName(binding.env)
    if (used.has(binding.env)) throw new RuntimeConfigValidationError('run manifest', `duplicate credential env '${binding.env}'`)
    used.add(binding.env)
  }
  return { identity, zoneId: manifest.zoneId, bindings: manifest.bindings, launchId }
}

export async function buildRunEnv(profile: RunProfile, opts: BuildRunEnvOptions = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  const usedEnv = new Set<string>()

  for (const binding of profile.bindings) {
    validateCredentialEnv(binding, usedEnv)
  }

  for (const binding of profile.bindings) {
    try {
      const minted = await mintWithStepUp(profile.identity, binding, profile.launchId, opts.onLine)
      env[binding.env] = minted.credential
      // The companion <ENV>_EXPIRES_AT variable carries the epoch-seconds expiry when
      // the provider reports one, so the child can refresh before the credential dies.
      // An explicit binding that claims the derived name wins.
      const expiryEnv = `${binding.env}_EXPIRES_AT`
      if (minted.expiresAt !== undefined && !usedEnv.has(expiryEnv)) env[expiryEnv] = String(minted.expiresAt)
    } catch (err) {
      if (!binding.optional || binding.onFailure === 'error') {
        opts.onLine?.(credentialFailureLine(binding, err), 'stderr')
        throw err
      }
      const reason = scrubTokens(err instanceof Error ? err.message : String(err))
      opts.onLine?.(`optional credential skipped resource=${binding.resource} reason=${reason}`, 'stdout')
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

function shouldInheritEnv(key: string): boolean {
  const upper = key.toUpperCase()
  return INHERITED_ENV_KEYS.has(upper) || upper.startsWith('LC_')
}

function validateChildEnvKey(key: string): void {
  if (!ENV_NAME.test(key)) throw new Error(`invalid_child_env:${key}`)
  if (BLOCKED_CREDENTIAL_ENV.has(key.toUpperCase())) throw new Error(`blocked_child_env:${key}`)
}

function buildChildEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && shouldInheritEnv(key)) env[key] = value
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      validateChildEnvKey(k)
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

function spawnErrorLine(cmd: string, err: Error): string {
  const code = 'code' in err && typeof err.code === 'string' ? ` (${err.code})` : ''
  return `failed to start ${cmd}: ${err.message}${code}`
}

export function runExec(opts: RunExecOpts): RunExecHandle {
  validateArgv(opts.argv)
  const [cmd, ...args] = opts.argv
  const env = buildChildEnv(opts.env)

  const stdio: StdioOptions = opts.onLine ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  // shell:true is forbidden: argv tokens are passed verbatim to the OS.
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
        try {
          child.kill(sig)
        } catch {
          /* already exited */
        }
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
    try {
      child.kill('SIGTERM')
    } catch {
      /* already exited */
    }
  }

  const exitCode = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const [sig, h] of signalHandlers) process.off(sig, h)
      if (typeof code === 'number') return resolve(code)
      resolve(exitFromSignal(signal))
    })
    child.on('error', (err) => {
      for (const [sig, h] of signalHandlers) process.off(sig, h)
      const msg = spawnErrorLine(cmd!, err)
      if (opts.onLine) opts.onLine(msg, 'stderr')
      else process.stderr.write(`${msg}\n`)
      resolve(127)
    })
  })

  return { child, dispose, exitCode }
}
