// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for stack lifecycle: init (bootstrap + write toml), up, down, status, purge.

import { rmSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { runExec } from './run.js'

export interface StackPaths {
  composeFile: string
  envFile: string
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

function composeArgv(paths: StackPaths, args: string[]): string[] {
  return ['docker', 'compose', '--env-file', paths.envFile, '-f', paths.composeFile, ...args]
}

export function stackUp(opts: StackComposeOpts): StackComposeHandle {
  const args = opts.paths.mode === 'dev'
    ? ['up', '-d', '--build', '--remove-orphans', ...opts.args]
    : ['up', '-d', '--remove-orphans', ...opts.args]
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

// Returns probes for the active deployment surface. Includes the optional control
// service only when CARACAL_CONTROL_ENABLED=true so default `up`/`status` flows stay unchanged.
export function defaultServiceProbes(): ServiceProbe[] {
  const probes = [...DEFAULT_SERVICE_PROBES]
  if (process.env.CARACAL_CONTROL_ENABLED === 'true') {
    const port = Number(process.env.CONTROL_PORT ?? 8087)
    probes.push({ name: 'control', url: `http://localhost:${port}/health`, port })
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
