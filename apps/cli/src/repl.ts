// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interactive command shell for `caracal cli` (no args): controlled REPL with allowlisted dispatch, history, and on-demand inline + dropdown autocomplete.

import { createInterface, emitKeypressEvents, type Interface } from 'node:readline'
import { COMMAND_NAME_PATTERN } from '@caracalai/core/commands'
import { discoverAdminToken } from '@caracalai/core'
import { style, printError, colorOn, SYMBOL } from './style.ts'
import type { CommandRegistry } from './registry.ts'
import type { CliConfig } from './config.ts'
import { printUsage, type DispatchOptions } from './dispatcher.ts'
import { complete, type Suggestion } from './complete.ts'

export interface ReplOptions {
  readonly dispatchOptions: DispatchOptions
  readonly cfg?: CliConfig
}

function splitArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let esc = false
  for (const ch of line) {
    if (esc) { cur += ch; esc = false; continue }
    if (ch === '\\' && !quote) { esc = true; continue }
    if (quote) {
      if (ch === quote) { quote = null; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const BUILTINS = [
  { value: 'help', summary: 'Show help' },
  { value: 'clear', summary: 'Clear screen' },
  { value: 'exit', summary: 'Exit shell' },
  { value: 'quit', summary: 'Exit shell' },
] as const

const REPL_EXIT_SIGNAL: unique symbol = Symbol.for('caracal.replExit')

class ReplExit extends Error {
  readonly code: number;
  readonly [REPL_EXIT_SIGNAL] = true as const
  constructor(code: number) {
    super(`repl-exit:${code}`)
    this.name = 'ReplExit'
    this.code = code
  }
}

export function isReplExit(err: unknown): err is ReplExit {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[REPL_EXIT_SIGNAL] === true
}

interface GhostState {
  suggestions: Suggestion[]
  selected: number
  tokenStart: number
  tokenEnd: number
  painted: number
  summoned: boolean
}

type ReadlineInternal = { line: string; cursor: number; _refreshLine: () => void }

export async function startRepl(opts: ReplOptions): Promise<void> {
  if (!process.stdin.isTTY) {
    printError(`${opts.dispatchOptions.binary}: interactive shell requires a TTY (pass a command, e.g. \`${opts.dispatchOptions.binary} status\`)`)
    process.exit(1)
  }
  if (!process.env.CARACAL_ADMIN_TOKEN) {
    const cached = discoverAdminToken()
    if (cached) process.env.CARACAL_ADMIN_TOKEN = cached
  }
  const { registry } = opts.dispatchOptions
  const useGhost = colorOn(process.stdout)
  const makePrompt = (): string => {
    const zone = process.env.CARACAL_ZONE_ID
    const base = style.prompt('caracal')
    const scope = zone ? style.dim(` [${zone.slice(0, 8)}…]`) : ''
    return `${base}${scope}${style.label(' ❯ ')}`
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: makePrompt(),
    completer: useGhost ? noopCompleter : buildSimpleCompleter(registry),
    terminal: true,
    historySize: 500,
  })
  const prompt = (): void => { rl.setPrompt(makePrompt()); rl.prompt() }

  const ghost: GhostState = { suggestions: [], selected: 0, tokenStart: 0, tokenEnd: 0, painted: 0, summoned: false }
  if (useGhost) attachGhost(rl, registry, opts.cfg, ghost)

  printIntro(opts.dispatchOptions.version, useGhost)
  prompt()

  let exitCode = 0
  for await (const raw of rl) {
    resetGhost(ghost)
    clearPanel(ghost)
    const line = raw.trim()
    if (!line) { prompt(); continue }
    const args = splitArgs(line)
    const cmd = args[0]
    if (cmd === 'exit' || cmd === 'quit') { rl.close(); break }
    if (cmd === 'clear') { process.stdout.write('\x1b[2J\x1b[H'); prompt(); continue }
    if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === '?') {
      printUsage(opts.dispatchOptions, process.stdout)
      prompt()
      continue
    }
    if (!cmd || !COMMAND_NAME_PATTERN.test(cmd) || !registry.byName.has(cmd) || registry.byName.get(cmd)!.descriptor.hidden) {
      printError(`unknown command: ${cmd ?? ''} (type \`help\`)`)
      prompt()
      continue
    }
    const binding = registry.byName.get(cmd)!
    const origExit = process.exit
    process.exit = ((code?: number) => { throw new ReplExit(code ?? 0) }) as typeof process.exit
    try {
      await binding.run(args.slice(1), opts.cfg)
    } catch (err) {
      if (isReplExit(err)) {
        if (err.code !== 0) exitCode = err.code
      } else {
        exitCode = 1
        printError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      process.exit = origExit
    }
    prompt()
  }
  process.stdout.write('\n')
  if (exitCode !== 0) process.exit(exitCode)
}

const noopCompleter = (line: string, cb: (err: null, result: [string[], string]) => void): void => {
  cb(null, [[], line])
}

function buildSimpleCompleter(registry: CommandRegistry): (line: string) => [string[], string] {
  const visible = registry.ordered.filter((b) => !b.descriptor.hidden).map((b) => b.descriptor.name)
  const all = [...new Set([...visible, ...BUILTINS.map((b) => b.value)])].sort()
  return (line: string): [string[], string] => {
    const trimmed = line.trimStart()
    const firstSpace = trimmed.indexOf(' ')
    if (firstSpace === -1) {
      const hits = all.filter((c) => c.startsWith(trimmed))
      return [hits.length ? hits : all, trimmed]
    }
    return [[], line]
  }
}

function attachGhost(
  rl: Interface,
  registry: CommandRegistry,
  cfg: CliConfig | undefined,
  state: GhostState,
): void {
  emitKeypressEvents(process.stdin, rl)
  const internal = rl as unknown as ReadlineInternal

  const recompute = () => {
    const line = internal.line ?? ''
    const cursor = internal.cursor ?? line.length
    if (line.length === 0 && !state.summoned) {
      state.suggestions = []
      clearPanel(state)
      internal._refreshLine()
      return
    }
    const result = complete(registry, line, cursor, {
      cfg,
      hasZone: hasZone(cfg),
      builtins: BUILTINS,
      limit: Number.MAX_SAFE_INTEGER,
    })
    state.suggestions = result.suggestions
    state.tokenStart = result.tokenStart
    state.tokenEnd = result.tokenEnd
    if (state.selected >= state.suggestions.length) state.selected = 0
    paintGhost(internal, state)
  }

  const onKey = (_ch: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (!key) return
    if (key.ctrl && (key.name === 'c' || key.name === 'd')) { dismiss(internal, state); return }
    if (key.name === 'tab') {
      if (state.summoned && pickAcceptable(state)) { acceptSuggestion(internal, state); recompute(); return }
      state.summoned = true
      recompute()
      return
    }
    if (key.name === 'right' && atLineEnd(internal) && pickAcceptable(state) && state.painted > 0) {
      acceptSuggestion(internal, state); recompute(); return
    }
    if (state.summoned && key.name === 'up' && state.suggestions.length > 1) {
      state.selected = (state.selected - 1 + state.suggestions.length) % state.suggestions.length
      paintGhost(internal, state)
      return
    }
    if (state.summoned && key.name === 'down' && state.suggestions.length > 1) {
      state.selected = (state.selected + 1) % state.suggestions.length
      paintGhost(internal, state)
      return
    }
    if (key.name === 'escape') { dismiss(internal, state); return }
    if (key.name === 'return' || key.name === 'enter') { resetGhost(state); clearPanel(state); return }
    state.summoned = false
    setImmediate(recompute)
  }

  process.stdin.on('keypress', onKey)
  rl.on('close', () => { process.stdin.removeListener('keypress', onKey) })
}

function resetGhost(state: GhostState): void {
  state.suggestions = []
  state.selected = 0
  state.tokenStart = 0
  state.tokenEnd = 0
  state.summoned = false
}

function dismiss(internal: ReadlineInternal, state: GhostState): void {
  state.suggestions = []
  state.summoned = false
  clearPanel(state)
  internal._refreshLine()
}

function pickAcceptable(state: GhostState): boolean {
  const sug = state.suggestions[state.selected]
  return Boolean(sug)
}

function atLineEnd(internal: ReadlineInternal): boolean {
  const line = internal.line ?? ''
  return (internal.cursor ?? 0) >= line.length
}

function paintGhost(internal: ReadlineInternal, state: GhostState): void {
  clearPanel(state)
  internal._refreshLine()
  if (state.suggestions.length === 0) return
  const sug = state.suggestions[state.selected]
  if (state.summoned && sug && atLineEnd(internal)) {
    const typed = internal.line.slice(state.tokenStart, internal.cursor)
    if (sug.value.toLowerCase().startsWith(typed.toLowerCase())) {
      const tail = sug.value.slice(typed.length)
      if (tail) {
        process.stdout.write(style.dim(tail))
        process.stdout.write(`\x1b[${tail.length}D`)
      }
    }
  }
  drawPanel(state)
}

function drawPanel(state: GhostState): void {
  if (!state.summoned) return
  const rows = state.suggestions
  if (rows.length === 0) return
  const out = process.stdout
  out.write('\x1b7')
  out.write('\n\x1b[2K' + style.label(' Suggestions'))
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i]!
    const marker = i === state.selected ? style.accent('›') : ' '
    const value = formatSuggestionValue(s)
    const note = s.disabled ? `${style.warn(SYMBOL.warn)} ${s.summary} (${s.disabledReason ?? 'unavailable'})` : s.summary
    out.write('\n\x1b[2K' + marker + ' ' + value + '  ' + note)
  }
  out.write(`\x1b[${rows.length + 1}A\x1b8`)
  state.painted = rows.length + 1
}

function clearPanel(state: GhostState): void {
  if (state.painted <= 0) return
  const out = process.stdout
  out.write('\x1b7')
  for (let i = 0; i < state.painted; i++) out.write('\n\x1b[2K')
  out.write(`\x1b[${state.painted}A\x1b8`)
  state.painted = 0
}

function acceptSuggestion(internal: ReadlineInternal, state: GhostState): void {
  const sug = state.suggestions[state.selected]
  if (!sug) return
  const before = internal.line.slice(0, state.tokenStart)
  const after = internal.line.slice(state.tokenEnd)
  const wantsTrailing = (sug.kind === 'command' || sug.kind === 'subcommand' || sug.kind === 'flag') && after.length === 0
  const insert = sug.value + (wantsTrailing ? ' ' : '')
  internal.line = before + insert + after
  internal.cursor = before.length + insert.length
  state.suggestions = []
  state.summoned = false
  clearPanel(state)
  internal._refreshLine()
}

function printIntro(version: string, useGhost: boolean): void {
  process.stdout.write(`${style.title('Caracal CLI')} ${style.label(version)}\n`)
  process.stdout.write(`Type ${style.code('help')} for commands or ${style.code('exit')} to leave the shell.\n`)
  if (useGhost) {
    process.stdout.write(`${style.kbd(' Tab ')} suggestions   ${style.kbd(' ↑↓ ')} move   ${style.kbd(' Tab ')} accept   ${style.kbd(' Esc ')} close\n`)
  }
}

function formatSuggestionValue(s: Suggestion): string {
  return s.value.padEnd(14)
}

function hasZone(cfg: CliConfig | undefined): boolean {
  if (!cfg) return false
  const zone = (cfg as unknown as { zone_id?: string }).zone_id
  return Boolean(zone) || Boolean(process.env.CARACAL_ZONE_ID)
}
