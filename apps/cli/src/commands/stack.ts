// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal up | down | status`: docker-compose lifecycle and health probes for the OSS stack.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CARACAL_MODE, CARACAL_VERSION } from '../runtime/version.ts'
import { installRuntimeAssets, runtimePaths, seedEnvFile } from '../runtime/install.ts'
import { style, SYMBOL, printError, printInfo } from '../style.ts'

interface StackPaths {
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

function devPaths(repoRoot: string): StackPaths {
  const composeFile = join(repoRoot, 'infra', 'docker', 'docker-compose.yml')
  const envFile = process.env.CARACAL_ENV_FILE ?? join(repoRoot, 'infra', 'docker', '.env')
  if (!existsSync(envFile)) {
    printError(`env file not found at ${envFile}; copy infra/docker/.env.example to infra/docker/.env first.`)
    process.exit(1)
  }
  const { seeded } = seedEnvFile(envFile)
  if (seeded) {
    printInfo(`seeded missing secrets in ${envFile}`)
  }
  return { composeFile, envFile, cwd: repoRoot, mode: 'dev' }
}

function runtimeStackPaths(): StackPaths {
  const paths = runtimePaths()
  const { created } = installRuntimeAssets(paths)
  if (created) {
    printInfo(`provisioned runtime assets at ${paths.home}`)
  }
  const envFile = process.env.CARACAL_ENV_FILE ?? paths.envFile
  const { seeded } = seedEnvFile(envFile)
  if (seeded) {
    printInfo(`seeded missing secrets in ${envFile}`)
  }
  return { composeFile: paths.composeFile, envFile, cwd: paths.home, mode: 'runtime' }
}

function resolveMode(): 'dev' | 'runtime' {
  const override = process.env.CARACAL_MODE
  if (override === 'dev' || override === 'runtime') return override
  if (override) {
    printError(`CARACAL_MODE must be 'dev' or 'runtime' (got '${override}')`)
    process.exit(1)
  }
  return CARACAL_MODE
}

export function resolvePaths(): StackPaths {
  const mode = resolveMode()
  if (mode === 'dev') {
    const repoRoot = process.env.CARACAL_REPO_ROOT
    if (!repoRoot) {
      printError(
        'CARACAL_MODE=dev requires CARACAL_REPO_ROOT; invoke via `pnpm caracal` from inside the repo.',
      )
      process.exit(1)
    }
    return devPaths(repoRoot)
  }
  return runtimeStackPaths()
}

function printBanner(paths: StackPaths): void {
  const tag =
    paths.mode === 'dev'
      ? `dev (sha ${process.env.CARACAL_DEV_SHA ?? 'unknown'})`
      : `runtime (v${CARACAL_VERSION})`
  process.stdout.write(`${style.label('caracal mode:')} ${style.header(tag)}\n`)
}

function runCompose(args: string[], paths: StackPaths): Promise<number> {
  return new Promise((resolveExit) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CARACAL_MODE: paths.mode }
    if (paths.mode === 'runtime' && !env.CARACAL_VERSION) {
      env.CARACAL_VERSION = CARACAL_VERSION.startsWith('v') ? CARACAL_VERSION : `v${CARACAL_VERSION}`
    }
    if (paths.mode === 'dev' && !env.CARACAL_DEV_SHA) {
      env.CARACAL_DEV_SHA = 'nogit'
    }
    const proc = spawn(
      'docker',
      ['compose', '--env-file', paths.envFile, '-f', paths.composeFile, ...args],
      { stdio: 'inherit', cwd: paths.cwd, env },
    )
    proc.on('exit', (code, signal) => {
      if (typeof code === 'number') return resolveExit(code)
      if (signal) {
        const map: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1, SIGQUIT: 3 }
        return resolveExit(128 + (map[signal] ?? 15))
      }
      resolveExit(1)
    })
    proc.on('error', (err) => {
      printError(`failed to invoke docker compose: ${err.message}`)
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
  printBanner(paths)
  const args = paths.mode === 'dev' ? ['up', '-d', '--build', ...argv] : ['up', '-d', ...argv]
  const code = await runCompose(args, paths)
  process.exit(code)
}

export async function downCommand(argv: string[]): Promise<void> {
  const paths = resolvePaths()
  printBanner(paths)
  const code = await runCompose(['down', ...argv], paths)
  process.exit(code)
}

export async function statusCommand(): Promise<void> {
  const paths = resolvePaths()
  printBanner(paths)
  const results = await Promise.all(
    SERVICE_PROBES.map(async (svc) => ({ svc, ...(await probe(svc)) })),
  )
  const width = SERVICE_PROBES.reduce((m, s) => Math.max(m, s.name.length), 0)
  let allOk = true
  process.stdout.write(
    `${style.header('service'.padEnd(width))}  ${style.header('port ')}  ${style.header('status')}  ${style.header('detail')}\n`,
  )
  for (const { svc, ok, detail } of results) {
    if (!ok) allOk = false
    const mark = ok ? style.success(SYMBOL.ok) : style.error(SYMBOL.fail)
    const status = ok ? style.success('ok  ') : style.error('down')
    process.stdout.write(
      `${svc.name.padEnd(width)}  ${String(svc.port).padStart(5)}  ${mark} ${status}  ${style.label(detail)}\n`,
    )
  }
  process.exit(allOk ? 0 : 1)
}
