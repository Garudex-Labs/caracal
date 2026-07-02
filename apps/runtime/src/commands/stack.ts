// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal up | down | status | upgrade`: docker-compose lifecycle, health probes,
// and no-window upgrades for the OSS stack.

import { spawnSync } from 'node:child_process'
import {
  composeRun,
  defaultServiceProbes,
  resolveStackPaths,
  stackDown,
  stackStatus,
  stackUp,
  type ProbeKind,
  type StackMode,
  type StackPaths,
} from '@caracalai/engine'
import { flagBool, parseArgs, printJSON, showHelp } from './shared.ts'
import { CARACAL_MODE, CARACAL_REGISTRY, CARACAL_SHA, CARACAL_VERSION } from '../runtime/version.gen.ts'
import { style, SYMBOL, printError, printInfo } from '../style.ts'
import { completeRuntimeOnboarding } from './onboarding.ts'

function resolveMode(): StackMode {
  const override = process.env.CARACAL_MODE
  if (override === 'dev' || override === 'rc' || override === 'stable') return override
  if (override) {
    printError(`CARACAL_MODE must be 'dev', 'rc', or 'stable' (got '${override}')`)
    process.exit(1)
  }
  return CARACAL_MODE
}

export function resolvePaths(quiet = false): StackPaths {
  try {
    return resolveStackPaths({ mode: resolveMode(), onInfo: quiet ? undefined : printInfo })
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

export function dockerComposeAvailable(): boolean {
  return (
    spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0 &&
    spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
  )
}

export function composeUnavailableReason(): string {
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
    return 'docker compose is not available; install Docker with the Compose plugin or add docker to PATH'
  }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    return 'docker daemon is not reachable; start Docker Desktop (macOS/Windows) or the docker service (Linux) and ensure your user can access the Docker socket'
  }
  return 'docker compose is not available; install Docker with the Compose plugin or add docker to PATH'
}

function requireDockerCompose(): void {
  if (dockerComposeAvailable()) return
  printError(composeUnavailableReason())
  process.exit(1)
}

function requireBuildKit(): void {
  if (spawnSync('docker', ['buildx', 'version'], { stdio: 'ignore' }).status === 0) return
  printError(
    'BuildKit is required to build the Caracal stack but `docker buildx` is not available. ' +
      'Install the buildx plugin: https://docs.docker.com/build/architecture/#install-buildx',
  )
  process.exit(1)
}

function printBanner(paths: StackPaths): void {
  const tag = paths.mode === 'dev' ? `dev (sha ${CARACAL_SHA})` : `${paths.mode} (${CARACAL_VERSION})`
  process.stdout.write(`${style.label('caracal mode:')} ${style.header(tag)}\n`)
}

export function composeEnv(paths: StackPaths): Record<string, string | undefined> {
  // Build-time pins are authoritative in rc/stable. They are forwarded so compose
  // substitution sees the same values the loader enforces; the schema's pinned
  // check then rejects any conflicting override file or process.env entry.
  const env: Record<string, string | undefined> = {
    CARACAL_MODE: paths.mode,
    CARACAL_SECRETS_DIR: paths.secretsDir,
    DOCKER_BUILDKIT: '1',
    COMPOSE_DOCKER_CLI_BUILD: '1',
  }
  if (paths.mode !== 'dev') {
    env.CARACAL_VERSION = CARACAL_VERSION
    env.CARACAL_REGISTRY = CARACAL_REGISTRY
  } else {
    env.CARACAL_DEV_SHA = CARACAL_SHA
    env.CARACAL_DEV_VERSION = CARACAL_VERSION
  }
  return env
}

export async function upCommand(argv: string[]): Promise<void> {
  const paths = resolvePaths()
  requireDockerCompose()
  if (paths.mode === 'dev') requireBuildKit()
  printBanner(paths)
  const handle = stackUp({ paths, args: argv, env: composeEnv(paths) })
  const code = await handle.exitCode
  if (code === 0 && argv.length === 0) {
    try {
      await completeRuntimeOnboarding()
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  }
  process.exit(code)
}

export async function downCommand(argv: string[]): Promise<void> {
  const paths = resolvePaths()
  requireDockerCompose()
  printBanner(paths)
  const handle = stackDown({ paths, args: argv, env: composeEnv(paths) })
  const code = await handle.exitCode
  process.exit(code)
}

async function composeStep(paths: StackPaths, args: string[], env: Record<string, string | undefined>): Promise<boolean> {
  const handle = composeRun({ paths, args, env })
  return (await handle.exitCode) === 0
}

export async function upgradeCommand(argv: string[]): Promise<void> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return upgradeHelp()
  const { flags } = parseArgs(argv)
  const paths = resolvePaths()
  requireDockerCompose()
  if (paths.mode === 'dev') requireBuildKit()
  printBanner(paths)
  const env = composeEnv(paths)

  // Stage the new images before touching the running stack. dev rebuilds from
  // source; rc/stable fetch the release pinned into this binary.
  if (paths.mode === 'dev') {
    if (!(await composeStep(paths, ['build'], env))) process.exit(1)
  } else if (!flagBool(flags, 'no-pull')) {
    printInfo(`fetching ${CARACAL_VERSION} images`)
    if (!(await composeStep(paths, ['pull'], env))) process.exit(1)
  }

  // Apply migrations while the previous version keeps serving. Releases ship
  // expand-only schema changes, so the running services stay compatible with
  // the migrated database and no maintenance window is required.
  printInfo('applying database migrations (expand phase)')
  if (!(await composeStep(paths, ['run', '--rm', 'dbMigrate'], env))) {
    printError('migration failed; the stack still runs the previous version')
    process.exit(1)
  }

  // Roll services onto the new images. Compose recreates only the containers
  // whose image changed; expand/contract keeps both versions readable.
  printInfo('rolling services onto the new version')
  const handle = stackUp({ paths, args: [], env })
  const code = await handle.exitCode
  if (code !== 0) process.exit(code)

  try {
    await completeRuntimeOnboarding()
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  process.exit(0)
}

function upgradeHelp(): never {
  return showHelp([
    'Usage: caracal upgrade [--no-pull]',
    '',
    'Upgrades the local stack to the version pinned in this binary with no',
    'maintenance window: stage images, apply expand-phase migrations while the',
    'current version keeps serving, roll services, then gate on readiness.',
    '',
    'Flags:',
    '  --no-pull               Reuse local images instead of pulling the release',
    '  --help, -h              Show this help',
    '',
  ])
}

export async function statusCommand(argv: string[] = []): Promise<void> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return statusHelp()
  const { flags } = parseArgs(argv)
  const kind: ProbeKind = flagBool(flags, 'ready') ? 'ready' : 'health'
  const json = flagBool(flags, 'json')
  const paths = resolvePaths(json)
  const probes = defaultServiceProbes(kind)
  const results = await stackStatus({ probes })
  if (json) {
    printJSON({ mode: kind, services: results })
    process.exitCode = results.every((r) => r.ok) ? 0 : 1
    return
  }
  printBanner(paths)
  const width = probes.reduce((m, s) => Math.max(m, s.name.length), 0)
  let allOk = true
  process.stdout.write(
    `${style.header('service'.padEnd(width))}  ${style.header('port ')}  ${style.header('mode  ')}  ${style.header('status')}  ${style.header('detail')}\n`,
  )
  for (const r of results) {
    if (!r.ok) allOk = false
    const mark = r.ok ? style.success(SYMBOL.ok) : style.error(SYMBOL.fail)
    const status = r.ok ? style.success('ok  ') : style.error('down')
    process.stdout.write(
      `${r.name.padEnd(width)}  ${String(r.port).padStart(5)}  ${kind.padEnd(6)}  ${mark} ${status}  ${style.label(r.detail)}\n`,
    )
  }
  process.exitCode = allOk ? 0 : 1
}

function statusHelp(): never {
  return showHelp([
    'Usage: caracal status [--ready] [--json]',
    '',
    'Checks local stack service health. Use --ready for dependency-aware readiness probes.',
    '',
    'Flags:',
    '  --ready                 Probe /ready instead of /health',
    '  --json                  Emit machine-readable output',
    '  --help, -h              Show this help',
    '',
  ])
}
