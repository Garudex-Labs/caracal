// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Console access decision: allowlist file contract, lock semantics, and posture fallback.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveAccess } from '../../../../apps/auth/src/allowlist.ts'

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

describe('lock semantics', () => {
  it('reports a locked exact entry', () => {
    writeAllowlist({ 'richard.hendricks@piedpiper.example': 'locked' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('locked')
  })

  it('lets an exact entry override a locked domain entry and vice versa', () => {
    writeAllowlist({ '@piedpiper.example': 'locked', 'monica.hall@piedpiper.example': 'active' })
    expect(resolveAccess('monica.hall@piedpiper.example', cfg())).toBe('allowed')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('locked')
    writeAllowlist({ '@piedpiper.example': 'active', 'monica.hall@piedpiper.example': 'locked' })
    expect(resolveAccess('monica.hall@piedpiper.example', cfg())).toBe('locked')
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('allowed')
  })

  it('takes effect on the next read without a restart', () => {
    writeAllowlist({ 'richard.hendricks@piedpiper.example': 'active' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('allowed')
    writeAllowlist({ 'richard.hendricks@piedpiper.example': 'locked' })
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('locked')
    writeAllowlist({})
    expect(resolveAccess('richard.hendricks@piedpiper.example', cfg())).toBe('denied')
  })
})
