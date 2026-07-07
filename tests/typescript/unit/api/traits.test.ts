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
    expect(validateTraits(['control:invoke'], globalActor)).toBeNull()
    expect(
      validateTraits(
        ['control:invoke', 'control:scope:control:app:read', 'control:max-ttl:300', 'control:expires:2036-01-01T00:00:00.000Z'],
        globalActor,
      ),
    ).toBeNull()
    expect(validateTraits(['caracal.sys:operator'], globalActor)).toBeNull()
  })

  it('rejects control traits whose semantics STS and dispatch would not enforce', () => {
    expect(validateTraits(['control:operator'], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['control:scope:control:nucleus:launch'], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['control:max-ttl:30'], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['control:max-ttl:99999'], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['control:expires:whenever'], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['control:invoke', 'control:max-ttl:300', 'control:max-ttl:600'], globalActor)).toMatchObject({
      error: 'trait_invalid',
    })
    expect(
      validateTraits(
        ['control:invoke', 'control:expires:2036-01-01T00:00:00.000Z', 'control:expires:2037-01-01T00:00:00.000Z'],
        globalActor,
      ),
    ).toMatchObject({ error: 'trait_invalid' })
  })

  it('rejects too many, empty, oversized, malformed, duplicate, and privileged zone traits', () => {
    expect(
      validateTraits(
        Array.from({ length: 65 }, (_, i) => `trait${i}`),
        globalActor,
      ),
    ).toMatchObject({
      error: 'trait_count_exceeded',
    })
    expect(
      validateTraits(
        Array.from({ length: 64 }, (_, i) => `trait${i}`),
        globalActor,
      ),
    ).toBeNull()
    expect(validateTraits([''], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['a'.repeat(129)], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['1bad'], globalActor)).toMatchObject({ error: 'trait_invalid' })
    expect(validateTraits(['team:eng', 'team:eng'], globalActor)).toMatchObject({ error: 'trait_duplicate' })
    expect(validateTraits(['control:invoke'], zoneActor)).toMatchObject({ error: 'trait_forbidden' })
    // The reserved internal namespace is privileged exactly like control:, so a tenant cannot claim it.
    expect(validateTraits(['caracal.sys:operator'], zoneActor)).toMatchObject({ error: 'trait_forbidden' })
  })
})
