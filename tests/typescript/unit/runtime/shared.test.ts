// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime shared helpers: argv parser and flag coercions.

import { describe, it, expect, vi } from 'vitest'
import {
  parseArgs,
  flagString,
  flagBool,
  flagInt,
  flagList,
  printJSON,
  printTable,
  showHelp,
  unknownVerb,
  usage,
} from '../../../../apps/runtime/src/commands/shared.ts'

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

describe('shared printers and exits', () => {
  it('prints JSON and table output for empty and structured rows', () => {
    let stdout = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    try {
      printJSON({ ok: true })
      printTable([], ['name'])
      printTable([{ name: 'Pied Piper', scopes: ['read', 'write'], meta: { zone: 'prod' }, empty: null }], ['name', 'scopes', 'meta', 'empty'])

      expect(stdout).toContain('"ok": true')
      expect(stdout).toContain('(no rows)')
      expect(stdout).toContain('Pied Piper')
      expect(stdout).toContain('read,write')
      expect(stdout).toContain('{"zone":"prod"}')
      expect(stdout).toContain('-')
    } finally {
      write.mockRestore()
    }
  })

  it('routes help-like unknown verbs to help and exits cleanly', () => {
    const help = vi.fn()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    try {
      expect(() => unknownVerb('runtime', '--help', help)).toThrow('exit:0')
      expect(help).toHaveBeenCalledOnce()
    } finally {
      exit.mockRestore()
    }
  })

  it('prints usage, command help, and unknown verb errors with exit codes', () => {
    let stdout = ''
    let stderr = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    try {
      expect(() => showHelp(['hello', 'world'])).toThrow('exit:0')
      expect(stdout).toContain('hello\nworld')
      expect(() => usage('up [services...]')).toThrow('exit:1')
      expect(stderr).toContain('Usage:')
      expect(() => unknownVerb('runtime', 'bogus', () => { stdout += 'help text' })).toThrow('exit:1')
      expect(stderr).toContain("unknown runtime verb 'bogus'")
      expect(stdout).toContain('help text')
    } finally {
      out.mockRestore()
      err.mockRestore()
      exit.mockRestore()
    }
  })
})
