// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI shared helpers: argv parser, flag coercions, zone resolution.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AdminApiError } from '@caracalai/admin'
import {
  fail,
  parseArgs,
  flagString,
  flagBool,
  flagInt,
  flagList,
  requireZone,
} from '../../../../apps/cli/src/commands/shared.ts'

describe('parseArgs', () => {
  it('separates positional args and flags', () => {
    const out = parseArgs(['create', '--name', 'x', '--force'])
    expect(out.positional).toEqual(['create'])
    expect(out.flags).toEqual({ name: 'x', force: true })
  })

  it('treats following positional as the flag value when present', () => {
    const out = parseArgs(['--force', 'tail'])
    expect(out.positional).toEqual([])
    expect(out.flags).toEqual({ force: 'tail' })
  })

  it('accepts --key=value', () => {
    expect(parseArgs(['--limit=50']).flags).toEqual({ limit: '50' })
  })

  it('treats trailing flag without value as boolean', () => {
    expect(parseArgs(['--json']).flags).toEqual({ json: true })
  })

  it('does not consume the next flag as a value', () => {
    const out = parseArgs(['--zone', '--json'])
    expect(out.flags).toEqual({ zone: true, json: true })
  })
})

describe('flag coercions', () => {
  const flags = parseArgs(['--limit', '25', '--debug', '--scopes', 'a,b, c']).flags

  it('flagString returns string only', () => {
    expect(flagString(flags, 'limit')).toBe('25')
    expect(flagString(flags, 'debug')).toBeUndefined()
  })

  it('flagBool detects true and string "true"', () => {
    expect(flagBool(flags, 'debug')).toBe(true)
    expect(flagBool({ x: 'true' }, 'x')).toBe(true)
    expect(flagBool({}, 'missing')).toBe(false)
  })

  it('flagInt parses base-10 integers', () => {
    expect(flagInt(flags, 'limit')).toBe(25)
    expect(flagInt({ x: 'abc' }, 'x')).toBeUndefined()
  })

  it('flagList splits, trims, and drops empties', () => {
    expect(flagList(flags, 'scopes')).toEqual(['a', 'b', 'c'])
    expect(flagList({}, 'missing')).toBeUndefined()
  })
})

describe('requireZone', () => {
  let exit: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`__exit:${c ?? 0}`) }) as never)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => { exit.mockRestore(); stderr.mockRestore() })

  it('prefers --zone flag', () => {
    expect(requireZone({ client: {} as never, zoneId: 'cfg-zone' }, { zone: 'flag-zone' })).toBe('flag-zone')
    expect(exit).not.toHaveBeenCalled()
  })

  it('falls back to context zone', () => {
    expect(requireZone({ client: {} as never, zoneId: 'cfg-zone' }, {})).toBe('cfg-zone')
  })

  it('exits when no zone is available', () => {
    expect(() => requireZone({ client: {} as never, zoneId: undefined }, {})).toThrow(/__exit:1/)
    expect(stderr).toHaveBeenCalled()
  })
})

describe('fail', () => {
  let exit: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`__exit:${c ?? 0}`) }) as never)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => { exit.mockRestore(); stderr.mockRestore() })

  it('scrubs tokens from admin error bodies', () => {
    expect(() => fail(new AdminApiError(500, 'boom', {
      message: 'failed with Bearer abc.def.ghi',
    }))).toThrow(/__exit:1/)

    const text = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(text).not.toContain('abc.def.ghi')
    expect(text).toContain('***')
  })
})
