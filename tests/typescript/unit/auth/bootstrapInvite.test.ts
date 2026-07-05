// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the first-operator bootstrap invite: file contract, code verification, rate window, and consumption.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeInvite, inviteAuthorizes, readInvite, verifyInviteCode } from '../../../../apps/auth/src/bootstrapInvite.ts'
import { loadConfig } from '../../../../apps/auth/src/config.ts'
import { enabledProviders } from '../../../../apps/auth/src/providers.ts'

const SAVED = { ...process.env }
const CODE = 'test-invite-code'
let dir: string
let invitePath: string
// The rate window is module-level state shared across tests; each test starts on a fresh
// fake clock a full day past the previous one (beyond any in-test time travel) so it always
// begins with a clean window.
let clock = Date.parse('2026-01-01T00:00:00Z')

function writeInvite(overrides: Partial<{ email: string; code: string; expiresAt: string }> = {}): void {
  const record = {
    email: overrides.email ?? 'richard.hendricks@piedpiper.example',
    code_sha256: createHash('sha256')
      .update(overrides.code ?? CODE)
      .digest('hex'),
    expires_at: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }
  writeFileSync(invitePath, JSON.stringify(record))
}

beforeEach(() => {
  clock += 24 * 60 * 60 * 1000
  vi.useFakeTimers()
  vi.setSystemTime(clock)
  dir = mkdtempSync(join(tmpdir(), 'caracal-invite-'))
  invitePath = join(dir, 'operatorInvite.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  process.env = { ...SAVED }
})

const cfg = () => ({ operatorInviteFile: invitePath })

describe('readInvite', () => {
  it('reads a live invite with a normalized email', () => {
    writeInvite({ email: 'Richard.Hendricks@PiedPiper.example' })
    expect(readInvite(invitePath)?.email).toBe('richard.hendricks@piedpiper.example')
  })

  it('reads as no invite when the path is empty or the file is missing', () => {
    expect(readInvite('')).toBeNull()
    expect(readInvite(invitePath)).toBeNull()
  })

  it('fails closed on malformed content', () => {
    writeFileSync(invitePath, 'not json')
    expect(readInvite(invitePath)).toBeNull()
    writeFileSync(invitePath, JSON.stringify({ email: 'a@b.c', code_sha256: 'zz', expires_at: new Date(Date.now() + 1000).toISOString() }))
    expect(readInvite(invitePath)).toBeNull()
  })

  it('fails closed once the invite has expired', () => {
    writeInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(readInvite(invitePath)).toBeNull()
  })
})

describe('inviteAuthorizes', () => {
  it('matches only the invited email, case-insensitively', () => {
    writeInvite()
    expect(inviteAuthorizes('Richard.Hendricks@PiedPiper.example', cfg())).toBe(true)
    expect(inviteAuthorizes('monica.hall@piedpiper.example', cfg())).toBe(false)
  })
})

describe('verifyInviteCode', () => {
  it('accepts the minted code for the invited email', () => {
    writeInvite()
    expect(verifyInviteCode(CODE, 'richard.hendricks@piedpiper.example', cfg())).toBe(true)
  })

  it('rejects a wrong code', () => {
    writeInvite()
    expect(verifyInviteCode('guessed-code', 'richard.hendricks@piedpiper.example', cfg())).toBe(false)
  })

  it('rejects a mismatched email even with the right code', () => {
    writeInvite()
    expect(verifyInviteCode(CODE, 'monica.hall@piedpiper.example', cfg())).toBe(false)
  })

  it('rejects the right code after expiry', () => {
    writeInvite()
    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    expect(verifyInviteCode(CODE, 'richard.hendricks@piedpiper.example', cfg())).toBe(false)
  })

  it('caps attempts per fixed window and recovers in the next one', () => {
    writeInvite()
    for (let i = 0; i < 10; i++) {
      expect(verifyInviteCode('guessed-code', 'richard.hendricks@piedpiper.example', cfg())).toBe(false)
    }
    expect(verifyInviteCode(CODE, 'richard.hendricks@piedpiper.example', cfg())).toBe(false)
    vi.setSystemTime(Date.now() + 60 * 1000)
    expect(verifyInviteCode(CODE, 'richard.hendricks@piedpiper.example', cfg())).toBe(true)
  })
})

describe('consumeInvite', () => {
  it('removes the invite file', () => {
    writeInvite()
    consumeInvite(cfg())
    expect(existsSync(invitePath)).toBe(false)
  })

  it('tolerates a missing file and an unset path', () => {
    expect(() => consumeInvite(cfg())).not.toThrow()
    expect(() => consumeInvite({ operatorInviteFile: '' })).not.toThrow()
  })
})

describe('providers bootstrapInvite flag', () => {
  function authConfig() {
    process.env.CARACAL_AUTH_DATABASE_URL = 'postgres://u:p@db:5432/caracal_auth'
    process.env.CARACAL_AUTH_SECRET = '0123456789abcdef0123456789abcdef'
    process.env.CARACAL_OPERATOR_INVITE_FILE = invitePath
    return loadConfig()
  }

  it('is true while a live invite exists and false otherwise', () => {
    writeInvite()
    expect(enabledProviders(authConfig()).bootstrapInvite).toBe(true)
    rmSync(invitePath)
    expect(enabledProviders(authConfig()).bootstrapInvite).toBe(false)
  })

  it('is false when the feature is not configured', () => {
    const config = authConfig()
    expect(enabledProviders({ ...config, operatorInviteFile: '' }).bootstrapInvite).toBe(false)
  })
})
