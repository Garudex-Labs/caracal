// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator token guard tests cover presence and missing-token errors.

import { describe, expect, it, vi } from 'vitest'

const discoverCoordinatorToken = vi.hoisted(() => vi.fn())

vi.mock('@caracalai/server-core', () => ({ discoverCoordinatorToken }))

describe('ensureCoordinatorToken', () => {
  it('throws when no coordinator token is discoverable', async () => {
    discoverCoordinatorToken.mockReturnValueOnce('')
    const { ensureCoordinatorToken } = await import('../../../../packages/engine/src/coordinator.js')
    expect(() => ensureCoordinatorToken()).toThrow('Coordinator token not found')
  })

  it('passes when a coordinator token is discoverable', async () => {
    discoverCoordinatorToken.mockReturnValueOnce('token')
    const { ensureCoordinatorToken } = await import('../../../../packages/engine/src/coordinator.js')
    expect(() => ensureCoordinatorToken()).not.toThrow()
  })
})
