// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PATH-based locator and executor for optional sibling Caracal interface binaries.

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { printError, printInfo } from '../style.ts'

const EXT = process.platform === 'win32' ? '.exe' : ''
const CLI_INSTALL_URL = 'https://github.com/Garudex-Labs/caracal/releases/latest/download/install-cli.sh'
const TUI_INSTALL_URL = 'https://github.com/Garudex-Labs/caracal/releases/latest/download/install-tui.sh'
const INSTALL_HINTS = {
  cli: `Install the CLI:  curl -fsSL ${CLI_INSTALL_URL} | sh`,
  tui: `Install the TUI:  curl -fsSL ${TUI_INSTALL_URL} | sh`,
} as const

const WORKSPACE_SHIMS: Record<string, string> = {
  'caracal-cli': 'apps/cli/bin/caracal-cli.mjs',
  'caracal-tui': 'apps/tui/bin/caracal-tui.mjs',
}

const KNOWN_SIBLINGS = Object.freeze(Object.keys(WORKSPACE_SHIMS))

const INVOKED_AS: Record<string, string> = {
  'caracal-cli': 'caracal cli',
  'caracal-tui': 'caracal tui',
}

const SHELL_COMMANDS_BY_SIBLING: Record<string, string> = {
  'caracal-cli': 'cli',
  'caracal-tui': 'tui',
}

function assertKnownSibling(binName: string): void {
  if (!KNOWN_SIBLINGS.includes(binName)) {
    throw new Error(`execSibling: refusing to dispatch to non-whitelisted binary '${binName}'`)
  }
}

function workspaceShim(binName: string): { cmd: string; argvPrefix: string[] } | undefined {
  const root = process.env.CARACAL_REPO_ROOT
  if (!root) return undefined
  const rel = WORKSPACE_SHIMS[binName]
  if (!rel) return undefined
  const shim = join(root, rel)
  try { if (existsSync(shim) && statSync(shim).isFile()) return { cmd: process.execPath, argvPrefix: [shim] } } catch { /* ignore */ }
  return undefined
}

function searchDirs(): string[] {
  const dirs: string[] = []
  const path = process.env.PATH ?? ''
  for (const d of path.split(delimiter)) if (d) dirs.push(d)
  try {
    const here = dirname(process.execPath)
    if (here && !dirs.includes(here)) dirs.unshift(here)
  } catch { /* ignore */ }
  return dirs
}

function locate(binName: string): string | undefined {
  for (const dir of searchDirs()) {
    const candidate = join(dir, `${binName}${EXT}`)
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch { /* ignore */ }
  }
  return undefined
}

export function siblingAvailable(binName: string): boolean {
  assertKnownSibling(binName)
  if (workspaceShim(binName)) return true
  if (process.env.CARACAL_REPO_ROOT) return false
  return locate(binName) !== undefined
}

export function availableInterfaceCommands(): string[] {
  return KNOWN_SIBLINGS
    .filter((binName) => siblingAvailable(binName))
    .map((binName) => SHELL_COMMANDS_BY_SIBLING[binName]!)
}

interface MissingHints {
  readonly installLine: string
  readonly altLine?: string
}

export function execSibling(binName: string, argv: string[], hints: MissingHints): never {
  assertKnownSibling(binName)
  const shim = workspaceShim(binName)
  if (!shim && process.env.CARACAL_REPO_ROOT) {
    printError(`workspace shim for '${binName}' is missing under CARACAL_REPO_ROOT.`)
    process.exit(127)
  }
  const cmd = shim?.cmd ?? locate(binName)
  if (!cmd) {
    printError(`'${binName}' is not installed.`)
    printInfo(hints.installLine)
    if (hints.altLine) printInfo(hints.altLine)
    process.exit(127)
  }
  const fullArgs = shim ? [...shim.argvPrefix, ...argv] : argv
  const result = spawnSync(cmd, fullArgs, {
    stdio: 'inherit',
    env: { ...process.env, CARACAL_INVOKED_AS: INVOKED_AS[binName] },
  })
  if (result.error) {
    printError(`failed to launch ${binName}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.signal) {
    const signo = osConstants.signals[result.signal as keyof typeof osConstants.signals]
    process.exit(typeof signo === 'number' ? 128 + signo : 1)
  }
  process.exit(result.status ?? 0)
}

export function cliDispatch(argv: string[]): never {
  execSibling('caracal-cli', argv, { installLine: INSTALL_HINTS.cli })
}

export function tuiDispatch(argv: string[]): never {
  execSibling('caracal-tui', argv, { installLine: INSTALL_HINTS.tui })
}
