// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Subject issuer route unit tests for trust URL validation and lifecycle.

import { describe, it, expect } from 'vitest'

const { subjectIssuersRoutes, validateIssuerUrl } = await import('../../../../../apps/api/src/routes/subject-issuers.js')
const { buildRouteApp } = await import('../../../../shared/test-utils/typescript/fastify.js')

const ISSUER_ROW = {
  id: 'si-1',
  zone_id: 'z1',
  issuer: 'https://login.hooli.example',
  jwks_url: 'https://login.hooli.example/.well-known/jwks.json',
  audience: 'pipernet-api',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  created_by: 'richard.hendricks@piedpiper.example',
  created_via_operator: false,
  updated_by: null,
  updated_via_operator: false,
}

describe('validateIssuerUrl', () => {
  it('accepts clean https URLs and rejects impersonation vectors', () => {
    expect(validateIssuerUrl('https://login.hooli.example', 'issuer')).toBeNull()
    expect(validateIssuerUrl('http://login.hooli.example', 'issuer')).toContain('https')
    expect(validateIssuerUrl('https://user:pass@login.hooli.example', 'issuer')).toContain('credentials')
    expect(validateIssuerUrl('https://login.hooli.example/jwks?x=1', 'jwks_url')).toContain('query')
    expect(validateIssuerUrl('not a url', 'issuer')).toContain('not a valid')
  })
})

describe('POST /v1/zones/:zoneId/subject-issuers', () => {
  it('creates an issuer trust declaration', async () => {
    const { app, db } = buildRouteApp(subjectIssuersRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [ISSUER_ROW] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/subject-issuers',
      payload: {
        issuer: 'https://login.hooli.example',
        jwks_url: 'https://login.hooli.example/.well-known/jwks.json',
        audience: 'pipernet-api',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).issuer).toBe('https://login.hooli.example')
    const insert = db.query.mock.calls[2]
    expect(String(insert[0])).toContain('INSERT INTO subject_issuers')
  })

  it('rejects non-https issuer and jwks URLs', async () => {
    const { app, db } = buildRouteApp(subjectIssuersRoutes)
    db.query.mockResolvedValue({ rows: [{ 1: 1 }] })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/subject-issuers',
      payload: { issuer: 'http://login.hooli.example', jwks_url: 'https://login.hooli.example/jwks', audience: 'pipernet-api' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('invalid_subject_issuer')
  })

  it('maps the unique-issuer violation to a conflict', async () => {
    const { app, db } = buildRouteApp(subjectIssuersRoutes)
    const dup = Object.assign(new Error('duplicate'), { code: '23505' })
    db.query
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockRejectedValueOnce(dup)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/subject-issuers',
      payload: { issuer: 'https://login.hooli.example', jwks_url: 'https://login.hooli.example/jwks', audience: 'pipernet-api' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('subject_issuer_exists')
  })
})

describe('subject issuer lifecycle', () => {
  it('lists only active issuers with keyset pagination', async () => {
    const { app, db } = buildRouteApp(subjectIssuersRoutes)
    db.query.mockResolvedValueOnce({ rows: [ISSUER_ROW] })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/subject-issuers' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).items).toHaveLength(1)
    expect(String(db.query.mock.calls[0][0])).toContain('archived_at IS NULL')
  })

  it('patches jwks_url and audience only', async () => {
    const { app, db } = buildRouteApp(subjectIssuersRoutes)
    db.query.mockResolvedValueOnce({ rows: [ISSUER_ROW] })
    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/subject-issuers/si-1',
      payload: { audience: 'pipernet-api-v2' },
    })
    expect(res.statusCode).toBe(200)
    const update = db.query.mock.calls[0]
    expect(String(update[0])).toContain('UPDATE subject_issuers')
    expect(String(update[0])).not.toContain('issuer =')
  })

  it('archives on delete and 404s an already archived issuer', async () => {
    const { app, db } = buildRouteApp(subjectIssuersRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'si-1' }] }).mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const del = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/subject-issuers/si-1' })
    expect(del.statusCode).toBe(204)
    expect(String(db.query.mock.calls[0][0])).toContain('archived_at = now()')
    const again = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/subject-issuers/si-1' })
    expect(again.statusCode).toBe(404)
  })
})
