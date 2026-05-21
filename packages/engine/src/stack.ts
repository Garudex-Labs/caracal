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
  controlStateFile,
  isControlEnabled,
  readControlState,
  setControlEnabled,
  setControlMounted,
  type ControlRuntimeState,
} from './controlState.js'

export interface StackPaths {
  composeFile: string
  envFiles: string[]
  cwd: string
  mode: 'dev' | 'rc' | 'stable'
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

const CONTROL_MANAGED_ENV = 'CARACAL_ENGINE_CONTROL_ENABLED'

function controlManagedEnv(env: Record<string, string | undefined> | undefined, includeControlProfile: boolean): Record<string, string | undefined> | undefined {
  if (!includeControlProfile) return env
  return { ...env, [CONTROL_MANAGED_ENV]: 'true' }
}

function controlProfileValue(value: string | undefined): boolean {
  return value?.split(',').map((part) => part.trim()).includes('control') === true
}

function assertNoControlStackTarget(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === 'control') {
      throw new Error('Control runtime is managed only through caracal-cli control or the TUI Control menu.')
    }
    if (arg === '--profile' && controlProfileValue(args[index + 1])) {
      throw new Error('Control runtime is managed only through caracal-cli control or the TUI Control menu.')
    }
    if (arg?.startsWith('--profile=') && controlProfileValue(arg.slice('--profile='.length))) {
      throw new Error('Control runtime is managed only through caracal-cli control or the TUI Control menu.')
    }
  }
}

function composeArgv(paths: StackPaths, args: string[], includeControlProfile = isControlEnabled()): string[] {
  const profile = includeControlProfile ? ['--profile', 'control'] : []
  const envFlags = paths.envFiles.flatMap((f) => existsSync(f) ? ['--env-file', f] : [])
  return ['docker', 'compose', ...envFlags, '-f', paths.composeFile, ...profile, ...args]
}

export function stackUp(opts: StackComposeOpts): StackComposeHandle {
  assertNoControlStackTarget(opts.args)
  const includeControlProfile = isControlEnabled()
  const args = opts.paths.mode === 'dev'
    ? ['up', '-d', '--build', '--remove-orphans', ...opts.args]
    : ['up', '-d', '--remove-orphans', ...opts.args]
  const handle = runExec({
    argv: composeArgv(opts.paths, args, includeControlProfile),
    env: controlManagedEnv(opts.env, includeControlProfile),
    cwd: opts.paths.cwd,
    onLine: opts.onLine,
  })
  const exitCode = handle.exitCode.then(async (code) => {
    if (code !== 0) return code
    // Remove exited one-shot containers (e.g. dbMigrate) so they don't linger.
    const rm = runExec({
      argv: composeArgv(opts.paths, ['rm', '-f'], includeControlProfile),
      env: controlManagedEnv(opts.env, includeControlProfile),
      cwd: opts.paths.cwd,
    })
    await rm.exitCode
    return code
  })
  return { dispose: handle.dispose, exitCode }
}

export function stackDown(opts: StackComposeOpts): StackComposeHandle {
  assertNoControlStackTarget(opts.args)
  const includeControlProfile = isControlEnabled()
  const handle = runExec({
    argv: composeArgv(opts.paths, ['down', ...opts.args], includeControlProfile),
    env: controlManagedEnv(opts.env, includeControlProfile),
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

export const DEFAULT_SERVICE_PROBES: ServiceProbe[] = [
  { name: 'api', url: 'http://localhost:3000/health', port: 3000 },
  { name: 'sts', url: 'http://localhost:8080/health', port: 8080 },
  { name: 'gateway', url: 'http://localhost:8081/health', port: 8081 },
  { name: 'audit', url: 'http://localhost:9090/health', port: 9090 },
  { name: 'coordinator', url: 'http://localhost:4000/health', port: 4000 },
]

export function defaultServiceProbes(home?: string): ServiceProbe[] {
  const probes = [...DEFAULT_SERVICE_PROBES]
  const control = readControlState(home)
  if (control?.enabled) {
    probes.push({ name: control.service, url: control.healthUrl, port: control.port })
  }
  return probes
}

async function probeOne(svc: ServiceProbe, timeoutMs: number): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(svc.url, { signal: ctrl.signal })
    return { ...svc, ok: res.ok, detail: `${res.status}` }
  } catch (err) {
    const desc = err instanceof Error ? err.message : String(err)
    return { ...svc, ok: false, detail: desc.includes('aborted') ? 'timeout' : 'unreachable' }
  } finally {
    clearTimeout(timer)
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
  env?: Record<string, string | undefined>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  includeControlProfile?: boolean
}

export function composeRun(opts: ComposeRunOpts): StackComposeHandle {
  const includeControlProfile = opts.includeControlProfile ?? isControlEnabled()
  const handle = runExec({
    argv: composeArgv(opts.paths, opts.args, includeControlProfile),
    env: controlManagedEnv(opts.env, includeControlProfile),
    cwd: opts.paths.cwd,
    onLine: opts.onLine,
  })
  return { dispose: handle.dispose, exitCode: handle.exitCode }
}

export type ControlLifecycleAction = 'mount' | 'enable' | 'disable' | 'unmount'
export type ControlLifecycleState = 'enabled' | 'disabled' | 'unmounted'
export type ControlServiceRuntime = 'running' | 'stopped' | 'prepared' | 'removed' | 'unmounted'

export interface ControlLifecycleOpts {
  paths: StackPaths
  action: ControlLifecycleAction
  env?: Record<string, string | undefined>
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

export interface ControlLifecycleResult {
  action: ControlLifecycleAction
  state: ControlLifecycleState
  service: ControlServiceRuntime
  mounted: boolean
  enabled: boolean
  marker: string
  endpoint: string
  healthUrl: string
  readyUrl: string
  invokeUrl: string
  profile: string
  lifecycle: string
  optimization: string
  summary: string
}

function controlActionArgs(mode: StackPaths['mode'], action: ControlLifecycleAction, mounted: boolean): string[] | undefined {
  if (action === 'mount') return ['up', '--no-start', ...(mode === 'dev' ? ['--build'] : []), 'control']
  if (action === 'enable') return mounted ? ['start', 'control'] : ['up', '-d', ...(mode === 'dev' ? ['--build'] : []), 'control']
  if (action === 'disable') return ['stop', 'control']
  if (action === 'unmount') return ['rm', '-sf', 'control']
  return undefined
}

function controlLifecycleText(action: ControlLifecycleAction, state: ControlLifecycleState): Pick<ControlLifecycleResult, 'lifecycle' | 'optimization' | 'summary'> {
  if (state === 'enabled') {
    return {
      lifecycle: 'mounted and enabled',
      optimization: 'uses the existing stack services; no dedicated persistent volume is created',
      summary: action === 'enable' ? 'Control endpoint is running and ready for authenticated automation.' : 'Control endpoint is enabled.',
    }
  }
  if (state === 'disabled') {
    return {
      lifecycle: 'mounted but disabled',
      optimization: 'runtime is retained for fast enable; no Control endpoint is exposed',
      summary: action === 'mount'
        ? 'Control runtime is prepared and can be enabled quickly.'
        : 'Control endpoint is stopped while the mounted runtime is retained.',
    }
  }
  return {
    lifecycle: 'unmounted',
    optimization: 'control container is removed; no control background process is kept running',
    summary: action === 'unmount'
      ? 'Control runtime has been removed for long-term idle state.'
      : 'Control runtime is not mounted.',
  }
}

function controlResult(
  action: ControlLifecycleAction,
  state: ControlLifecycleState,
  service: ControlServiceRuntime,
  runtime: ReturnType<typeof controlRuntimeSettings> | ControlRuntimeState,
): ControlLifecycleResult {
  const text = controlLifecycleText(action, state)
  return {
    action,
    state,
    service,
    mounted: state !== 'unmounted',
    enabled: state === 'enabled',
    marker: controlStateFile(),
    endpoint: runtime.endpoint,
    healthUrl: runtime.healthUrl,
    readyUrl: runtime.readyUrl,
    invokeUrl: runtime.invokeUrl,
    profile: runtime.profile,
    ...text,
  }
}

export async function applyControlLifecycleAction(opts: ControlLifecycleOpts): Promise<ControlLifecycleResult> {
  authorizeControlManagementAccess()
  const settings = controlRuntimeSettings()
  const current = readControlState()
  if (opts.action === 'mount' && current) {
    return controlResult(opts.action, current.enabled ? 'enabled' : 'disabled', current.enabled ? 'running' : 'prepared', current)
  }
  if (opts.action === 'enable' && current?.enabled === true) {
    return controlResult(opts.action, 'enabled', 'running', current)
  }
  if (opts.action === 'disable' && current?.enabled === false) {
    return controlResult(opts.action, 'disabled', 'prepared', current)
  }
  if (opts.action === 'unmount' && !current) {
    return controlResult(opts.action, 'unmounted', 'unmounted', settings)
  }
  if (opts.action === 'disable' && !current) {
    return controlResult(opts.action, 'unmounted', 'unmounted', settings)
  }
  const args = controlActionArgs(opts.paths.mode, opts.action, current?.mounted === true)
  if (!args) throw new Error(`unsupported control lifecycle action: ${opts.action}`)
  const sink = opts.onLine ?? (() => {})
  if (opts.action !== 'disable' || current) {
    const code = await composeRun({
      paths: opts.paths,
      args,
      env: opts.env,
      onLine: sink,
      includeControlProfile: true,
    }).exitCode
    if (code !== 0) {
      throw new Error(`control ${opts.action} failed with exit code ${code}`)
    }
  }
  if (opts.action === 'unmount') {
    setControlMounted(false, false)
    return controlResult(opts.action, 'unmounted', 'removed', settings)
  }
  if (opts.action === 'mount') {
    const state = setControlMounted(true, false) ?? settings
    return controlResult(opts.action, 'disabled', 'prepared', state)
  }
  const state = setControlEnabled(opts.action === 'enable') ?? settings
  return controlResult(
    opts.action,
    opts.action === 'enable' ? 'enabled' : 'disabled',
    opts.action === 'enable' ? 'running' : 'stopped',
    state,
  )
}

export interface ControlServiceStatusOpts {
  home?: string
  timeoutMs?: number
}

export interface ControlServiceStatus {
  state: ControlLifecycleState
  service: 'ok' | 'down' | 'stopped' | 'unmounted'
  mounted: boolean
  enabled: boolean
  marker: string
  endpoint: string
  healthUrl: string
  readyUrl: string
  invokeUrl: string
  profile: string
  detail: string
  lifecycle: string
  optimization: string
}

function disabledControlStatus(home?: string): ControlServiceStatus {
  const settings = controlRuntimeSettings()
  return {
    state: 'unmounted',
    service: 'unmounted',
    mounted: false,
    enabled: false,
    marker: controlStateFile(home),
    endpoint: settings.endpoint,
    healthUrl: settings.healthUrl,
    readyUrl: settings.readyUrl,
    invokeUrl: settings.invokeUrl,
    profile: settings.profile,
    detail: 'not mounted',
    lifecycle: 'unmounted',
    optimization: 'control container is removed; no control background process is kept running',
  }
}

function enabledControlStatus(state: ControlRuntimeState, probe: ProbeResult, home?: string): ControlServiceStatus {
  if (!state.enabled) {
    return {
      state: 'disabled',
      service: 'stopped',
      mounted: true,
      enabled: false,
      marker: controlStateFile(home),
      endpoint: state.endpoint,
      healthUrl: state.healthUrl,
      readyUrl: state.readyUrl,
      invokeUrl: state.invokeUrl,
      profile: state.profile,
      detail: 'endpoint disabled',
      lifecycle: 'mounted but disabled',
      optimization: 'runtime is retained for fast enable; no Control endpoint is exposed',
    }
  }
  return {
    state: 'enabled',
    service: probe.ok ? 'ok' : 'down',
    mounted: true,
    enabled: true,
    marker: controlStateFile(home),
    endpoint: state.endpoint,
    healthUrl: state.healthUrl,
    readyUrl: state.readyUrl,
    invokeUrl: state.invokeUrl,
    profile: state.profile,
    detail: probe.detail,
    lifecycle: 'mounted and enabled',
    optimization: 'uses the existing stack services; no dedicated persistent volume is created',
  }
}

export async function controlServiceStatus(opts: ControlServiceStatusOpts = {}): Promise<ControlServiceStatus> {
  authorizeControlManagementAccess()
  const state = readControlState(opts.home)
  if (!state) return disabledControlStatus(opts.home)
  if (!state.enabled) {
    return enabledControlStatus(state, {
      name: state.service,
      url: state.healthUrl,
      port: state.port,
      ok: false,
      detail: 'endpoint disabled',
    }, opts.home)
  }
  const [probe] = await stackStatus({
    probes: [{ name: state.service, url: state.healthUrl, port: state.port }],
    timeoutMs: opts.timeoutMs,
  })
  return enabledControlStatus(state, probe!, opts.home)
}

const CARACAL_IMAGE_PREFIXES = [
  'caracal/',
  'localhost/caracal-',
  'ghcr.io/garudex-labs/caracal-',
] as const

export function listCaracalImages(): string[] {
  const out = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
  if (out.status !== 0 || typeof out.stdout !== 'string') return []
  return out.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && CARACAL_IMAGE_PREFIXES.some((p) => s.startsWith(p)))
}

export function removeImages(
  images: string[],
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<number> {
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
    for (const name of ['caracal', 'caracal-cli', 'caracal-tui']) {
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
