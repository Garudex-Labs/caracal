// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reserved Caracal-internal namespace tests cover the per-object encodings and the global-only gate.

import { describe, expect, it } from 'vitest'
import type { Actor } from '../../../../apps/api/src/auth.js'
import { assertReservedNamespace } from '../../../../apps/api/src/reserved-namespace.js'

const globalActor: Actor = { id: 'admin-1', name: 'Platform Admin', scope: 'global', zoneId: null }
const zoneActor: Actor = { id: 'admin-2', name: 'Tenant Admin', scope: 'zone', zoneId: 'zone-1' }

describe('assertReservedNamespace', () => {
  it('allows an absent value', () => {
    expect(assertReservedNamespace('zoneSlug', undefined, zoneActor)).toBeNull()
  })

  it('allows a global actor to use the reserved namespace in every encoding', () => {
    expect(assertReservedNamespace('zoneSlug', 'caracal-sys-internal', globalActor)).toBeNull()
    expect(assertReservedNamespace('zoneName', 'caracal.sys/internal', globalActor)).toBeNull()
    expect(assertReservedNamespace('applicationName', 'caracal.sys/operator', globalActor)).toBeNull()
    expect(assertReservedNamespace('resourceIdentifier', 'caracal-sys://operator-llm', globalActor)).toBeNull()
    expect(assertReservedNamespace('providerIdentifier', 'provider://caracal-sys-llm', globalActor)).toBeNull()
    expect(assertReservedNamespace('policyName', 'caracal.sys/lock', globalActor)).toBeNull()
  })

  it('refuses a zone-scoped tenant from using the reserved namespace in every encoding', () => {
    expect(assertReservedNamespace('zoneSlug', 'caracal-sys-internal', zoneActor)).toMatchObject({ error: 'reserved_namespace' })
    expect(assertReservedNamespace('zoneName', 'caracal.sys/internal', zoneActor)).toMatchObject({ error: 'reserved_namespace' })
    expect(assertReservedNamespace('applicationName', 'caracal.sys/operator', zoneActor)).toMatchObject({ error: 'reserved_namespace' })
    expect(assertReservedNamespace('resourceIdentifier', 'caracal-sys://operator-llm', zoneActor)).toMatchObject({
      error: 'reserved_namespace',
    })
    expect(assertReservedNamespace('providerIdentifier', 'provider://caracal-sys-llm', zoneActor)).toMatchObject({
      error: 'reserved_namespace',
    })
    expect(assertReservedNamespace('policyName', 'caracal.sys/lock', zoneActor)).toMatchObject({ error: 'reserved_namespace' })
  })

  it('is case-insensitive so a tenant cannot evade by changing case', () => {
    expect(assertReservedNamespace('applicationName', 'Caracal.Sys/Operator', zoneActor)).toMatchObject({ error: 'reserved_namespace' })
    expect(assertReservedNamespace('zoneName', '  CARACAL.SYS/x ', zoneActor)).toMatchObject({ error: 'reserved_namespace' })
  })

  it('does not reveal which internal objects exist in the refusal detail', () => {
    const result = assertReservedNamespace('applicationName', 'caracal.sys/operator', zoneActor)
    expect(result?.detail).not.toContain('operator')
    expect(result?.detail).toContain('reserved')
  })

  it('does not match unrelated or look-alike values for a tenant', () => {
    expect(assertReservedNamespace('zoneSlug', 'caracal-control', zoneActor)).toBeNull()
    expect(assertReservedNamespace('zoneSlug', 'my-caracal-sys-zone', zoneActor)).toBeNull()
    expect(assertReservedNamespace('resourceIdentifier', 'resource://api/files', zoneActor)).toBeNull()
    expect(assertReservedNamespace('providerIdentifier', 'provider://stripe', zoneActor)).toBeNull()
    expect(assertReservedNamespace('applicationName', 'caracal-operator', zoneActor)).toBeNull()
  })
})
