// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Console access decisions and denial enforcement: file contract, tombstones, and posture fallback.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enforceDenial, resolveAccess } from '../../../../apps/auth/src/allowlist.ts'

let dir: string
let allowlistPath: string

function writeAllowlist(emails: Record<string, string>): void {
  writeFileSync(allowlistPath, JSON.stringify({ emails }))
}

function cfg(overrides: { openRegistration?: boolean; path?: string } = {}) {
  return {
    operatorAllowlistFile: overrides.path ?? allowlistPath,
    openRegistration: overrides.openRegistration ?? false,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-auth-allowlist-'))
  allowlistPath = join(dir, 'operatorAllowlist.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('posture fallback', () => {
  it('follows open registration when no file, no path, or no entries exist', () => {
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg({ openRegistration: true }))).toBe('allowed')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('denied')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg({ openRegistration: true, path: '' }))).toBe('allowed')
    writeAllowlist({})
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg({ openRegistration: true }))).toBe('allowed')
  })

  it('reads malformed files as empty and fails closed in production posture', () => {
    writeFileSync(allowlistPath, 'not json')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('denied')
    writeFileSync(allowlistPath, JSON.stringify({ emails: ['richard.hendricks@piedpiper.example'] }))
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('denied')
  })

  it('never resolves removed from absence, so a wiped file can only deny', () => {
    writeAllowlist({ 'richard.hendricks@piedpiper.example': 'active' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('allowed')
    rmSync(allowlistPath)
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('denied')
    writeFileSync(allowlistPath, 'corrupted')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('denied')
  })

  it('leaves posture to non-tombstone entries only', () => {
    writeAllowlist({ 'gavin.belson@hooli.example': 'removed' })
    expect(resolveAccess('monica.hall@piedpiper.example', cfg({ openRegistration: true }))).toBe('allowed')
    writeAllowlist({ 'gavin.belson@hooli.example': 'removed', 'monica.hall@piedpiper.example': 'active' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg({ openRegistration: true }))).toBe('denied')
  })

  it('denies empty emails outright', () => {
    expect(resolveAccess('   ', cfg({ openRegistration: true }))).toBe('denied')
  })
})

describe('entry matching', () => {
  it('entries are authoritative over the open-registration default', () => {
    writeAllowlist({ 'monica.hall@piedpiper.example': 'active' })
    expect(resolveAccess('monica.hall@piedpiper.example', cfg({ openRegistration: true }))).toBe('allowed')
    expect(resolveAccess('gavin.belson@hooli.example', cfg({ openRegistration: true }))).toBe('denied')
  })

  it('matches exact emails case-insensitively', () => {
    writeAllowlist({ 'monica.hall@piedpiper.example': 'active' })
    expect(resolveAccess('Monica.Hall@PiedPiper.example', cfg())).toBe('allowed')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('denied')
  })

  it('matches @domain suffix entries without matching subdomains', () => {
    writeAllowlist({ '@piedpiper.example': 'active' })
    expect(resolveAccess('anyone@piedpiper.example', cfg())).toBe('allowed')
    expect(resolveAccess('anyone@sub.piedpiper.example', cfg())).toBe('denied')
    expect(resolveAccess('anyone@hooli.example', cfg())).toBe('denied')
  })

  it('skips entries with unknown statuses so they fail closed', () => {
    writeFileSync(allowlistPath, JSON.stringify({ emails: { 'monica.hall@piedpiper.example': 'actve' } }))
    expect(resolveAccess('monica.hall@piedpiper.example', cfg({ openRegistration: true }))).toBe('allowed')
    writeFileSync(
      allowlistPath,
      JSON.stringify({ emails: { 'monica.hall@piedpiper.example': 'actve', 'richard.hendricks@piedpiper.example': 'active' } }),
    )
    expect(resolveAccess('monica.hall@piedpiper.example', cfg())).toBe('denied')
  })
})

describe('lock and removal semantics', () => {
  it('reports locked and removed matches distinctly for enforcement', () => {
    writeAllowlist({
      'richard.hendricks@piedpiper.example': 'locked',
      'gavin.belson@hooli.example': 'removed',
    })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('locked')
    expect(resolveAccess('gavin.belson@hooli.example', cfg())).toBe('removed')
  })

  it('lets an exact entry override a domain entry in either direction', () => {
    writeAllowlist({ '@piedpiper.example': 'locked', 'monica.hall@piedpiper.example': 'active' })
    expect(resolveAccess('monica.hall@piedpiper.example', cfg())).toBe('allowed')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('locked')
    writeAllowlist({ '@piedpiper.example': 'active', 'monica.hall@piedpiper.example': 'removed' })
    expect(resolveAccess('monica.hall@piedpiper.example', cfg())).toBe('removed')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('allowed')
  })

  it('takes effect on the next read without a restart', () => {
    writeAllowlist({ 'richard.hendricks@piedpiper.example': 'active' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('allowed')
    writeAllowlist({ 'richard.hendricks@piedpiper.example': 'locked' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('locked')
    writeAllowlist({ 'richard.hendricks@piedpiper.example': 'removed' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('removed')
  })
})

describe('enforceDenial', () => {
  function enforcementCtx() {
    return {
      internalAdapter: {
        deleteUser: vi.fn(async () => undefined),
        deleteUserSessions: vi.fn(async () => undefined),
      },
      adapter: {
        deleteMany: vi.fn(async () => undefined),
      },
    }
  }

  const user = { id: 'u1', email: 'richard.hendricks@piedpiper.example' }

  it('revokes sessions but keeps the account for locked and denied', async () => {
    for (const access of ['locked', 'denied'] as const) {
      const ctx = enforcementCtx()
      await enforceDenial(ctx, access, user)
      expect(ctx.internalAdapter.deleteUserSessions).toHaveBeenCalledWith('u1')
      expect(ctx.internalAdapter.deleteUser).not.toHaveBeenCalled()
      expect(ctx.adapter.deleteMany).not.toHaveBeenCalled()
    }
  })

  it('erases the account records and pending verifications for removed', async () => {
    const ctx = enforcementCtx()
    await enforceDenial(ctx, 'removed', user)
    expect(ctx.internalAdapter.deleteUser).toHaveBeenCalledWith('u1')
    expect(ctx.adapter.deleteMany).toHaveBeenCalledWith({
      model: 'verification',
      where: [{ field: 'identifier', value: user.email }],
    })
    expect(ctx.internalAdapter.deleteUserSessions).not.toHaveBeenCalled()
  })
})
