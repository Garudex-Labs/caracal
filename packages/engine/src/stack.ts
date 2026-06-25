// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for stack lifecycle: init (bootstrap + write toml), up, down, status, purge.

import { rmSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { runExec } from './run.js'
import { authorizeControlManagementAccess } from './controlAccess.js'
import {
  controlRuntimeSettings,
  controlGateFile,
  ensureControlGateDir,
  isControlEnabled,
  setControlEnabled,
  type ControlRuntimeSettings,
} from './controlState.js'

export interface StackPaths {
  composeFile: string
  envFiles: string[]
  cwd: string
  mode: 'dev' | 'rc' | 'stable'
  secretsDir: string
}

export interface StackComposeOpts {
  paths: StackPaths
  args: string[]
  env?: Record<string, string | undefined>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

export interface StackComposeHandle {
  dispose: () => void
  exitCode: Promise<number>
}

function composeArgv(paths: StackPaths, args: string[]): string[] {
  const envFlags = paths.envFiles.flatMap((f) => (existsSync(f) ? ['--env-file', f] : []))
  return ['docker', 'compose', ...envFlags, '-f', paths.composeFile, ...args]
}

export function stackUp(opts: StackComposeOpts): StackComposeHandle {
  // Create the control gate directory before compose runs so the bind mount
  // source exists and is owned by the invoking user. Without this the Docker
  // daemon creates it as root, leaving the local operator unable to write the gate file.
  ensureControlGateDir(opts.paths.cwd)
  const args =
    opts.paths.mode === 'dev' ? ['up', '-d', '--build', '--remove-orphans', ...opts.args] : ['up', '-d', '--remove-orphans', ...opts.args]
  const handle = runExec({
    argv: composeArgv(opts.paths, args),
    env: opts.env,
    cwd: opts.paths.cwd,
    onLine: opts.onLine,
  })
  const exitCode = handle.exitCode.then(async (code) => {
    if (code !== 0) return code
    // Remove exited one-shot containers (e.g. dbMigrate) so they don't linger.
    const rm = runExec({
      argv: composeArgv(opts.paths, ['rm', '-f']),
      env: opts.env,
      cwd: opts.paths.cwd,
    })
    await rm.exitCode
    return code
  })
  return { dispose: handle.dispose, exitCode }
}

export function stackDown(opts: StackComposeOpts): StackComposeHandle {
  const handle = runExec({
    argv: composeArgv(opts.paths, ['down', ...opts.args]),
    env: opts.env,
    cwd: opts.paths.cwd,
    onLine: opts.onLine,
  })
  return { dispose: handle.dispose, exitCode: handle.exitCode }
}

export interface ServiceProbe {
  name: string
  url: string
  port: number
}

export interface ProbeResult extends ServiceProbe {
  ok: boolean
  detail: string
}

export type ProbeKind = 'health' | 'ready'

const DEFAULT_SERVICE_PORTS: Array<{ name: string; port: number }> = [
  { name: 'api', port: 3000 },
  { name: 'sts', port: 8080 },
  { name: 'gateway', port: 8081 },
  { name: 'audit', port: 9090 },
  { name: 'coordinator', port: 4000 },
]

export const DEFAULT_SERVICE_PROBES: ServiceProbe[] = DEFAULT_SERVICE_PORTS.map((svc) => ({
  ...svc,
  url: `http://localhost:${svc.port}/health`,
}))

export function defaultServiceProbes(kind: ProbeKind = 'health'): ServiceProbe[] {
  const path = kind === 'ready' ? 'ready' : 'health'
  return DEFAULT_SERVICE_PORTS.map((svc) => ({
    ...svc,
    url: `http://localhost:${svc.port}/${path}`,
  }))
}

async function probeOne(svc: ServiceProbe, timeoutMs: number): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(svc.url, { signal: ctrl.signal })
    return { ...svc, ok: res.ok, detail: await probeDetail(res) }
  } catch (err) {
    const desc = err instanceof Error ? err.message : String(err)
    return { ...svc, ok: false, detail: desc.includes('aborted') ? 'timeout' : 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

async function probeDetail(res: Response): Promise<string> {
  if (res.ok) return `${res.status}`
  const body = await res.text()
  const reason = readinessReason(body)
  return reason ? `${res.status} ${reason}` : `${res.status}`
}

function readinessReason(body: string): string | undefined {
  const value = body.trim()
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    for (const key of ['reason', 'error', 'detail']) {
      const field = record[key]
      if (typeof field === 'string' && field !== '') return field
    }
    return undefined
  } catch {
    return value.split(/\r?\n/, 1)[0]?.slice(0, 120)
  }
}

export interface StackStatusOpts {
  probes?: readonly ServiceProbe[]
  timeoutMs?: number
}

export function stackStatus(opts: StackStatusOpts = {}): Promise<ProbeResult[]> {
  const probes = opts.probes ?? defaultServiceProbes()
  const timeoutMs = opts.timeoutMs ?? 1500
  return Promise.all(probes.map((s) => probeOne(s, timeoutMs)))
}

// --- Purge primitives ---------------------------------------------------

export interface ComposeRunOpts {
  paths: StackPaths
  args: string[]
  home?: string
  env?: Record<string, string | undefined>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

export function composeRun(opts: ComposeRunOpts): StackComposeHandle {
  const handle = runExec({
    argv: composeArgv(opts.paths, opts.args),
    env: opts.env,
    cwd: opts.paths.cwd,
    onLine: opts.onLine,
  })
  return { dispose: handle.dispose, exitCode: handle.exitCode }
}

export type ControlLifecycleAction = 'enable' | 'disable'
export type ControlLifecycleState = 'enabled' | 'disabled'
export type ControlServiceRuntime = 'ok' | 'down' | 'gated'

export interface ControlLifecycleOpts {
  action: ControlLifecycleAction
  home?: string
  accessEnv?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface ControlLifecycleResult {
  action: ControlLifecycleAction
  state: ControlLifecycleState
  service: ControlServiceRuntime
  enabled: boolean
  marker: string
  endpoint: string
  healthUrl: string
  readyUrl: string
  invokeUrl: string
  lifecycle: string
  optimization: string
  summary: string
}

function controlLifecycleText(
  action: ControlLifecycleAction,
  state: ControlLifecycleState,
): Pick<ControlLifecycleResult, 'lifecycle' | 'optimization' | 'summary'> {
  if (state === 'enabled') {
    return {
      lifecycle: 'enabled',
      optimization: 'served in-process by the API; no dedicated container, port, or background process is run',
      summary: 'Control endpoint is enabled and ready for authenticated automation.',
    }
  }
  return {
    lifecycle: 'disabled',
    optimization: 'the control plugin stays loaded in the API; the endpoint is blocked by the local gate',
    summary: action === 'disable' ? 'Control endpoint gate is closed.' : 'Control endpoint is disabled.',
  }
}

function controlResult(
  action: ControlLifecycleAction,
  state: ControlLifecycleState,
  service: ControlServiceRuntime,
  runtime: ControlRuntimeSettings,
  home?: string,
): ControlLifecycleResult {
  return {
    action,
    state,
    service,
    enabled: state === 'enabled',
    marker: controlGateFile(home),
    endpoint: runtime.endpoint,
    healthUrl: runtime.healthUrl,
    readyUrl: runtime.readyUrl,
    invokeUrl: runtime.invokeUrl,
    ...controlLifecycleText(action, state),
  }
}

export async function applyControlLifecycleAction(opts: ControlLifecycleOpts): Promise<ControlLifecycleResult> {
  authorizeControlManagementAccess({ env: opts.accessEnv })
  const settings = controlRuntimeSettings({ home: opts.home })
  if (opts.action === 'disable') {
    setControlEnabled(false, { home: opts.home })
    return controlResult('disable', 'disabled', 'gated', settings, opts.home)
  }
  setControlEnabled(true, { home: opts.home })
  const probe = await probeOne({ name: 'control', url: settings.healthUrl, port: settings.port }, opts.timeoutMs ?? 1500)
  if (!probe.ok) {
    setControlEnabled(false, { home: opts.home })
    throw new Error(`Control endpoint could not be confirmed (${probe.detail}); ensure the API service is running, then enable again.`)
  }
  return controlResult('enable', 'enabled', 'ok', settings, opts.home)
}

export interface ControlServiceStatusOpts {
  home?: string
  timeoutMs?: number
  accessEnv?: NodeJS.ProcessEnv
}

export interface ControlServiceStatus {
  state: ControlLifecycleState
  service: ControlServiceRuntime
  enabled: boolean
  marker: string
  endpoint: string
  healthUrl: string
  readyUrl: string
  invokeUrl: string
  detail: string
  lifecycle: string
  optimization: string
}

function controlStatus(
  state: ControlLifecycleState,
  service: ControlServiceRuntime,
  detail: string,
  runtime: ControlRuntimeSettings,
  home?: string,
): ControlServiceStatus {
  const text = controlLifecycleText(state === 'enabled' ? 'enable' : 'disable', state)
  return {
    state,
    service,
    enabled: state === 'enabled',
    marker: controlGateFile(home),
    endpoint: runtime.endpoint,
    healthUrl: runtime.healthUrl,
    readyUrl: runtime.readyUrl,
    invokeUrl: runtime.invokeUrl,
    detail,
    lifecycle: text.lifecycle,
    optimization: text.optimization,
  }
}

export async function controlServiceStatus(opts: ControlServiceStatusOpts = {}): Promise<ControlServiceStatus> {
  authorizeControlManagementAccess({ env: opts.accessEnv })
  const settings = controlRuntimeSettings({ home: opts.home })
  if (!isControlEnabled(opts.home)) {
    return controlStatus('disabled', 'gated', 'endpoint disabled', settings, opts.home)
  }
  const [probe] = await stackStatus({
    probes: [{ name: 'control', url: settings.healthUrl, port: settings.port }],
    timeoutMs: opts.timeoutMs,
  })
  return controlStatus('enabled', probe?.ok ? 'ok' : 'down', probe?.detail ?? 'unreachable', settings, opts.home)
}

const CARACAL_IMAGE_PREFIXES = ['caracal/', 'localhost/caracal-', 'ghcr.io/garudex-labs/caracal-'] as const

export function listCaracalImages(): string[] {
  const out = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
  if (out.status !== 0 || typeof out.stdout !== 'string') return []
  return out.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && CARACAL_IMAGE_PREFIXES.some((p) => s.startsWith(p)))
}

export function removeImages(images: string[], onLine?: (line: string, stream: 'stdout' | 'stderr') => void): Promise<number> {
  const handle = runExec({
    argv: ['docker', 'image', 'rm', '-f', ...images],
    onLine,
    forwardSignals: false,
  })
  return handle.exitCode
}

export function removeFsPath(path: string): { removed: boolean } {
  if (!existsSync(path)) return { removed: false }
  const isDir = statSync(path).isDirectory()
  rmSync(path, { recursive: isDir, force: true })
  return { removed: true }
}

export function caracalBinaries(installDir: string, extraDirs: readonly string[] = []): string[] {
  const dirs = new Set<string>([installDir, ...extraDirs])
  const found: string[] = []
  for (const dir of dirs) {
    for (const name of ['caracal', 'caracal-web']) {
      const p = `${dir}/${name}`
      if (existsSync(p)) found.push(p)
    }
  }
  return found
}

export interface PurgeStep {
  id: string
  label: string
  run: () => Promise<void>
}

export interface StackPurgeOpts {
  steps: PurgeStep[]
  onStep?: (step: PurgeStep, phase: 'start' | 'end') => void
}

export async function stackPurge(opts: StackPurgeOpts): Promise<void> {
  for (const step of opts.steps) {
    opts.onStep?.(step, 'start')
    await step.run()
    opts.onStep?.(step, 'end')
  }
}
