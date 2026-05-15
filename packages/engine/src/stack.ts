// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for stack lifecycle: init (bootstrap + write toml), up, down, status, purge.

import { mkdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { AdminClient, type LocalBootstrapResult } from '@caracalai/admin'
import { runExec } from './run.js'

export interface StackPaths {
  composeFile: string
  envFile: string
  cwd: string
  mode: 'dev' | 'runtime'
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
  return ['docker', 'compose', '--env-file', paths.envFile, '-f', paths.composeFile, ...args]
}

export function stackUp(opts: StackComposeOpts): StackComposeHandle {
  const args = opts.paths.mode === 'dev'
    ? ['up', '-d', '--build', ...opts.args]
    : ['up', '-d', ...opts.args]
  const handle = runExec({
    argv: composeArgv(opts.paths, args),
    env: opts.env,
    cwd: opts.paths.cwd,
    onLine: opts.onLine,
  })
  const exitCode = handle.exitCode.then(async (code) => {
    if (code !== 0) return code
    // Remove exited one-shot containers (e.g. dbMigrate) so they don't linger.
    const rm = runExec({ argv: composeArgv(opts.paths, ['rm', '-f']), env: opts.env, cwd: opts.paths.cwd })
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

export const DEFAULT_SERVICE_PROBES: ServiceProbe[] = [
  { name: 'api', url: 'http://localhost:3000/health', port: 3000 },
  { name: 'sts', url: 'http://localhost:8080/health', port: 8080 },
  { name: 'gateway', url: 'http://localhost:8081/health', port: 8081 },
  { name: 'audit', url: 'http://localhost:9090/health', port: 9090 },
  { name: 'coordinator', url: 'http://localhost:4000/health', port: 4000 },
]

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
  const probes = opts.probes ?? DEFAULT_SERVICE_PROBES
  const timeoutMs = opts.timeoutMs ?? 1500
  return Promise.all(probes.map((s) => probeOne(s, timeoutMs)))
}

export interface StackInitOpts {
  apiUrl: string
  adminToken: string
  zoneUrl: string
  configPath: string
  force?: boolean
}

export type StackInitOutcome =
  | { status: 'written'; configPath: string; data: LocalBootstrapResult }
  | { status: 'exists'; configPath: string; data: LocalBootstrapResult }

function renderToml(opts: {
  zoneUrl: string
  zoneId: string
  applicationId: string
  clientSecret: string
  resource: string
}): string {
  return [
    `zone_url = "${opts.zoneUrl}"`,
    `zone_id = "${opts.zoneId}"`,
    `application_id = "${opts.applicationId}"`,
    `app_client_secret = "${opts.clientSecret}"`,
    '',
    '[[credentials]]',
    'env = "RESOURCE_TOKEN"',
    `resource = "${opts.resource}"`,
    '',
    '[mcp_governance]',
    'mode = "block"',
    '',
  ].join('\n')
}

export async function stackInit(opts: StackInitOpts): Promise<StackInitOutcome> {
  const client = new AdminClient({ apiUrl: opts.apiUrl, adminToken: opts.adminToken })
  const data = await client.bootstrap(opts.force ?? false)

  if (!data.app_client_secret) {
    if (existsSync(opts.configPath)) {
      return { status: 'exists', configPath: opts.configPath, data }
    }
    throw new Error(
      'zone already provisioned but no local config exists; re-run with --force to rotate the client secret.',
    )
  }

  const toml = renderToml({
    zoneUrl: opts.zoneUrl,
    zoneId: data.zone_id,
    applicationId: data.application_id,
    clientSecret: data.app_client_secret,
    resource: data.resource,
  })

  mkdirSync(dirname(opts.configPath), { recursive: true })
  // Atomic write: a half-written caracal.toml from a crash mid-write is worse
  // than no file (the secret it would have held is unrecoverable from the
  // server's perspective once /bootstrap returned it).
  const tmp = `${opts.configPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, toml, { mode: 0o600 })
  renameSync(tmp, opts.configPath)
  return { status: 'written', configPath: opts.configPath, data }
}

// --- Purge primitives ---------------------------------------------------

export interface ComposeRunOpts {
  paths: StackPaths
  args: string[]
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
    for (const name of ['caracal', 'caracal-tui']) {
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
