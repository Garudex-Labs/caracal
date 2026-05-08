// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal up | down | status`: docker-compose lifecycle and health probes for the OSS stack.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CARACAL_VERSION } from '../runtime/version.ts'
import { installRuntimeAssets, runtimePaths, seedEnvFile } from '../runtime/install.ts'

export interface StackPaths {
  composeFile: string
  envFile: string
  cwd: string
  mode: 'dev' | 'runtime'
}

interface ServiceProbe {
  name: string
  url: string
  port: number
}

const SERVICE_PROBES: ServiceProbe[] = [
  { name: 'api', url: 'http://localhost:3000/health', port: 3000 },
  { name: 'sts', url: 'http://localhost:8080/health', port: 8080 },
  { name: 'gateway', url: 'http://localhost:8081/health', port: 8081 },
  { name: 'audit', url: 'http://localhost:9090/health', port: 9090 },
  { name: 'coordinator', url: 'http://localhost:4000/health', port: 4000 },
]

function searchRepoRoot(start: string | undefined): string | undefined {
  if (!start) return undefined
  let dir = start
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(join(dir, 'infra', 'docker', 'docker-compose.yml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function findRepoRoot(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.CARACAL_REPO_ROOT,
    process.env.INIT_CWD,
    process.env.PWD,
    process.cwd(),
    moduleDir,
  ]
  for (const candidate of candidates) {
    const repoRoot = searchRepoRoot(candidate)
    if (repoRoot) return repoRoot
  }
  return undefined
}

function devPaths(repoRoot: string): StackPaths {
  const composeFile = join(repoRoot, 'infra', 'docker', 'docker-compose.yml')
  const envFile = process.env.CARACAL_ENV_FILE ?? join(repoRoot, 'infra', 'docker', '.env')
  if (!existsSync(envFile)) {
    process.stderr.write(
      `Error: env file not found at ${envFile}; copy infra/docker/.env.example to infra/docker/.env first.\n`,
    )
    process.exit(1)
  }
  const { seeded } = seedEnvFile(envFile)
  if (seeded) {
    process.stdout.write(`caracal: seeded missing secrets in ${envFile}\n`)
  }
  return { composeFile, envFile, cwd: repoRoot, mode: 'dev' }
}

function runtimeStackPaths(): StackPaths {
  const paths = runtimePaths()
  const { created } = installRuntimeAssets(paths)
  if (created) {
    process.stdout.write(`caracal: provisioned runtime assets at ${paths.home}\n`)
  }
  const envFile = process.env.CARACAL_ENV_FILE ?? paths.envFile
  const { seeded } = seedEnvFile(envFile)
  if (seeded) {
    process.stdout.write(`caracal: seeded missing secrets in ${envFile}\n`)
  }
  return { composeFile: paths.composeFile, envFile, cwd: paths.home, mode: 'runtime' }
}

export function resolvePaths(): StackPaths {
  if (process.env.CARACAL_STACK_MODE === 'runtime') return runtimeStackPaths()
  const repoRoot = findRepoRoot()
  if (repoRoot) return devPaths(repoRoot)
  return runtimeStackPaths()
}

function runCompose(args: string[], paths: StackPaths): Promise<number> {
  return new Promise((resolveExit) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (paths.mode === 'runtime' && !env.CARACAL_VERSION) {
      env.CARACAL_VERSION = CARACAL_VERSION
    }
    const proc = spawn(
      'docker',
      ['compose', '--env-file', paths.envFile, '-f', paths.composeFile, ...args],
      { stdio: 'inherit', cwd: paths.cwd, env },
    )
    proc.on('exit', (code) => resolveExit(code ?? 1))
    proc.on('error', (err) => {
      process.stderr.write(`Error: failed to invoke docker compose: ${err.message}\n`)
      resolveExit(127)
    })
  })
}

async function probe(svc: ServiceProbe): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(svc.url, { signal: ctrl.signal })
    return { ok: res.ok, detail: `${res.status}` }
  } catch (err) {
    const desc = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: desc.includes('aborted') ? 'timeout' : 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

export async function upCommand(argv: string[]): Promise<void> {
  const paths = resolvePaths()
  const args = paths.mode === 'dev' ? ['up', '-d', '--build', ...argv] : ['up', '-d', ...argv]
  const code = await runCompose(args, paths)
  process.exit(code)
}

export async function downCommand(argv: string[]): Promise<void> {
  const paths = resolvePaths()
  const code = await runCompose(['down', ...argv], paths)
  process.exit(code)
}

export async function statusCommand(): Promise<void> {
  const results = await Promise.all(
    SERVICE_PROBES.map(async (svc) => ({ svc, ...(await probe(svc)) })),
  )
  const width = SERVICE_PROBES.reduce((m, s) => Math.max(m, s.name.length), 0)
  let allOk = true
  for (const { svc, ok, detail } of results) {
    const status = ok ? 'ok' : 'down'
    if (!ok) allOk = false
    process.stdout.write(
      `${svc.name.padEnd(width)}  ${String(svc.port).padStart(5)}  ${status.padEnd(4)}  ${detail}\n`,
    )
  }
  process.exit(allOk ? 0 : 1)
}
