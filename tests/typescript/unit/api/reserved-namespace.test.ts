// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reserved Caracal-internal namespace tests cover the per-object encodings and the provisioner-only gate.

import { describe, expect, it } from 'vitest'
import type { Actor } from '../../../../apps/api/src/auth.js'
import {
  assertReservedNamespace,
  isInternalProvisioner,
  isReservedZone,
  mintZoneId,
  OSS_ORG_ID,
  CARACAL_ORG_ID,
  resolveOssOrg,
  RESERVED_ZONE_IDS,
  RESERVED_ZONE_SQL,
} from '../../../../apps/api/src/reserved-namespace.js'

const provisioner: Actor = {
  id: 'bootstrap',
  name: 'bootstrap',
  scope: 'global',
  capability: 'write',
  zoneId: null,
  createdBy: 'env-bootstrap',
}
const consoleWrite: Actor = {
  id: 'console-write',
  name: 'console-write',
  scope: 'global',
  capability: 'write',
  zoneId: null,
  createdBy: 'env-derived-write',
}
const operatorMinted: Actor = {
  id: 'admin-1',
  name: 'Platform Admin',
  scope: 'global',
  capability: 'write',
  zoneId: null,
  createdBy: 'admin:some-operator',
}
const zoneActor: Actor = {
  id: 'admin-2',
  name: 'Tenant Admin',
  scope: 'zone',
  capability: 'write',
  zoneId: 'zone-1',
  createdBy: 'admin:some-operator',
}

describe('assertReservedNamespace', () => {
  it('allows an absent value', () => {
    expect(assertReservedNamespace('zoneSlug', undefined, zoneActor)).toBeNull()
  })

  it('allows the internal provisioner to use the reserved namespace in every encoding', () => {
    expect(assertReservedNamespace('zoneSlug', 'caracal-sys-internal', provisioner)).toBeNull()
    expect(assertReservedNamespace('zoneName', 'caracal.sys/internal', provisioner)).toBeNull()
    expect(assertReservedNamespace('applicationName', 'caracal.sys/operator', provisioner)).toBeNull()
    expect(assertReservedNamespace('resourceIdentifier', 'caracal-sys://operator-llm', provisioner)).toBeNull()
    expect(assertReservedNamespace('providerIdentifier', 'provider://caracal-sys-llm', provisioner)).toBeNull()
    expect(assertReservedNamespace('policyName', 'caracal.sys/lock', provisioner)).toBeNull()
  })

  it('refuses a non-provisioner global actor from using the reserved namespace', () => {
    expect(assertReservedNamespace('zoneSlug', 'caracal-sys-internal', consoleWrite)).toMatchObject({ error: 'reserved_namespace' })
    expect(assertReservedNamespace('zoneName', 'caracal.sys/internal', operatorMinted)).toMatchObject({ error: 'reserved_namespace' })
    expect(assertReservedNamespace('applicationName', 'caracal.sys/operator', operatorMinted)).toMatchObject({
      error: 'reserved_namespace',
    })
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

describe('isInternalProvisioner', () => {
  it('recognises only the bootstrap deployment identity', () => {
    expect(isInternalProvisioner(provisioner)).toBe(true)
    expect(isInternalProvisioner(consoleWrite)).toBe(false)
    expect(isInternalProvisioner(operatorMinted)).toBe(false)
    expect(isInternalProvisioner(zoneActor)).toBe(false)
  })
})

describe('isReservedZone', () => {
  it('matches the reserved system zone by slug or name in any case', () => {
    expect(isReservedZone({ slug: 'caracal-sys-internal', name: 'caracal.sys/system' })).toBe(true)
    expect(isReservedZone({ slug: 'CARACAL-SYS-INTERNAL' })).toBe(true)
    expect(isReservedZone({ name: ' Caracal.Sys/System ' })).toBe(true)
  })

  it('does not match tenant zones or look-alikes', () => {
    expect(isReservedZone({ slug: 'finance', name: 'Finance' })).toBe(false)
    expect(isReservedZone({ slug: 'my-caracal-sys-zone' })).toBe(false)
    expect(isReservedZone({ name: 'caracal-control' })).toBe(false)
    expect(isReservedZone({})).toBe(false)
  })
})

describe('RESERVED_ZONE_SQL', () => {
  it('is a parameterless fragment built from the reserved prefixes', () => {
    expect(RESERVED_ZONE_SQL).toContain("lower(name) LIKE 'caracal.sys/%'")
    expect(RESERVED_ZONE_SQL).toContain("lower(slug) LIKE 'caracal-sys-%'")
    expect(RESERVED_ZONE_SQL).not.toContain('$')
  })
})

describe('mintZoneId', () => {
  it('returns a generated id when it is not reserved', () => {
    expect(mintZoneId(() => 'zone-normal')).toBe('zone-normal')
  })

  it('regenerates when the first id is a reserved sentinel', () => {
    const seq = [OSS_ORG_ID, 'zone-ok']
    expect(mintZoneId(() => seq.shift()!)).toBe('zone-ok')
  })

  it('never returns a reserved id', () => {
    expect(RESERVED_ZONE_IDS.has(mintZoneId(() => (OSS_ORG_ID === 'x' ? 'x' : 'zone-1')))).toBe(false)
  })
})

describe('resolveOssOrg', () => {
  it('keeps the open-source sentinel org', () => {
    expect(resolveOssOrg(OSS_ORG_ID)).toBe(OSS_ORG_ID)
  })

  it('keeps the reserved Caracal system org', () => {
    expect(resolveOssOrg(CARACAL_ORG_ID)).toBe(CARACAL_ORG_ID)
  })

  it('collapses any other org id to the sentinel (open source has no orgs)', () => {
    expect(resolveOssOrg('acme-corp')).toBe(OSS_ORG_ID)
    expect(resolveOssOrg('11111111-1111-1111-1111-111111111111')).toBe(OSS_ORG_ID)
    expect(resolveOssOrg(undefined)).toBe(OSS_ORG_ID)
    expect(resolveOssOrg('')).toBe(OSS_ORG_ID)
  })
})
