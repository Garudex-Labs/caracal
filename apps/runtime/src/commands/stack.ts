// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal up | down | status`: docker-compose lifecycle and health probes for the OSS stack.

import {
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

function printBanner(paths: StackPaths): void {
  const tag =
    paths.mode === 'dev'
      ? `dev (sha ${CARACAL_SHA})`
      : `${paths.mode} (${CARACAL_VERSION})`
  process.stdout.write(`${style.label('caracal mode:')} ${style.header(tag)}\n`)
}

export function composeEnv(paths: StackPaths): Record<string, string | undefined> {
  // Build-time pins are authoritative in rc/stable. They are forwarded so compose
  // substitution sees the same values the loader enforces; the schema's pinned
  // check then rejects any conflicting override file or process.env entry.
  const env: Record<string, string | undefined> = { CARACAL_MODE: paths.mode }
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
  printBanner(paths)
  const handle = stackUp({ paths, args: argv, env: composeEnv(paths) })
  const code = await handle.exitCode
  process.exit(code)
}

export async function downCommand(argv: string[]): Promise<void> {
  const paths = resolvePaths()
  printBanner(paths)
  const handle = stackDown({ paths, args: argv, env: composeEnv(paths) })
  const code = await handle.exitCode
  process.exit(code)
}

export async function statusCommand(argv: string[] = []): Promise<void> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return statusHelp()
  const { flags } = parseArgs(argv)
  const kind: ProbeKind = flagBool(flags, 'ready') ? 'ready' : 'health'
  const json = flagBool(flags, 'json')
  const paths = resolvePaths(json)
  const probes = defaultServiceProbes(undefined, kind)
  const results = await stackStatus({ probes })
  if (json) {
    printJSON({ mode: kind, services: results })
    process.exit(results.every((r) => r.ok) ? 0 : 1)
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
  process.exit(allOk ? 0 : 1)
}

function statusHelp(): never {
  return showHelp(
    [
      'Usage: caracal status [--ready] [--json]',
      '',
      'Checks local stack service health. Use --ready for dependency-aware readiness probes.',
      '',
      'Flags:',
      '  --ready                 Probe /ready instead of /health',
      '  --json                  Emit machine-readable output',
      '  --help, -h              Show this help',
      '',
    ],
  )
}
