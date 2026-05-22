// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal TUI entry point bootstraps the AdminClient and launches the menu.

import '@caracalai/engine/scrubCwdEnv'
import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'
import {
  buildAdminClient,
  formatVersionOutput,
} from '@caracalai/engine'
import {
  resolveCliConfigPath,
  type CliConfig,
} from '@caracalai/engine/cli'
import { installCrashHandlers } from '@caracalai/engine/crash'
import { App } from './screen.ts'
import { CARACAL_TUI_MODE, CARACAL_TUI_SHA, CARACAL_TUI_VERSION } from './version.gen.ts'
import { MenuView } from './views/menu.ts'

function loadConfig(): CliConfig | undefined {
  const path = resolveCliConfigPath()
  if (!path) return undefined
  return parse(readFileSync(path, 'utf8')) as unknown as CliConfig
}

function nonInteractiveReason(): string | undefined {
  if (!process.stdin.isTTY) return 'stdin is not a TTY'
  if (!process.stdout.isTTY) return 'stdout is not a TTY'
  if (typeof (process as { send?: unknown }).send === 'function') return 'launched with an IPC channel'
  const term = process.env.TERM
  if (!term || term === 'dumb') return 'TERM is unset or "dumb"'
  if (process.env.CI === 'true') return 'CI=true detected'
  return undefined
}

function printHelp(): void {
  const bin = process.env.CARACAL_INVOKED_AS ?? 'caracal-tui'
  process.stdout.write(
    [
      `Usage: ${bin} [--help] [--version]`,
      '',
      'Caracal Terminal UI — interactive admin console for the Caracal control plane.',
      '',
      'Options:',
      '  --help, -h            Show this help',
      '  --version, -v         Show version',
      '',
      'Inside the TUI use arrow keys / number shortcuts to navigate; press `?` for in-app help.',
      '',
    ].join('\n'),
  )
}

function main(): void {
  installCrashHandlers('caracal-tui', { exitOnError: false })
  const command = process.argv[2]
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    return
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    const bin = process.env.CARACAL_INVOKED_AS ?? 'caracal-tui'
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({
        binary: bin,
        version: CARACAL_TUI_VERSION,
        mode: CARACAL_TUI_MODE,
        sha: CARACAL_TUI_SHA,
      }) + '\n')
    } else {
      process.stdout.write(formatVersionOutput({
        binary: bin,
        version: CARACAL_TUI_VERSION,
        mode: CARACAL_TUI_MODE,
        sha: CARACAL_TUI_SHA,
      }))
    }
    return
  }
  const reason = nonInteractiveReason()
  if (reason) {
    process.stderr.write(
      `caracal-tui: ${reason}\n` +
      'TUI accepts input only from a controlling terminal. Use caracal-cli or the SDK for automation.\n',
    )
    process.exit(1)
  }
  let adminCtx: import('@caracalai/engine').AdminContext
  try {
    const cfg = loadConfig()
    adminCtx = buildAdminClient(cfg)
  } catch (err) {
    process.stderr.write(`caracal-tui: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
  const menu = new MenuView(adminCtx.client, adminCtx.zoneId)
  const app = new App('Caracal TUI', () => {
    const zid = menu.currentZoneId()
    return `${adminCtx.apiUrl}${zid ? `  zone:${zid}` : ''}`
  })
  void app.run(menu)
}

main()
