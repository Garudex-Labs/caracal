// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI autocomplete engine: token-aware, context-filtered suggestions over the registry for the interactive REPL.

import type { CommandRegistry } from './registry.ts'
import type { CommandDescriptor } from '@caracalai/core/commands'
import type { CliConfig } from './config.ts'

export type SuggestKind = 'command' | 'subcommand' | 'builtin' | 'flag'

export interface Suggestion {
  readonly value: string
  readonly kind: SuggestKind
  readonly summary: string
  readonly disabled: boolean
  readonly disabledReason?: string
  readonly matchStart: number
  readonly matchLength: number
}

export interface CompleteResult {
  readonly suggestions: Suggestion[]
  readonly tokenStart: number
  readonly tokenEnd: number
}

export interface CompleteContext {
  readonly cfg?: CliConfig
  readonly hasZone: boolean
  readonly builtins: readonly { value: string; summary: string }[]
  readonly limit: number
}

interface Token { value: string; start: number; end: number }

export function tokenize(line: string): Token[] {
  const out: Token[] = []
  let cur = ''
  let start = -1
  let quote: '"' | "'" | null = null
  let esc = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (esc) { if (start === -1) start = i - 1; cur += ch; esc = false; continue }
    if (ch === '\\' && !quote) { esc = true; continue }
    if (quote) {
      if (ch === quote) { quote = null; out.push({ value: cur, start, end: i + 1 }); cur = ''; start = -1; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; if (start === -1) start = i; continue }
    if (/\s/.test(ch)) {
      if (cur || start !== -1) { out.push({ value: cur, start, end: i }); cur = ''; start = -1 }
      continue
    }
    if (start === -1) start = i
    cur += ch
  }
  if (cur || start !== -1) out.push({ value: cur, start: start === -1 ? line.length : start, end: line.length })
  return out
}

function score(value: string, query: string): { matched: boolean; rank: number; matchStart: number; matchLength: number } {
  if (!query) return { matched: true, rank: 100, matchStart: 0, matchLength: 0 }
  const v = value.toLowerCase()
  const q = query.toLowerCase()
  if (v.startsWith(q)) return { matched: true, rank: 0, matchStart: 0, matchLength: q.length }
  const wb = v.indexOf('-' + q)
  if (wb >= 0) return { matched: true, rank: 1, matchStart: wb + 1, matchLength: q.length }
  const sub = v.indexOf(q)
  if (sub >= 0) return { matched: true, rank: 2, matchStart: sub, matchLength: q.length }
  return { matched: false, rank: -1, matchStart: 0, matchLength: 0 }
}

const COMMON_FLAGS = [
  { name: '--json', summary: 'Emit raw JSON instead of a table' },
  { name: '--help', summary: 'Show command help' },
]

const ZONE_FLAG = { name: '--zone', summary: 'Zone ID scope (overrides config and env)' }

export function complete(registry: CommandRegistry, line: string, cursor: number, ctx: CompleteContext): CompleteResult {
  const tokens = tokenize(line.slice(0, cursor))
  const trailingSpace = cursor > 0 && /\s/.test(line[cursor - 1] ?? '')
  const active: Token = trailingSpace || tokens.length === 0
    ? { value: '', start: cursor, end: cursor }
    : tokens[tokens.length - 1]!
  const prior = trailingSpace ? tokens : tokens.slice(0, -1)

  if (prior.length === 0) {
    return { suggestions: completeCommand(registry, active.value, ctx), tokenStart: active.start, tokenEnd: active.end }
  }

  const cmdName = prior[0]!.value
  const binding = registry.byName.get(cmdName)
  if (!binding || binding.descriptor.hidden) {
    return { suggestions: [], tokenStart: active.start, tokenEnd: active.end }
  }
  const { descriptor } = binding
  const subs = descriptor.subcommands

  if (prior.length === 1) {
    if (subs && subs.length > 0 && !active.value.startsWith('-')) {
      return { suggestions: completeSubcommand(subs, descriptor.summary, active.value, ctx.limit), tokenStart: active.start, tokenEnd: active.end }
    }
    return { suggestions: completeFlag(descriptor, undefined, prior, active.value, ctx), tokenStart: active.start, tokenEnd: active.end }
  }

  const subName = subs && subs.length > 0 ? prior[1]!.value : undefined
  if (active.value === '' || active.value.startsWith('-')) {
    return { suggestions: completeFlag(descriptor, subName, prior, active.value, ctx), tokenStart: active.start, tokenEnd: active.end }
  }
  return { suggestions: [], tokenStart: active.start, tokenEnd: active.end }
}

function completeCommand(registry: CommandRegistry, query: string, ctx: CompleteContext): Suggestion[] {
  const out: { sug: Suggestion; rank: number; order: number }[] = []
  let order = 0
  for (const b of registry.ordered) {
    if (b.descriptor.hidden) { order++; continue }
    const s = score(b.descriptor.name, query)
    if (!s.matched) { order++; continue }
    const needsZone = b.descriptor.requiresZone === true && !ctx.hasZone
    const needsCfg = b.descriptor.requiresConfig === true && !ctx.cfg
    out.push({
      sug: {
        value: b.descriptor.name,
        kind: 'command',
        summary: b.descriptor.summary,
        disabled: needsZone || needsCfg,
        disabledReason: needsZone ? 'select zone (--zone or zone_id)' : needsCfg ? 'requires caracal.toml' : undefined,
        matchStart: s.matchStart,
        matchLength: s.matchLength,
      },
      rank: s.rank,
      order: order++,
    })
  }
  for (const bi of ctx.builtins) {
    const s = score(bi.value, query)
    if (!s.matched) continue
    out.push({
      sug: { value: bi.value, kind: 'builtin', summary: bi.summary, disabled: false, matchStart: s.matchStart, matchLength: s.matchLength },
      rank: s.rank,
      order: order++,
    })
  }
  out.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return out.slice(0, ctx.limit).map((x) => x.sug)
}

function completeSubcommand(subs: readonly string[], parentSummary: string, query: string, limit: number): Suggestion[] {
  const out: { sug: Suggestion; rank: number; order: number }[] = []
  let order = 0
  for (const sub of subs) {
    const s = score(sub, query)
    if (!s.matched) { order++; continue }
    out.push({
      sug: {
        value: sub,
        kind: 'subcommand',
        summary: parentSummary,
        disabled: false,
        matchStart: s.matchStart,
        matchLength: s.matchLength,
      },
      rank: s.rank,
      order: order++,
    })
  }
  out.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return out.slice(0, limit).map((x) => x.sug)
}

function completeFlag(
  descriptor: CommandDescriptor,
  subName: string | undefined,
  prior: readonly Token[],
  query: string,
  ctx: CompleteContext,
): Suggestion[] {
  const seen = new Set<string>()
  for (const tok of prior) {
    if (!tok.value.startsWith('-')) continue
    const eq = tok.value.indexOf('=')
    seen.add(eq === -1 ? tok.value : tok.value.slice(0, eq))
  }

  const pool: { name: string; summary: string }[] = []
  const key = subName ?? ''
  for (const f of descriptor.flags?.[key] ?? []) pool.push(f)
  if (descriptor.requiresZone) pool.push(ZONE_FLAG)
  for (const f of COMMON_FLAGS) pool.push(f)

  const out: { sug: Suggestion; rank: number; order: number }[] = []
  let order = 0
  for (const f of pool) {
    if (seen.has(f.name)) { order++; continue }
    const s = score(f.name, query)
    if (!s.matched) { order++; continue }
    out.push({
      sug: {
        value: f.name,
        kind: 'flag',
        summary: f.summary,
        disabled: false,
        matchStart: s.matchStart,
        matchLength: s.matchLength,
      },
      rank: s.rank,
      order: order++,
    })
  }
  out.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return out.slice(0, ctx.limit).map((x) => x.sug)
}
