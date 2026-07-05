// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for `caracal allowlist`: file contract, permissions, entry lifecycle, and command behavior.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  allowlistAdd,
  allowlistRemove,
  allowlistSetStatus,
  normalizeAllowlistEntry,
  operatorAllowlistPath,
  readOperatorAllowlist,
  OPERATOR_ALLOWLIST_DIR,
  OPERATOR_ALLOWLIST_FILE,
} from '../../../../packages/engine/src/operatorAllowlist.ts'

vi.mock('../../../../apps/runtime/src/commands/stack.ts', () => ({
  resolvePaths: () => ({ secretsDir: dir }),
}))

const { allowlistCommand } = await import('../../../../apps/runtime/src/commands/allowlist.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-allowlist-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('normalizeAllowlistEntry', () => {
  it('normalizes emails and domain suffixes', () => {
    expect(normalizeAllowlistEntry(' Richard.Hendricks@PiedPiper.example ')).toBe('richard.hendricks@piedpiper.example')
    expect(normalizeAllowlistEntry('@PiedPiper.example')).toBe('@piedpiper.example')
  })

  it('rejects values that are neither an email nor a @domain suffix', () => {
    expect(() => normalizeAllowlistEntry('not-an-email')).toThrow(/invalid entry/)
    expect(() => normalizeAllowlistEntry('@')).toThrow(/invalid entry/)
    expect(() => normalizeAllowlistEntry('a@b@c')).toThrow(/invalid entry/)
  })
})

describe('allowlist file contract', () => {
  it('writes a sorted emails map with owner-only mode', () => {
    allowlistAdd(dir, 'monica.hall@piedpiper.example')
    const change = allowlistAdd(dir, 'gavin.belson@hooli.example')
    expect(change.path).toBe(join(dir, OPERATOR_ALLOWLIST_DIR, OPERATOR_ALLOWLIST_FILE))
    const record = JSON.parse(readFileSync(change.path, 'utf8')) as { emails: Record<string, string> }
    expect(Object.keys(record.emails)).toEqual(['gavin.belson@hooli.example', 'monica.hall@piedpiper.example'])
    if (process.platform !== 'win32') {
      expect(statSync(change.path).mode & 0o777).toBe(0o600)
    }
  })

  it('reads an absent file as an empty allowlist', () => {
    expect(readOperatorAllowlist(dir)).toEqual({ emails: {} })
  })

  it('refuses to operate on a corrupted file', () => {
    allowlistAdd(dir, 'monica.hall@piedpiper.example')
    writeFileSync(operatorAllowlistPath(dir), 'not json')
    expect(() => allowlistAdd(dir, 'gavin.belson@hooli.example')).toThrow(/not valid JSON/)
    expect(() => readOperatorAllowlist(dir)).toThrow(/not valid JSON/)
  })
})

describe('entry lifecycle', () => {
  it('adds, locks, unlocks, and removes an entry', () => {
    expect(allowlistAdd(dir, 'richard.hendricks@piedpiper.example').outcome).toBe('added')
    expect(allowlistAdd(dir, 'richard.hendricks@piedpiper.example').outcome).toBe('unchanged')
    expect(allowlistSetStatus(dir, 'richard.hendricks@piedpiper.example', 'locked').outcome).toBe('locked')
    expect(readOperatorAllowlist(dir).emails['richard.hendricks@piedpiper.example']).toBe('locked')
    expect(allowlistSetStatus(dir, 'richard.hendricks@piedpiper.example', 'locked').outcome).toBe('unchanged')
    expect(allowlistSetStatus(dir, 'richard.hendricks@piedpiper.example', 'active').outcome).toBe('unlocked')
    expect(allowlistRemove(dir, 'richard.hendricks@piedpiper.example').outcome).toBe('removed')
    expect(readOperatorAllowlist(dir).emails).toEqual({})
  })

  it('does not reactivate a locked entry through add', () => {
    allowlistAdd(dir, 'richard.hendricks@piedpiper.example')
    allowlistSetStatus(dir, 'richard.hendricks@piedpiper.example', 'locked')
    expect(allowlistAdd(dir, 'richard.hendricks@piedpiper.example').outcome).toBe('locked')
    expect(readOperatorAllowlist(dir).emails['richard.hendricks@piedpiper.example']).toBe('locked')
  })

  it('reports missing entries for remove, lock, and unlock', () => {
    expect(allowlistRemove(dir, 'monica.hall@piedpiper.example').outcome).toBe('missing')
    expect(allowlistSetStatus(dir, 'monica.hall@piedpiper.example', 'locked').outcome).toBe('missing')
    expect(allowlistSetStatus(dir, 'monica.hall@piedpiper.example', 'active').outcome).toBe('missing')
  })
})

describe('allowlistCommand', () => {
  function run(argv: string[]): { code: number | undefined; out: string } {
    let exitCode: number | undefined
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error('exit')
    }) as never)
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as never)
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
    try {
      allowlistCommand(argv)
    } catch {
      // process.exit is mocked to throw so the command stops where it would exit
    } finally {
      exit.mockRestore()
      write.mockRestore()
    }
    return { code: exitCode, out: writes.join('') }
  }

  it('adds an entry and persists it', () => {
    const { code } = run(['add', 'Richard.Hendricks@PiedPiper.example'])
    expect(code).toBe(0)
    expect(readOperatorAllowlist(dir).emails['richard.hendricks@piedpiper.example']).toBe('active')
  })

  it('lists entries with their status', () => {
    run(['add', 'richard.hendricks@piedpiper.example'])
    run(['lock', 'richard.hendricks@piedpiper.example'])
    const { code, out } = run(['list'])
    expect(code).toBe(0)
    expect(out).toContain('richard.hendricks@piedpiper.example')
    expect(out).toContain('locked')
  })

  it('explains the posture when the allowlist is empty', () => {
    const { code, out } = run(['list'])
    expect(code).toBe(0)
    expect(out).toContain('open in development, closed in production')
  })

  it('directs add on a locked entry to unlock and exits 1', () => {
    run(['add', 'richard.hendricks@piedpiper.example'])
    run(['lock', 'richard.hendricks@piedpiper.example'])
    const { code } = run(['add', 'richard.hendricks@piedpiper.example'])
    expect(code).toBe(1)
    expect(readOperatorAllowlist(dir).emails['richard.hendricks@piedpiper.example']).toBe('locked')
  })

  it('rejects unknown subcommands and malformed entries', () => {
    expect(run(['ban', 'richard.hendricks@piedpiper.example']).code).toBe(1)
    expect(run(['add', 'not-an-email']).code).toBe(1)
    expect(run(['add']).code).toBe(1)
    expect(run(['remove', 'monica.hall@piedpiper.example']).code).toBe(1)
  })

  it('shows help when no subcommand is given', () => {
    const { code, out } = run([])
    expect(code).toBe(0)
    expect(out).toContain('Usage: caracal allowlist <subcommand> [email]')
    expect(existsSync(operatorAllowlistPath(dir))).toBe(false)
  })
})
