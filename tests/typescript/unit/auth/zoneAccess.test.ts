// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Console BFF per-account zone access guard on the coordinator proxy.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearZoneAccessCache, coordZoneId, resolveZoneAccess } from '../../../../apps/auth/src/zoneAccess.ts'

const ZONE = '0198a0aa-1111-7000-8000-000000000001'

beforeEach(() => {
  clearZoneAccessCache()
})

describe('coordZoneId', () => {
  it('extracts the zone id from a coordinator path', () => {
    expect(coordZoneId(`/zones/${ZONE}/agents`)).toBe(ZONE)
  })

  it('extracts the zone id when followed by a query string', () => {
    expect(coordZoneId(`/zones/${ZONE}?limit=10`)).toBe(ZONE)
  })

  it('decodes a percent-encoded zone id', () => {
    expect(coordZoneId('/zones/zone%2Did/agents')).toBe('zone-id')
  })

  it('refuses a path without a zone id', () => {
    expect(coordZoneId('/agents')).toBeNull()
    expect(coordZoneId('/zones/')).toBeNull()
  })

  it('refuses malformed percent encoding', () => {
    expect(coordZoneId('/zones/%zz/agents')).toBeNull()
  })
})

describe('resolveZoneAccess', () => {
  it('allows any method on an owned zone', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 200, name: 'Pied Piper Production', slug: 'pied-piper-production' })
    expect(await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).toEqual({ allowed: true, status: 200 })
    expect(await resolveZoneAccess('acct-1', ZONE, 'DELETE', probe)).toEqual({ allowed: true, status: 200 })
  })

  it("denies another account's zone as forbidden", async () => {
    const probe = vi.fn().mockResolvedValue({ status: 403 })
    expect(await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).toEqual({
      allowed: false,
      status: 403,
      error: 'zone_forbidden',
    })
  })

  it('denies a missing zone as not found', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 404 })
    expect(await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).toEqual({
      allowed: false,
      status: 404,
      error: 'zone_not_found',
    })
  })

  it('allows reads of the system zone but refuses mutations', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 200, name: 'caracal.sys/system', slug: 'caracal-sys-internal' })
    expect(await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).toEqual({ allowed: true, status: 200 })
    expect(await resolveZoneAccess('acct-1', ZONE, 'HEAD', probe)).toEqual({ allowed: true, status: 200 })
    expect(await resolveZoneAccess('acct-1', ZONE, 'PATCH', probe)).toEqual({
      allowed: false,
      status: 403,
      error: 'system_zone_read_only',
    })
  })

  it('recognises the system zone by slug alone', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 200, name: 'renamed', slug: 'caracal-sys-internal' })
    expect(await resolveZoneAccess('acct-1', ZONE, 'POST', probe)).toEqual({
      allowed: false,
      status: 403,
      error: 'system_zone_read_only',
    })
  })

  it('fails closed when the control plane is unconfigured', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 503 })
    expect(await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).toEqual({
      allowed: false,
      status: 503,
      error: 'control_plane_not_configured',
    })
  })

  it('fails closed on an unexpected probe status', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 500 })
    expect(await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).toEqual({
      allowed: false,
      status: 502,
      error: 'upstream_unreachable',
    })
  })

  it('caches a definitive decision per account and zone', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 200, name: 'Hooli Staging', slug: 'hooli-staging' })
    await resolveZoneAccess('acct-1', ZONE, 'GET', probe)
    await resolveZoneAccess('acct-1', ZONE, 'POST', probe)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not share cached decisions across accounts', async () => {
    const allowed = vi.fn().mockResolvedValue({ status: 200, name: 'Hooli Staging', slug: 'hooli-staging' })
    const denied = vi.fn().mockResolvedValue({ status: 403 })
    expect((await resolveZoneAccess('acct-1', ZONE, 'GET', allowed)).allowed).toBe(true)
    expect((await resolveZoneAccess('acct-2', ZONE, 'GET', denied)).allowed).toBe(false)
    expect(allowed).toHaveBeenCalledTimes(1)
    expect(denied).toHaveBeenCalledTimes(1)
  })

  it('does not cache a transient probe failure', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ status: 502 })
      .mockResolvedValueOnce({ status: 200, name: 'Hooli Staging', slug: 'hooli-staging' })
    expect((await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).allowed).toBe(false)
    expect((await resolveZoneAccess('acct-1', ZONE, 'GET', probe)).allowed).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
