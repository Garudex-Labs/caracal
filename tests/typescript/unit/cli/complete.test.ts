// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the CLI autocomplete engine: token boundaries, context filtering, ranking, and hidden exclusion.

import { describe, it, expect } from 'vitest'
import { complete, tokenize } from '../../../../apps/cli/src/complete.ts'
import { buildRegistry } from '../../../../apps/cli/src/registry.ts'
import { CLI_COMMANDS } from '../../../../packages/core/ts/src/commands.ts'

const registry = buildRegistry(CLI_COMMANDS, Object.fromEntries(CLI_COMMANDS.map((c) => [c.name, () => undefined])))
const ctx = { cfg: undefined, hasZone: false, builtins: [{ value: 'help', summary: 'Show help' }, { value: 'exit', summary: 'Quit' }], limit: 8 }

describe('tokenize', () => {
  it('splits whitespace tokens with positions', () => {
    const t = tokenize('zone list --json')
    expect(t.map((x) => x.value)).toEqual(['zone', 'list', '--json'])
    expect(t[0]).toMatchObject({ start: 0, end: 4 })
    expect(t[1]).toMatchObject({ start: 5, end: 9 })
  })
  it('respects single quotes', () => {
    const t = tokenize("zone create --name 'my zone'")
    expect(t.map((x) => x.value)).toEqual(['zone', 'create', '--name', 'my zone'])
  })
})

describe('complete', () => {
  it('returns all visible commands at empty input', () => {
    const r = complete(registry, '', 0, ctx)
    const names = r.suggestions.map((s) => s.value)
    expect(names).toContain('zone')
    expect(names).not.toContain('completion')
  })
  it('prefix-matches command names', () => {
    const r = complete(registry, 'zo', 2, ctx)
    expect(r.suggestions[0]?.value).toBe('zone')
    expect(r.suggestions[0]?.matchLength).toBe(2)
  })
  it('disables commands that need a zone when none configured', () => {
    const r = complete(registry, 'aud', 3, ctx)
    const aud = r.suggestions.find((s) => s.value === 'audit')
    expect(aud?.disabled).toBe(true)
    expect(aud?.disabledReason).toBe('requires zone')
  })
  it('switches to subcommands after the first token + space', () => {
    const r = complete(registry, 'zone ', 5, ctx)
    expect(r.suggestions.map((s) => s.value)).toEqual(['list', 'get', 'create', 'patch', 'delete'])
  })
  it('filters subcommands by prefix', () => {
    const r = complete(registry, 'zone cr', 7, ctx)
    expect(r.suggestions.map((s) => s.value)).toEqual(['create'])
  })
  it('returns nothing when command has no subcommands', () => {
    const r = complete(registry, 'run ', 4, ctx)
    expect(r.suggestions).toEqual([])
  })
  it('rejects hidden commands from completion entirely', () => {
    const r = complete(registry, 'comp', 4, ctx)
    expect(r.suggestions.find((s) => s.value === 'completion')).toBeUndefined()
  })
  it('respects the limit', () => {
    const r = complete(registry, '', 0, { ...ctx, limit: 3 })
    expect(r.suggestions.length).toBe(3)
  })
})
