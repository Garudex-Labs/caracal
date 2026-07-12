// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal config`: read and write the operator env file every caracal command loads.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { platform } from 'node:os'
import { operatorEnvTarget, readEnvEntries, removeEnvEntry, setEnvEntry } from '@caracalai/engine'
import { showHelp } from './shared.ts'
import { style, printError, printSuccess } from '../style.ts'

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|KEK|HMAC|PRIVATE)/i

function configHelp(): never {
  return showHelp([
    'Usage: caracal config <subcommand> [args]',
    '',
    'Read and write the operator env file that every caracal command loads',
    '(run, web, up). Works the same on every OS.',
    '',
    'Subcommands:',
    '  set KEY=VALUE     Set a variable, creating the file if needed',
    '  get KEY           Print one variable',
    '  unset KEY         Remove a variable',
    '  list              Print all variables (secret values masked)',
    '  path              Print the file path',
    '  edit              Open the file in $EDITOR',
    '',
    'Options:',
    '  --help, -h        Show this help',
    '',
  ])
}

function assertKey(key: string): void {
  if (KEY_PATTERN.test(key)) return
  printError(`invalid variable name '${key}'`)
  process.exit(1)
}

export async function configCommand(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') configHelp()
  const rest = argv.slice(1)
  const target = operatorEnvTarget()

  if (sub === 'path') {
    process.stdout.write(`${target}\n`)
    return
  }

  if (sub === 'list') {
    const entries = readEnvEntries(target)
    if (entries.size === 0) {
      process.stdout.write(style.label(`(empty) ${target}\n`))
      return
    }
    for (const key of [...entries.keys()].sort()) {
      process.stdout.write(`${key}=${SECRET_KEY.test(key) ? '***' : entries.get(key)!}\n`)
    }
    return
  }

  if (sub === 'get') {
    const key = rest[0]
    if (!key) {
      printError('usage: caracal config get KEY')
      process.exit(1)
    }
    assertKey(key)
    const value = readEnvEntries(target).get(key)
    if (value === undefined) process.exit(1)
    process.stdout.write(`${value}\n`)
    return
  }

  if (sub === 'set') {
    let key = rest[0]
    let value = rest[1]
    if (key && key.includes('=')) {
      const eq = key.indexOf('=')
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    if (!key || value === undefined) {
      printError('usage: caracal config set KEY=VALUE')
      process.exit(1)
    }
    assertKey(key)
    setEnvEntry(target, key, value)
    printSuccess(`set ${style.code(key)} in ${target}`)
    return
  }

  if (sub === 'unset') {
    const key = rest[0]
    if (!key) {
      printError('usage: caracal config unset KEY')
      process.exit(1)
    }
    assertKey(key)
    if (removeEnvEntry(target, key)) printSuccess(`unset ${style.code(key)} in ${target}`)
    else process.stdout.write(style.label(`(skip) ${key} not set in ${target}\n`))
    return
  }

  if (sub === 'edit') {
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '', { mode: 0o600 })
    }
    const editor = process.env.VISUAL || process.env.EDITOR || (platform() === 'win32' ? 'notepad' : 'vi')
    const result = spawnSync(editor, [target], { stdio: 'inherit' })
    process.exit(result.status ?? 0)
  }

  printError(`unknown subcommand '${sub}'; run \`caracal config --help\``)
  process.exit(1)
}
