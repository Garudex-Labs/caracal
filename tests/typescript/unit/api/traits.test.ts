// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Application trait validation tests cover safe naming, duplicates, and privileged namespaces.

import { describe, expect, it } from 'vitest'
import type { Actor } from '../../../../apps/api/src/auth.js'
import { validateTraits } from '../../../../apps/api/src/traits.js'

const globalActor: Actor = { id: 'admin-1', name: 'Pied Piper Admin', scope: 'global', zoneId: null }
const zoneActor: Actor = { id: 'admin-2', name: 'Hooli Zone Admin', scope: 'zone', zoneId: 'zone-1' }

describe('validateTraits', () => {
  it('accepts absent traits, valid scoped names, and privileged traits for global actors', () => {
    expect(validateTraits(undefined, zoneActor)).toBeNull()
    expect(validateTraits(['team:engineering', 'piper.net', 'A-1'], zoneActor)).toBeNull()
    expect(validateTraits(['control:operator'], globalActor)).toBeNull()
    expect(validateTraits(['caracal.sys:operator'], globalActor)).toBeNull()
  })

  it('rejects too many, empty, oversized, malformed, duplicate, and privileged zone traits', () => {
    expect(
      validateTraits(
        Array.from({ length: 33 }, (_, i) => `trait${i}`),
        globalActor,
      ),
    ).toMatchObject({
      error: 'trait_count_exceeded',
    })
    expect(validateTraits([''], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['a'.repeat(129)], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['1bad'], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['team:eng', 'team:eng'], globalActor)).toMatchObject({ error: 'trait_duplicate' })
    expect(validateTraits(['control:operator'], zoneActor)).toMatchObject({ error: 'trait_forbidden' })
    // The reserved internal namespace is privileged exactly like control:, so a tenant cannot claim it.
    expect(validateTraits(['caracal.sys:operator'], zoneActor)).toMatchObject({ error: 'trait_forbidden' })
  })
})
