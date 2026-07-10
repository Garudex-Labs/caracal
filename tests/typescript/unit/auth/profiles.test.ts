// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for profile id parsing and display-name resolution behind the console profiles surface.

import { describe, expect, it, vi } from 'vitest'

import { adminTokenProfiles, parseProfileIds, resolveProfiles, type ProfileAdapter } from '../../../../apps/auth/src/profiles.ts'

const ADMIN_ID = 'admin:019f3be3-a15e-75ef-bb36-6d02e8d206ba'

describe('parseProfileIds', () => {
  it('parses, trims, and deduplicates well-formed ids', () => {
    expect(parseProfileIds('/api/console/profiles?ids=a1, b2 ,a1,c-3_x')).toEqual({
      profiles: ['a1', 'b2', 'c-3_x'],
      admins: [],
    })
  })

  it('separates admin credential identities from profile ids', () => {
    expect(parseProfileIds(`/api/console/profiles?ids=a1,${ADMIN_ID},${ADMIN_ID}`)).toEqual({
      profiles: ['a1'],
      admins: [ADMIN_ID],
    })
  })

  it('drops malformed ids and empty input', () => {
    expect(parseProfileIds('/api/console/profiles')).toEqual({ profiles: [], admins: [] })
    expect(parseProfileIds('/api/console/profiles?ids=')).toEqual({ profiles: [], admins: [] })
    expect(parseProfileIds('/api/console/profiles?ids=ok,admin:tok,%00,sp ace,' + 'y'.repeat(129))).toEqual({
      profiles: ['ok'],
      admins: [],
    })
  })

  it('caps the batch size', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id${i}`).join(',')
    expect(parseProfileIds(`/api/console/profiles?ids=${ids}`).profiles).toHaveLength(100)
  })
})

describe('resolveProfiles', () => {
  it('returns only id and name for known profiles', async () => {
    const findMany = vi.fn(async () => [
      { id: 'u1', name: 'Richard Hendricks', email: 'richard.hendricks@piedpiper.example' },
      { id: 'u2', name: 42 },
      { name: 'no id' },
    ])
    const adapter: ProfileAdapter = { findMany }
    expect(await resolveProfiles(adapter, ['u1', 'u2', 'u3'])).toEqual([
      { id: 'u1', name: 'Richard Hendricks' },
      { id: 'u2', name: '' },
    ])
    expect(findMany).toHaveBeenCalledWith({
      model: 'user',
      where: [{ field: 'id', operator: 'in', value: ['u1', 'u2', 'u3'] }],
      limit: 3,
    })
  })

  it('answers an empty request without touching the store', async () => {
    const findMany = vi.fn(async () => [])
    expect(await resolveProfiles({ findMany }, [])).toEqual([])
    expect(findMany).not.toHaveBeenCalled()
  })
})

describe('adminTokenProfiles', () => {
  it('shapes requested admin identities to token names, exposing nothing else', () => {
    const tokens = [
      { id: '019f3be3-a15e-75ef-bb36-6d02e8d206ba', name: 'dev root', scope: 'global', created_by: 'env-bootstrap' },
      { id: '019f3be3-ffff-75ef-bb36-6d02e8d206ba', name: 'unrequested' },
      { id: 42, name: 'bad id' },
      { id: '019f3be3-aaaa-75ef-bb36-6d02e8d206ba', name: '' },
    ]
    expect(adminTokenProfiles(tokens, [ADMIN_ID])).toEqual([{ id: ADMIN_ID, name: 'dev root' }])
  })

  it('matches identities case-insensitively', () => {
    const tokens = [{ id: '019F3BE3-A15E-75EF-BB36-6D02E8D206BA', name: 'ci' }]
    expect(adminTokenProfiles(tokens, [ADMIN_ID])).toEqual([{ id: 'admin:019F3BE3-A15E-75EF-BB36-6D02E8D206BA', name: 'ci' }])
  })
})
