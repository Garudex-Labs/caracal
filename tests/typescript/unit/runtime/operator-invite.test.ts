// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for `caracal invite`: invite file contract, permissions, overwrite semantics, and command behavior.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintOperatorInvite, OPERATOR_INVITE_DIR, OPERATOR_INVITE_FILE } from '../../../../packages/engine/src/operatorInvite.ts'

const state = vi.hoisted(() => ({
  resolvePaths: vi.fn(),
}))

vi.mock('../../../../apps/runtime/src/commands/stack.ts', () => ({
  resolvePaths: state.resolvePaths,
}))

const { inviteCommand } = await import('../../../../apps/runtime/src/commands/invite.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-invite-cmd-'))
  state.resolvePaths.mockReturnValue({ secretsDir: dir })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('mintOperatorInvite', () => {
  it('writes the invite contract with a hashed code and owner-only mode', () => {
    const invite = mintOperatorInvite(dir, 'Richard.Hendricks@PiedPiper.example')
    const record = JSON.parse(readFileSync(invite.path, 'utf8')) as Record<string, string>

    expect(invite.path).toBe(join(dir, OPERATOR_INVITE_DIR, OPERATOR_INVITE_FILE))
    expect(record.email).toBe('richard.hendricks@piedpiper.example')
    expect(record.code_sha256).toBe(createHash('sha256').update(invite.code).digest('hex'))
    expect(Date.parse(record.expires_at!)).toBeGreaterThan(Date.now())
    expect(Date.parse(record.expires_at!)).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000)
    expect(readFileSync(invite.path, 'utf8')).not.toContain(invite.code)
    if (process.platform !== 'win32') {
      expect(statSync(invite.path).mode & 0o777).toBe(0o600)
    }
  })

  it('overwrites any prior invite so only one is ever live', () => {
    const first = mintOperatorInvite(dir, 'richard.hendricks@piedpiper.example')
    const second = mintOperatorInvite(dir, 'monica.hall@piedpiper.example')
    const record = JSON.parse(readFileSync(second.path, 'utf8')) as Record<string, string>

    expect(second.code).not.toBe(first.code)
    expect(record.email).toBe('monica.hall@piedpiper.example')
  })

  it('rejects a value without an @', () => {
    expect(() => mintOperatorInvite(dir, 'not-an-email')).toThrow(/invalid email/)
  })
})

describe('inviteCommand', () => {
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
      inviteCommand(argv)
    } catch {
      // process.exit is mocked to throw so the command stops where it would exit
    } finally {
      exit.mockRestore()
      write.mockRestore()
    }
    return { code: exitCode, out: writes.join('') }
  }

  it('mints an invite and prints the code once', () => {
    const { code, out } = run(['Richard.Hendricks@PiedPiper.example'])
    const record = JSON.parse(readFileSync(join(dir, OPERATOR_INVITE_DIR, OPERATOR_INVITE_FILE), 'utf8')) as Record<string, string>

    expect(code).toBe(0)
    expect(record.email).toBe('richard.hendricks@piedpiper.example')
    const minted = /Invite code\s+(\S+)/.exec(out.replaceAll(/\x1b\[[0-9;]*m/g, ''))
    expect(minted).not.toBeNull()
    expect(record.code_sha256).toBe(createHash('sha256').update(minted![1]!).digest('hex'))
  })

  it('rejects a value without an @', () => {
    const { code } = run(['not-an-email'])
    expect(code).toBe(1)
  })

  it('shows help when no email is given', () => {
    const { code, out } = run([])
    expect(code).toBe(0)
    expect(out).toContain('Usage: caracal invite <email>')
  })
})
