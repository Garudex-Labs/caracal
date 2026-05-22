// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Central terminal style system: semantic colors, symbols, and writers shared across every Caracal CLI command.

import { scrubTokens } from '@caracalai/engine/crash'

const RESET = '\x1b[0m'

const SGR = {
  success: '\x1b[1;32m',
  warn: '\x1b[1;33m',
  error: '\x1b[1;31m',
  info: '\x1b[36m',
  progress: '\x1b[1;36m',
  prompt: '\x1b[1;35m',
  header: '\x1b[1;4m',
  title: '\x1b[1m',
  label: '\x1b[2m',
  code: '\x1b[35m',
  diffAdd: '\x1b[32m',
  diffRemove: '\x1b[31m',
  debug: '\x1b[2;3m',
  accent: '\x1b[1;35m',
  dim: '\x1b[2m',
  kbd: '\x1b[7m',
  selected: '\x1b[1;7;35m',
} as const

type Tone = keyof typeof SGR

function envFlag(name: string): boolean {
  const v = process.env[name]
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (envFlag('NO_COLOR')) return false
  if (envFlag('CARACAL_NO_COLOR')) return false
  if (envFlag('FORCE_COLOR') || envFlag('CARACAL_COLOR')) return true
  return Boolean(stream.isTTY)
}

const utf8 = (process.env.LANG ?? process.env.LC_ALL ?? '').toLowerCase().includes('utf')
  || process.platform === 'darwin'
  || process.platform === 'linux'

export const SYMBOL = {
  ok: utf8 ? '✓' : '+',
  fail: utf8 ? '✗' : 'x',
  warn: utf8 ? '⚠' : '!',
  info: utf8 ? 'ℹ' : 'i',
  step: utf8 ? '→' : '>',
  bullet: utf8 ? '•' : '*',
  prompt: '?',
} as const

function paint(stream: NodeJS.WriteStream, tone: Tone, text: string): string {
  if (!colorEnabled(stream)) return text
  return `${SGR[tone]}${text}${RESET}`
}

export const style = {
  success: (s: string) => paint(process.stdout, 'success', s),
  warn: (s: string) => paint(process.stdout, 'warn', s),
  error: (s: string) => paint(process.stderr, 'error', s),
  info: (s: string) => paint(process.stdout, 'info', s),
  progress: (s: string) => paint(process.stdout, 'progress', s),
  prompt: (s: string) => paint(process.stdout, 'prompt', s),
  header: (s: string) => paint(process.stdout, 'header', s),
  title: (s: string) => paint(process.stdout, 'title', s),
  label: (s: string) => paint(process.stdout, 'label', s),
  code: (s: string) => paint(process.stdout, 'code', s),
  diffAdd: (s: string) => paint(process.stdout, 'diffAdd', s),
  diffRemove: (s: string) => paint(process.stdout, 'diffRemove', s),
  debug: (s: string) => paint(process.stdout, 'debug', s),
  accent: (s: string) => paint(process.stdout, 'accent', s),
  dim: (s: string) => paint(process.stdout, 'dim', s),
  kbd: (s: string) => paint(process.stdout, 'kbd', s),
  selected: (s: string) => paint(process.stdout, 'selected', s),
}

export function colorOn(stream: NodeJS.WriteStream = process.stdout): boolean {
  return colorEnabled(stream)
}

function write(stream: NodeJS.WriteStream, tone: Tone, line: string): void {
  stream.write(`${paint(stream, tone, line)}\n`)
}

export function printSuccess(msg: string): void {
  write(process.stdout, 'success', `${SYMBOL.ok} ${msg}`)
}

export function printError(msg: string): void {
  write(process.stderr, 'error', `${SYMBOL.fail} ${scrubTokens(msg)}`)
}

export function printWarn(msg: string): void {
  write(process.stdout, 'warn', `${SYMBOL.warn} ${msg}`)
}

export function printInfo(msg: string): void {
  write(process.stdout, 'info', `${SYMBOL.info} ${msg}`)
}

export function printStep(msg: string): void {
  write(process.stdout, 'progress', `${SYMBOL.step} ${msg}`)
}

export function printHeader(msg: string): void {
  process.stdout.write(`\n${style.header(msg)}\n`)
}
