// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal Terminal entry point bootstraps the AdminClient and launches the menu.

import '@caracalai/engine/scrubCwdEnv'
import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'
import {
  buildAdminClient,
  formatVersionOutput,
} from '@caracalai/engine'
import {
  resolveRuntimeConfigPath,
  type RuntimeConfig,
} from '@caracalai/engine/runtime-config'
import { installCrashHandlers } from '@caracalai/engine/crash'
import { App } from './screen.ts'
import { CARACAL_TERMINAL_MODE, CARACAL_TERMINAL_SHA, CARACAL_TERMINAL_VERSION } from './version.gen.ts'
import { TerminalStateStore } from './state.ts'
import { MenuView } from './views/menu.ts'

function loadConfig(): RuntimeConfig | undefined {
  const path = resolveRuntimeConfigPath()
  if (!path) return undefined
  return parse(readFileSync(path, 'utf8')) as unknown as RuntimeConfig
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
  const bin = process.env.CARACAL_INVOKED_AS ?? 'caracal-terminal'
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
      'Inside the Terminal use arrow keys / number shortcuts to navigate; press `?` for in-app help.',
      '',
    ].join('\n'),
  )
}

function main(): void {
  installCrashHandlers('caracal-terminal', { exitOnError: false })
  const command = process.argv[2]
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    return
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    const bin = process.env.CARACAL_INVOKED_AS ?? 'caracal-terminal'
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({
        binary: bin,
        version: CARACAL_TERMINAL_VERSION,
        mode: CARACAL_TERMINAL_MODE,
        sha: CARACAL_TERMINAL_SHA,
      }) + '\n')
    } else {
      process.stdout.write(formatVersionOutput({
        binary: bin,
        version: CARACAL_TERMINAL_VERSION,
        mode: CARACAL_TERMINAL_MODE,
        sha: CARACAL_TERMINAL_SHA,
      }))
    }
    return
  }
  const reason = nonInteractiveReason()
  if (reason) {
    process.stderr.write(
      `caracal-terminal: ${reason}\n` +
      'Terminal accepts input only from a controlling terminal. Use the Control API or SDK for automation.\n',
    )
    process.exit(1)
  }
  let adminCtx: import('@caracalai/engine').AdminContext
  try {
    const cfg = loadConfig()
    adminCtx = buildAdminClient(cfg)
  } catch (err) {
    process.stderr.write(`caracal-terminal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
  const state = TerminalStateStore.load()
  const initialZoneId = process.env.CARACAL_ZONE_ID ? adminCtx.zoneId : state.selectedZoneId() ?? adminCtx.zoneId
  const menu = new MenuView(adminCtx.client, initialZoneId, state)
  const app = new App('Caracal Terminal', () => {
    const zid = menu.currentZoneId()
    return `${adminCtx.apiUrl}${zid ? `  zone:${zid}` : ''}`
  })
  void app.run(menu)
}

main()
