// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the attribution profile-name resolver: request batching and verbatim fallback.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/web/src/platform/api/client.ts', () => ({
  consoleApi: {
    profiles: {
      resolve: vi.fn(),
    },
  },
}))

import { consoleApi } from '../../../../apps/web/src/platform/api/client.ts'
import { resolveProfileName } from '../../../../apps/web/src/platform/api/profiles.ts'

const resolve = vi.mocked(consoleApi.profiles.resolve)

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveProfileName', () => {
  it('coalesces concurrent lookups into one batched request', async () => {
    resolve.mockResolvedValueOnce({
      profiles: [
        { id: 'u1', name: 'Richard Hendricks' },
        { id: 'u2', name: 'Monica Hall' },
      ],
    })
    const [a, b, again] = await Promise.all([resolveProfileName('u1'), resolveProfileName('u2'), resolveProfileName('u1')])
    expect(a).toBe('Richard Hendricks')
    expect(b).toBe('Monica Hall')
    expect(again).toBe('Richard Hendricks')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith(['u1', 'u2'])
  })

  it('resolves unknown identities and empty names to null for verbatim rendering', async () => {
    resolve.mockResolvedValueOnce({ profiles: [{ id: 'u9', name: '' }] })
    const [unknown, unnamed] = await Promise.all([resolveProfileName('admin:tok-1'), resolveProfileName('u9')])
    expect(unknown).toBeNull()
    expect(unnamed).toBeNull()
  })

  it('degrades a failed lookup to null instead of failing the render', async () => {
    resolve.mockRejectedValueOnce(new Error('offline'))
    expect(await resolveProfileName('u1')).toBeNull()
  })
})
