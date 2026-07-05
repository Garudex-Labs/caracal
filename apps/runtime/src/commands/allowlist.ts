// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal allowlist`: manages which emails may register and sign in on this install's web console.

import { allowlistAdd, allowlistRemove, allowlistSetStatus, readOperatorAllowlist } from '@caracalai/engine'
import { showHelp, printTable } from './shared.ts'
import { printError, printInfo, printSuccess, style } from '../style.ts'
import { resolvePaths } from './stack.ts'

const SUBCOMMANDS = new Set(['add', 'remove', 'lock', 'unlock', 'list'])

export function allowlistCommand(argv: string[] = []): void {
  const sub = argv[0]
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') return allowlistHelp()
  if (!SUBCOMMANDS.has(sub)) {
    printError(`unknown subcommand '${sub}': expected add, remove, lock, unlock, or list`)
    process.exit(1)
  }
  const paths = resolvePaths(true)
  if (!paths.secretsDir) {
    printError('no secrets directory is configured for this stack')
    process.exit(1)
  }
  try {
    if (sub === 'list') {
      if (argv.length > 1) {
        printError('list takes no arguments')
        process.exit(1)
      }
      listEntries(paths.secretsDir)
      process.exit(0)
    }
    const raw = argv[1]
    if (raw === undefined || argv.length > 2) {
      printError(`${sub} takes exactly one email address or @domain suffix`)
      process.exit(1)
    }
    mutateEntry(paths.secretsDir, sub, raw)
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  process.exit(0)
}

function listEntries(secretsDir: string): void {
  const list = readOperatorAllowlist(secretsDir)
  const rows = Object.entries(list.emails).map(([email, status]) => ({ email, status }))
  if (rows.length === 0) {
    printInfo('the allowlist is empty')
    process.stdout.write(`${style.label('Registration follows the deployment default: open in development, closed in production.')}\n`)
    return
  }
  printTable(rows, ['email', 'status'])
}

function mutateEntry(secretsDir: string, sub: string, raw: string): void {
  if (sub === 'add') {
    const change = allowlistAdd(secretsDir, raw)
    if (change.outcome === 'locked') {
      printError(`'${change.entry}' is on the allowlist but locked: run 'caracal allowlist unlock ${change.entry}' to restore access`)
      process.exit(1)
    }
    if (change.outcome === 'unchanged') printInfo(`'${change.entry}' is already on the allowlist`)
    else printSuccess(`'${change.entry}' may now register and sign in on the web console`)
    return
  }
  if (sub === 'remove') {
    const change = allowlistRemove(secretsDir, raw)
    if (change.outcome === 'missing') {
      printError(`'${change.entry}' is not on the allowlist`)
      process.exit(1)
    }
    printSuccess(`'${change.entry}' removed: registration and sign-in are no longer permitted`)
    return
  }
  const change = allowlistSetStatus(secretsDir, raw, sub === 'lock' ? 'locked' : 'active')
  if (change.outcome === 'missing') {
    printError(`'${change.entry}' is not on the allowlist`)
    process.exit(1)
  }
  if (sub === 'lock') {
    if (change.outcome === 'unchanged') printInfo(`'${change.entry}' is already locked`)
    else printSuccess(`'${change.entry}' locked: sign-in is blocked until unlocked; the account and its data stay`)
  } else {
    if (change.outcome === 'unchanged') printInfo(`'${change.entry}' is not locked`)
    else printSuccess(`'${change.entry}' unlocked: sign-in is permitted again`)
  }
}

function allowlistHelp(): never {
  return showHelp([
    'Usage: caracal allowlist <subcommand> [email]',
    '',
    'Controls which emails may register and sign in on this install\'s web console.',
    'The console\'s auth backend reads the list live: changes apply on the next',
    'request, with no restart. Entries are exact emails or @domain suffixes.',
    'While the list is empty, registration follows the deployment default:',
    'open in development, closed in production.',
    '',
    'Subcommands:',
    '  add <email>       Allow an email (or @domain) to register and sign in',
    '  remove <email>    Delete the entry; sign-in stops, the account and its data stay',
    '  lock <email>      Temporarily block sign-in; the entry and account data stay',
    '  unlock <email>    Restore sign-in for a locked entry',
    '  list              Show every entry and its status',
    '',
    'Flags:',
    '  --help, -h        Show this help',
    '',
  ])
}
