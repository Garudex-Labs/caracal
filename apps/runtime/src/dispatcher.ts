// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared dispatcher kernel: builds usage text and routes argv through the runtime CLI registry.

import { COMMAND_NAME_PATTERN, type CommandGroup } from '@caracalai/engine/commands'
import { RuntimeConfigMissingError, RuntimeConfigValidationError, loadRuntimeIdentity } from '@caracalai/engine/runtime-config'
import { formatVersionOutput } from '@caracalai/engine'
import { style, printError } from './style.ts'
import type { CommandRegistry } from './registry.ts'
import type { RuntimeIdentity } from './config.ts'

const GROUP_TITLES: Record<CommandGroup, string> = {
  stack: 'STACK',
  runtime: 'RUNTIME',
  admin: 'ADMIN',
  observability: 'OBSERVABILITY',
  multiagent: 'MULTI-AGENT',
}

export interface DispatchOptions {
  readonly binary: string
  readonly version: string
  readonly mode: 'dev' | 'rc' | 'stable'
  readonly sha: string
  readonly registry: CommandRegistry
  readonly loadConfig?: boolean
}

function loadConfig(required: boolean): RuntimeIdentity | undefined {
  return loadRuntimeIdentity(required)
}

export function printUsage(opts: DispatchOptions, out: NodeJS.WriteStream = process.stderr): void {
  const lines: string[] = [
    style.brand('Caracal CLI'),
    '',
    style.dim('Secure AI authority, identity, and runtime for governed agent execution.'),
    '',
    style.title('Usage:'),
    `  ${opts.binary} <command> [options]`,
    '',
  ]
  const groups = new Map<CommandGroup, typeof opts.registry.ordered>()
  for (const b of opts.registry.ordered) {
    if (b.descriptor.hidden) continue
    const list = (groups.get(b.descriptor.group) ?? []) as Array<typeof b>
    list.push(b)
    groups.set(b.descriptor.group, list)
  }
  for (const group of Object.keys(GROUP_TITLES) as CommandGroup[]) {
    const items = groups.get(group)
    if (!items || items.length === 0) continue
    lines.push(style.section(GROUP_TITLES[group]))
    if (group === 'multiagent') lines.push(style.dim('  Requires CARACAL_COORDINATOR_TOKEN.'))
    for (const b of items) {
      lines.push(`  ${style.command(b.descriptor.name.padEnd(14))} ${style.dim(b.descriptor.summary)}`)
      if (b.descriptor.subcommands?.length) {
        lines.push(style.dim(`    subcommands: ${b.descriptor.subcommands.join(', ')}`))
      }
    }
    lines.push('')
  }
  lines.push(
    style.section('GLOBAL OPTIONS'),
    `  ${style.flag('-h, --help'.padEnd(14))} ${style.dim('Show help')}`,
    `  ${style.flag('-v, --version'.padEnd(14))} ${style.dim('Show version')}`,
    '',
  )
  out.write(lines.join('\n'))
}

function isHelpToken(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h'
}

export async function dispatch(opts: DispatchOptions, rawArgs: readonly string[]): Promise<void> {
  const argv = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const command = argv[0]
  const rest = argv.slice(1)

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage(opts, process.stdout)
    process.exit(0)
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    if (rest.includes('--json')) {
      process.stdout.write(
        JSON.stringify({
          binary: opts.binary,
          version: opts.version,
          mode: opts.mode,
          sha: opts.sha,
        }) + '\n',
      )
    } else {
      process.stdout.write(formatVersionOutput(opts))
    }
    process.exit(0)
  }
  if (!COMMAND_NAME_PATTERN.test(command) || !opts.registry.byName.has(command)) {
    printError('unknown command')
    printUsage(opts, process.stderr)
    process.exit(1)
  }

  const binding = opts.registry.byName.get(command)!
  // A leading help token, or a missing required operand, must reach the command's own
  // help/usage path without first demanding runtime config the user has no chance to supply.
  const operands = rest[0] === '--' ? rest.slice(1) : rest
  const skipConfig = isHelpToken(rest[0]) || ((binding.descriptor.requiresArgs ?? false) && operands.length === 0)
  let cfg: RuntimeIdentity | undefined
  if (opts.loadConfig && !skipConfig) {
    try {
      cfg = loadConfig(binding.descriptor.requiresConfig ?? false)
    } catch (err) {
      if (err instanceof RuntimeConfigMissingError || err instanceof RuntimeConfigValidationError) {
        printError(err.message)
        process.exit(1)
      }
      throw err
    }
  }
  await binding.run(rest, cfg)
}
