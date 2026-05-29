// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal Console entry point bootstraps the AdminClient and launches the menu.

import '@caracalai/engine/scrubCwdEnv'
import {
  buildAdminClient,
  formatVersionOutput,
} from '@caracalai/engine'
import { installCrashHandlers } from '@caracalai/engine/crash'
import { App } from './screen.ts'
import { CARACAL_CONSOLE_MODE, CARACAL_CONSOLE_SHA, CARACAL_CONSOLE_VERSION } from './version.gen.ts'
import { ConsoleStateStore } from './state.ts'
import { MenuView } from './views/menu.ts'

function nonInteractiveReason(): string | undefined {
  if (!process.stdin.isTTY) return 'stdin is not a TTY'
  if (!process.stdout.isTTY) return 'stdout is not a TTY'
  if (typeof (process as { send?: unknown }).send === 'function') return 'launched with an IPC channel'
  if (process.env.TERM === 'dumb') return 'TERM is "dumb"'
  if (process.env.CI === 'true') return 'CI=true detected'
  return undefined
}

function printHelp(): void {
  const bin = process.env.CARACAL_INVOKED_AS ?? 'caracal-console'
  process.stdout.write(
    [
      `Usage: ${bin} [--help] [--version]`,
      '',
      'Caracal Console UI: interactive admin console for the Caracal control plane.',
      '',
      'Options:',
      '  --help, -h            Show this help',
      '  --version, -v         Show version',
      '',
      'Inside the Console use arrow keys / number shortcuts to navigate; press `?` for in-app help.',
      '',
    ].join('\n'),
  )
}

function main(): void {
  installCrashHandlers('caracal-console', { exitOnError: false })
  const command = process.argv[2]
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    return
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    const bin = process.env.CARACAL_INVOKED_AS ?? 'caracal-console'
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({
        binary: bin,
        version: CARACAL_CONSOLE_VERSION,
        mode: CARACAL_CONSOLE_MODE,
        sha: CARACAL_CONSOLE_SHA,
      }) + '\n')
    } else {
      process.stdout.write(formatVersionOutput({
        binary: bin,
        version: CARACAL_CONSOLE_VERSION,
        mode: CARACAL_CONSOLE_MODE,
        sha: CARACAL_CONSOLE_SHA,
      }))
    }
    return
  }
  const reason = nonInteractiveReason()
  if (reason) {
    process.stderr.write(
      `caracal-console: ${reason}\n` +
      'Console requires an interactive TTY. Use the Control API or SDK for automation.\n',
    )
    process.exit(1)
  }
  let adminCtx: import('@caracalai/engine').AdminContext
  try {
    adminCtx = buildAdminClient()
  } catch (err) {
    process.stderr.write(`caracal-console: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
  const state = ConsoleStateStore.load()
  const initialZoneId = process.env.CARACAL_ZONE_ID ? adminCtx.zoneId : state.selectedZoneId() ?? adminCtx.zoneId
  const menu = new MenuView(adminCtx.client, initialZoneId, state)
  const app = new App('Caracal Console', () => {
    const zid = menu.currentZoneId()
    return `${adminCtx.apiUrl}${zid ? `  zone:${zid}` : ''}`
  })
  void app.run(menu)
}

main()
