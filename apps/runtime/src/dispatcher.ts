// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared dispatcher kernel: builds usage text and routes argv through the runtime CLI registry.

import { COMMAND_NAME_PATTERN, type CommandGroup } from '@caracalai/engine/commands'
import {
  RuntimeConfigMissingError,
  RuntimeConfigValidationError,
  loadRuntimeConfig as loadValidatedRuntimeConfig,
} from '@caracalai/engine/runtime-config'
import { formatVersionOutput } from '@caracalai/engine'
import { style, printError } from './style.ts'
import type { CommandRegistry } from './registry.ts'
import type { RuntimeConfig } from './config.ts'

const GROUP_TITLES: Record<CommandGroup, string> = {
  stack: 'Stack',
  runtime: 'Runtime',
  admin: 'Admin',
  observability: 'Observability',
  multiagent: 'Multi-agent',
}

export interface DispatchOptions {
  readonly binary: string
  readonly version: string
  readonly mode: 'dev' | 'rc' | 'stable'
  readonly sha: string
  readonly registry: CommandRegistry
  readonly extras?: readonly string[]
  readonly loadConfig?: boolean
}

function loadConfig(required: boolean): RuntimeConfig | undefined {
  return loadValidatedRuntimeConfig(required)
}

export function loadRuntimeConfig(required: boolean): RuntimeConfig | undefined {
  return loadConfig(required)
}

export function printUsage(opts: DispatchOptions, out: NodeJS.WriteStream = process.stderr): void {
  const H = (s: string) => style.header(s)
  const lines: string[] = [
    `${style.title('Usage:')} ${opts.binary} <command> [options]`,
    '',
    'Caracal local runtime: start the stack, open the console, execute governed workloads.',
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
    lines.push(H(GROUP_TITLES[group]))
    if (group === 'multiagent') lines.push('  Requires CARACAL_COORDINATOR_TOKEN.')
    for (const b of items) {
      lines.push(`  ${b.descriptor.name.padEnd(14)} ${b.descriptor.summary}`)
      if (b.descriptor.subcommands?.length) {
        lines.push(`    ${style.label('subcommands:')} ${b.descriptor.subcommands.join(', ')}`)
      }
    }
    lines.push('')
  }
  if (opts.extras && opts.extras.length > 0) {
    lines.push(H('Command options'))
    for (const line of opts.extras) lines.push(line)
    lines.push('')
  }
  lines.push(H('Global options'), '  -h, --help      Show help', '  -v, --version   Show version', '')
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
  let cfg: RuntimeConfig | undefined
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
