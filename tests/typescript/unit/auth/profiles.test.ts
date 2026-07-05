// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for profile id parsing and display-name resolution behind the console profiles surface.

import { describe, expect, it, vi } from 'vitest'

import { parseProfileIds, resolveProfiles, type ProfileAdapter } from '../../../../apps/auth/src/profiles.ts'

describe('parseProfileIds', () => {
  it('parses, trims, and deduplicates well-formed ids', () => {
    expect(parseProfileIds('/api/console/profiles?ids=a1, b2 ,a1,c-3_x')).toEqual(['a1', 'b2', 'c-3_x'])
  })

  it('drops malformed ids and empty input', () => {
    expect(parseProfileIds('/api/console/profiles')).toEqual([])
    expect(parseProfileIds('/api/console/profiles?ids=')).toEqual([])
    expect(parseProfileIds('/api/console/profiles?ids=ok,admin:tok,%00,sp ace,' + 'y'.repeat(129))).toEqual(['ok'])
  })

  it('caps the batch size', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id${i}`).join(',')
    expect(parseProfileIds(`/api/console/profiles?ids=${ids}`)).toHaveLength(100)
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
