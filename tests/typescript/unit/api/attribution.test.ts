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
} from '../../../../apps/api/src/attribution.js'
import type { Queryable } from '../../../../apps/api/src/db.js'

function makeReq(opts: {
  headers?: Record<string, string>
  account?: { id: string; name?: string; email?: string }
  actorName?: string
}): FastifyRequest {
  return {
    headers: opts.headers ?? {},
    account: opts.account,
    actor: { name: opts.actorName ?? 'bootstrap' },
  } as unknown as FastifyRequest
}

describe('resolveCreatedBy', () => {
  it('prefers the operator hop authorized-by header', () => {
    const req = makeReq({
      headers: { [AUTHORIZED_BY_HEADER]: 'Richard Hendricks' },
      account: { id: 'op-1', name: 'Console Operator' },
      actorName: 'bootstrap',
    })
    expect(resolveCreatedBy(req)).toBe('Richard Hendricks')
  })

  it('accepts email-shaped and accented attribution labels', () => {
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: 'richard.hendricks+ops@piedpiper.example' } }))).toBe(
      'richard.hendricks+ops@piedpiper.example',
    )
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: "Núria O'Brien" } }))).toBe("Núria O'Brien")
  })

  it('falls back to the verified identity when the header is not a name or email', () => {
    const account = { id: 'op-1', name: 'Monica Hall' }
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: '<script>alert(1)</script>' }, account }))).toBe('Monica Hall')
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: 'line\nbreak' }, account }))).toBe('Monica Hall')
    expect(resolveCreatedBy(makeReq({ headers: { [AUTHORIZED_BY_HEADER]: 'x'.repeat(257) }, account }))).toBe('Monica Hall')
  })

  it('falls back to the verified account name, then email', () => {
    expect(resolveCreatedBy(makeReq({ account: { id: 'op-1', name: 'Monica Hall' } }))).toBe('Monica Hall')
    expect(resolveCreatedBy(makeReq({ account: { id: 'op-1', email: 'monica.hall@raviga.example' } }))).toBe('monica.hall@raviga.example')
  })

  it('falls back to the admin actor name for a direct admin call', () => {
    expect(resolveCreatedBy(makeReq({ actorName: 'bootstrap' }))).toBe('bootstrap')
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
