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
  ensureControlGateDir,
  controlGateFile,
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
  return { ...env, [CONTROL_MANAGED_ENV]: 'true', CARACAL_CONTROL_STATE_DIR: ensureControlGateDir() }
}

function controlProfileValue(value: string | undefined): boolean {
  return value?.split(',').map((part) => part.trim()).includes('control') === true
}

function assertNoControlStackTarget(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === 'control') {
      throw new Error('Control runtime is managed only through the terminal management interface Control menu.')
    }
    if (arg === '--profile' && controlProfileValue(args[index + 1])) {
      throw new Error('Control runtime is managed only through the terminal management interface Control menu.')
    }
    if (arg?.startsWith('--profile=') && controlProfileValue(arg.slice('--profile='.length))) {
      throw new Error('Control runtime is managed only through the terminal management interface Control menu.')
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

export function defaultServiceProbes(home?: string, kind: ProbeKind = 'health'): ServiceProbe[] {
  const path = kind === 'ready' ? 'ready' : 'health'
  const probes = DEFAULT_SERVICE_PORTS.map((svc) => ({
    ...svc,
    url: `http://localhost:${svc.port}/${path}`,
  }))
  const control = readControlState(home)
  if (control?.enabled) {
    probes.push({
      name: control.service,
      url: kind === 'ready' ? control.readyUrl : control.healthUrl,
      port: control.port,
    })
  }
  return probes
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
export type ControlServiceRuntime = 'running' | 'gated' | 'removed' | 'unmounted'

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
  if (action === 'mount') return ['up', '-d', ...(mode === 'dev' ? ['--build'] : []), 'control']
  if (action === 'enable') return mounted ? [] : undefined
  if (action === 'disable') return []
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
      optimization: 'runtime remains loaded; the Control endpoint is blocked by the local gate',
      summary: action === 'mount'
        ? 'Control runtime is loaded with the endpoint gate closed.'
        : 'Control endpoint gate is closed while the runtime stays loaded.',
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
    return controlResult(opts.action, current.enabled ? 'enabled' : 'disabled', current.enabled ? 'running' : 'gated', current)
  }
  if (opts.action === 'enable' && current?.enabled === true) {
    return controlResult(opts.action, 'enabled', 'running', current)
  }
  if (opts.action === 'enable' && !current) {
    throw new Error('Control runtime is not mounted; mount runtime before enabling the endpoint.')
  }
  if (opts.action === 'disable' && current?.enabled === false) {
    return controlResult(opts.action, 'disabled', 'gated', current)
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
  if (args.length > 0) {
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
    return controlResult(opts.action, 'disabled', 'gated', state)
  }
  const state = setControlEnabled(opts.action === 'enable') ?? settings
  if (opts.action === 'enable') {
    const probe = await probeOne({ name: state.service, url: state.readyUrl, port: state.port }, 1500)
    if (!probe.ok) {
      setControlEnabled(false)
      throw new Error(`Control endpoint gate did not open (${probe.detail}); unmount and mount the Control runtime once, then enable the endpoint.`)
    }
  }
  return controlResult(
    opts.action,
    opts.action === 'enable' ? 'enabled' : 'disabled',
    opts.action === 'enable' ? 'running' : 'gated',
    state,
  )
}

export interface ControlServiceStatusOpts {
  home?: string
  timeoutMs?: number
  paths?: StackPaths
  env?: Record<string, string | undefined>
}

export interface ControlServiceStatus {
  state: ControlLifecycleState
  service: 'ok' | 'down' | 'gated' | 'unmounted'
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
      service: 'gated',
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
      optimization: 'runtime remains loaded; the Control endpoint is blocked by the local gate',
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

function controlComposeContainerMounted(paths: StackPaths, env?: Record<string, string | undefined>): boolean | undefined {
  const argv = composeArgv(paths, ['ps', '--all', '-q', 'control'], true)
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: paths.cwd,
    env: { ...process.env, ...controlManagedEnv(env, true) },
    encoding: 'utf8',
  })
  if (result.status !== 0) return undefined
  return typeof result.stdout === 'string' && result.stdout.trim().length > 0
}

function reconciledControlState(opts: ControlServiceStatusOpts): ControlRuntimeState | undefined {
  const state = readControlState(opts.home)
  if (!state) return undefined
  if (!state.enabled && !state.mountedAt) {
    setControlMounted(false, false, { home: opts.home })
    return undefined
  }
  if (state.enabled && !existsSync(controlGateFile(opts.home))) {
    return setControlEnabled(false, { home: opts.home })
  }
  if (!opts.paths) return state
  const mounted = controlComposeContainerMounted(opts.paths, opts.env)
  if (mounted === false) {
    setControlMounted(false, false, { home: opts.home })
    return undefined
  }
  return state
}

export async function controlServiceStatus(opts: ControlServiceStatusOpts = {}): Promise<ControlServiceStatus> {
  authorizeControlManagementAccess()
  const state = reconciledControlState(opts)
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
    probes: [{ name: state.service, url: state.readyUrl, port: state.port }],
    timeoutMs: opts.timeoutMs,
  })
  if (probe?.detail === '503') {
    const disabled = setControlEnabled(false, { home: opts.home }) ?? { ...state, enabled: false }
    return enabledControlStatus(disabled, {
      name: state.service,
      url: state.readyUrl,
      port: state.port,
      ok: false,
      detail: 'endpoint disabled',
    }, opts.home)
  }
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
    for (const name of ['caracal', 'caracal-terminal', 'caracal-terminal']) {
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
