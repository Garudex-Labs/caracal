// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for `caracal run` and the safe child-process spawn helper.

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import { scrubTokens } from './crash.js'
import { InteractionRequiredError, fetchRunCredential, fetchRunManifest, pollStepUpState } from '@caracalai/oauth'
import type { RunBinding } from '@caracalai/oauth'
import { RuntimeConfigValidationError, assertCredentialEnvName } from './runtimeConfig.js'
import type { RuntimeIdentity } from './runtimeConfig.js'

const SIGNAL_EXIT_MAP: Record<string, number> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9,
  SIGHUP: 1,
  SIGQUIT: 3,
}

const STEP_UP_TIMEOUT_MS = 300_000
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
// workload identity plus the console-authored bindings served by STS.
export interface RunProfile {
  identity: RuntimeIdentity
  zoneId: string
  bindings: RunBinding[]
}

async function mintWithStepUp(identity: RuntimeIdentity, binding: RunBinding, onLine?: RunLineSink): Promise<string> {
  try {
    const minted = await fetchRunCredential(identity.sts_url, identity.workload_id, identity.workload_secret, binding.env)
    return minted.credential
  } catch (err) {
    if (!(err instanceof InteractionRequiredError) || !err.challengeId) throw err
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
    const state = await pollStepUpState(identity.sts_url, err.challengeId, { timeoutMs: STEP_UP_TIMEOUT_MS })
    if (state !== 'approved') throw new Error(`approval_${state}`)
    const minted = await fetchRunCredential(identity.sts_url, identity.workload_id, identity.workload_secret, binding.env, {
      challengeId: err.challengeId,
    })
    return minted.credential
  }
}

function credentialFailureLine(binding: RunBinding, err: unknown): string {
  const reason = scrubTokens(err instanceof Error ? err.message : String(err))
  const requestId = err instanceof InteractionRequiredError ? err.challengeId : undefined
  return JSON.stringify({ resource: binding.resource, reason, requestId })
}

function validateCredentialEnv(binding: RunBinding, used: Set<string>): void {
  if (!ENV_NAME.test(binding.env)) throw new Error(`invalid_credential_env:${binding.env}`)
  if (BLOCKED_CREDENTIAL_ENV.has(binding.env)) throw new Error(`blocked_credential_env:${binding.env}`)
  if (used.has(binding.env)) throw new Error(`duplicate_credential_env:${binding.env}`)
  used.add(binding.env)
}

// Resolves the full launch profile for a workload: authenticates against STS with the
// local identity, fetches the console-authored bindings, and revalidates them locally
// so a compromised control plane still cannot inject blocked env names.
export async function resolveRunConfig(identity: RuntimeIdentity): Promise<RunProfile> {
  const manifest = await fetchRunManifest(identity.sts_url, identity.workload_id, identity.workload_secret)
  const used = new Set<string>()
  for (const binding of manifest.bindings) {
    assertCredentialEnvName(binding.env)
    if (used.has(binding.env)) throw new RuntimeConfigValidationError('run manifest', `duplicate credential env '${binding.env}'`)
    used.add(binding.env)
  }
  return { identity, zoneId: manifest.zoneId, bindings: manifest.bindings }
}

export async function buildRunEnv(profile: RunProfile, opts: BuildRunEnvOptions = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  const usedEnv = new Set<string>()

  for (const binding of profile.bindings) {
    validateCredentialEnv(binding, usedEnv)
  }

  for (const binding of profile.bindings) {
    try {
      env[binding.env] = await mintWithStepUp(profile.identity, binding, opts.onLine)
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
  if (BLOCKED_CREDENTIAL_ENV.has(key)) throw new Error(`blocked_child_env:${key}`)
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
