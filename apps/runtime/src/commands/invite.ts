// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal invite <email>`: mints the one-time invite code that authorizes the first console sign-up.

import { mintOperatorInvite } from '@caracalai/engine'
import { showHelp } from './shared.ts'
import { printError, printInfo, style } from '../style.ts'
import { resolvePaths } from './stack.ts'

export function inviteCommand(argv: string[] = []): void {
  const arg = argv[0]
  if (arg === undefined || arg === 'help' || arg === '--help' || arg === '-h') return inviteHelp()
  if (argv.length > 1) {
    printError('invite takes exactly one email address')
    process.exit(1)
  }
  const email = arg.trim().toLowerCase()
  if (!email.includes('@')) {
    printError(`'${arg}' is not an email address`)
    process.exit(1)
  }
  const paths = resolvePaths(true)
  if (!paths.secretsDir) {
    printError('no secrets directory is configured for this stack')
    process.exit(1)
  }
  const invite = mintOperatorInvite(paths.secretsDir, email)
  // The code is shown exactly once and never written anywhere in plaintext; the invite file
  // keeps only its hash, so a lost code means minting a fresh invite.
  printInfo(`invite minted for ${invite.email} (expires ${invite.expiresAt})`)
  process.stdout.write('\n')
  process.stdout.write(`  ${style.header('Invite code')}  ${style.code(invite.code)}\n`)
  process.stdout.write('\n')
  process.stdout.write(`${style.label('Shown once and stored only as a hash. Open the console sign-in page, choose')}\n`)
  process.stdout.write(`${style.label(`the first-operator bootstrap option, and sign up as ${invite.email} with this code.`)}\n`)
  process.stdout.write(`${style.label('The invite works for that email only and expires in one hour.')}\n`)
  process.exit(0)
}

function inviteHelp(): never {
  return showHelp([
    'Usage: caracal invite <email>',
    '',
    'Mints a one-time invite code that authorizes the first sign-in on this',
    "install's web console. The code is printed once; only its hash is stored,",
    "in the platform's secrets directory. Minting again replaces any live invite.",
    '',
    'Flags:',
    '  --help, -h              Show this help',
    '',
  ])
}
