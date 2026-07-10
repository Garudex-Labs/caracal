// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the creator and Caracal Operator co-authorship attribution helpers.

import { describe, it, expect } from 'vitest'
import type { FastifyRequest } from 'fastify'
import {
  AUTHORIZED_BY_HEADER,
  CREATED_VIA_HEADER,
  resolveCreatedBy,
  isOperatorOrigin,
  zoneCoauthorEnabled,
  resolveAttribution,
} from '../../../../apps/api/src/attribution.js'
import type { Queryable } from '../../../../apps/api/src/db.js'

function makeReq(opts: { headers?: Record<string, string>; account?: { id: string }; actorId?: string }): FastifyRequest {
  return {
    headers: opts.headers ?? {},
    account: opts.account,
    actor: { id: opts.actorId ?? 'tok-1', name: 'bootstrap' },
  } as unknown as FastifyRequest
}

describe('resolveCreatedBy', () => {
  it('prefers the operator hop authorized-by identity', () => {
    const req = makeReq({
      headers: { [AUTHORIZED_BY_HEADER]: 'acct-richard-01' },
      account: { id: 'acct-console-01' },
    })
    expect(resolveCreatedBy(req)).toBe('acct-richard-01')
  })

  it('accepts prefixed credential identities on the hop header', () => {
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: 'admin:tok-9' } }))).toBe('admin:tok-9')
  })

  it('falls back to the verified identity when the header is not a plausible identity', () => {
    const account = { id: 'acct-monica-01' }
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: '<script>alert(1)</script>' }, account }))).toBe('acct-monica-01')
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: 'line\nbreak' }, account }))).toBe('acct-monica-01')
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: 'x'.repeat(257) }, account }))).toBe('acct-monica-01')
  })

  it('records the verified account profile id, never a display name', () => {
    expect(resolveCreatedBy(makeReq({ account: { id: 'acct-monica-01' } }))).toBe('acct-monica-01')
  })

  it('records the admin credential id for a direct admin call', () => {
    expect(resolveCreatedBy(makeReq({ actorId: 'tok-ci' }))).toBe('admin:tok-ci')
  })
})

describe('isOperatorOrigin', () => {
  it('is true only for the operator origin marker', () => {
    expect(isOperatorOrigin(makeReq({ headers: { [CREATED_VIA_HEADER]: 'operator' } }))).toBe(true)
    expect(isOperatorOrigin(makeReq({ headers: { [CREATED_VIA_HEADER]: 'automation' } }))).toBe(false)
    expect(isOperatorOrigin(makeReq({}))).toBe(false)
  })
})

describe('zoneCoauthorEnabled', () => {
  function db(rows: { operator_coauthor_badge: boolean }[]): Queryable {
    return { query: async () => ({ rows }) } as unknown as Queryable
  }

  it('returns the stored setting', async () => {
    expect(await zoneCoauthorEnabled(db([{ operator_coauthor_badge: false }]), 'z1')).toBe(false)
    expect(await zoneCoauthorEnabled(db([{ operator_coauthor_badge: true }]), 'z1')).toBe(true)
  })

  it('defaults on when the zone row is missing', async () => {
    expect(await zoneCoauthorEnabled(db([]), 'z1')).toBe(true)
  })
})

describe('resolveAttribution', () => {
  function db(rows: { operator_coauthor_badge: boolean }[], calls?: { count: number }): Queryable {
    return {
      query: async () => {
        if (calls) calls.count += 1
        return { rows }
      },
    } as unknown as Queryable
  }

  it('stamps the actor without touching the zone setting for a non-operator mutation', async () => {
    const calls = { count: 0 }
    const attribution = await resolveAttribution(makeReq({ account: { id: 'op-1' } }), db([], calls), 'z1')
    expect(attribution).toEqual({ actor: 'op-1', viaOperator: false })
    expect(calls.count).toBe(0)
  })

  it('stamps operator involvement when the zone attribution setting is on', async () => {
    const req = makeReq({
      headers: { [CREATED_VIA_HEADER]: 'operator', [AUTHORIZED_BY_HEADER]: 'acct-richard-01' },
    })
    const attribution = await resolveAttribution(req, db([{ operator_coauthor_badge: true }]), 'z1')
    expect(attribution).toEqual({ actor: 'acct-richard-01', viaOperator: true })
  })

  it('suppresses the operator stamp when the zone attribution setting is off', async () => {
    const req = makeReq({
      headers: { [CREATED_VIA_HEADER]: 'operator', [AUTHORIZED_BY_HEADER]: 'acct-richard-01' },
    })
    const attribution = await resolveAttribution(req, db([{ operator_coauthor_badge: false }]), 'z1')
    expect(attribution).toEqual({ actor: 'acct-richard-01', viaOperator: false })
  })

  it('stamps operator involvement without a zone lookup for global objects', async () => {
    const calls = { count: 0 }
    const req = makeReq({ headers: { [CREATED_VIA_HEADER]: 'operator' }, actorId: 'tok-1' })
    const attribution = await resolveAttribution(req, db([], calls), null)
    expect(attribution).toEqual({ actor: 'admin:tok-1', viaOperator: true })
    expect(calls.count).toBe(0)
  })
})
