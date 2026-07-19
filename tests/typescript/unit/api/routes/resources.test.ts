// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resource route unit tests for same-zone provider ownership.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resourcesRoutes } from '../../../../../apps/api/src/routes/resources.js'
import { runResourceVerificationCheck } from '../../../../../apps/api/src/resource-verify.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

vi.mock('../../../../../apps/api/src/resource-verify.js', () => ({
  runResourceVerificationCheck: vi.fn(),
}))

// The probe is a module-level mock, so its call history and resolved value carry across tests
// unless reset; each case seeds its own outcome and asserts its own call count.
beforeEach(() => {
  vi.mocked(runResourceVerificationCheck).mockReset()
})

describe('GET /v1/zones/:zoneId/resources', () => {
  it('hides the Control API resource from generic resource lists', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'res-demo', identifier: 'demo-api', created_at: '2026-05-25T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/resources',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      items: [{ id: 'res-demo', identifier: 'demo-api', created_at: '2026-05-25T00:00:00.000Z' }],
      next_cursor: null,
    })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('r.identifier <> $2'), ['z1', 'caracal-control', 200])
  })

  it('lets the Control path include the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes, { prefix: '/v1' }, { actor: { scope: 'global' } })
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'res-control', identifier: 'caracal-control', created_at: '2026-05-25T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/resources',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      items: [{ id: 'res-control', identifier: 'caracal-control', created_at: '2026-05-25T00:00:00.000Z' }],
      next_cursor: null,
    })
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('r.identifier <> $2'), expect.anything())
  })

  it('lists archived resources for audit when requested', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'res-retired', identifier: 'resource://not-hotdog', archived_at: '2026-07-01T00:00:00.000Z' }],
    })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/resources?status=archived',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).items).toHaveLength(1)
    expect(String(db.query.mock.calls[0][0])).toContain('r.archived_at IS NOT NULL')
  })

  it('rejects an unknown status filter', async () => {
    const { app } = buildRouteApp(resourcesRoutes)
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/resources?status=all' })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /v1/zones/:zoneId/resources/:id', () => {
  it('hides the Control API resource from generic resource details', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'res-control', identifier: 'caracal-control' }] })

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/resources/res-control',
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/resources/:id/test', () => {
  const mandateRow = { identifier: 'resource://pipernet', upstream_url: 'https://api.pipernet.example', provider_kind: 'caracal_mandate' }

  it('returns 404 when the resource does not exist', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources/res-x/test' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
  })

  it('hides the Control API resource from the probe', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ ...mandateRow, identifier: 'caracal-control' }] })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources/res-control/test' })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a resource not bound to a Caracal mandate provider', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ ...mandateRow, provider_kind: 'api_key' }] })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources/res-1/test' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_verification_unsupported' })
  })

  it('rejects a Caracal mandate resource with no upstream URL', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ ...mandateRow, upstream_url: null }] })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources/res-1/test' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_verification_unsupported' })
  })

  it('rate-limits the probe per zone', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [mandateRow] })
    redis.incr.mockResolvedValue(11)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources/res-1/test' })
    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_test_rate_limited' })
  })

  it('returns 503 when no verifier issuer is configured', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', {} as never)
    db.query.mockResolvedValueOnce({ rows: [mandateRow] })
    redis.incr.mockResolvedValue(1)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources/res-1/test' })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'service_unconfigured' })
    expect(vi.mocked(runResourceVerificationCheck)).not.toHaveBeenCalled()
  })

  it('returns the verification result for a guarded upstream', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', { stsUrl: 'http://sts.test' } as never)
    db.query.mockResolvedValueOnce({ rows: [mandateRow] })
    redis.incr.mockResolvedValue(1)
    const result = {
      status: 'guarded' as const,
      detail: 'The upstream rejected an invalid Caracal mandate.',
      checked_at: '2026-07-16T00:00:00.000Z',
    }
    vi.mocked(runResourceVerificationCheck).mockResolvedValue(result)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources/res-1/test' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(result)
    expect(vi.mocked(runResourceVerificationCheck)).toHaveBeenCalledWith(
      mandateRow.upstream_url,
      'http://sts.test',
      mandateRow.identifier,
      'z1',
    )
  })
})

describe('POST /v1/zones/:zoneId/resources', () => {
  it('blocks create with 422 when a caracal_mandate connectivity check is not guarded', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', { stsUrl: 'http://sts.test' } as never)
    redis.incr.mockResolvedValue(1)
    vi.mocked(runResourceVerificationCheck).mockResolvedValue({
      status: 'unverified',
      detail: 'The upstream accepted an invalid Caracal mandate.',
      checked_at: '2026-07-16T00:00:00.000Z',
    })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // zoneExists
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // providerExists
      .mockResolvedValueOnce({ rows: [{ provider_kind: 'caracal_mandate' }] }) // kind lookup

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        name: 'PiperNet',
        identifier: 'resource://pipernet',
        scopes: ['mcp:tool:call'],
        operation_enforcement: 'transport_uniform',
        upstream_url: 'https://api.pipernet.example',
        credential_provider_id: 'provider-1',
        check: true,
      },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'resource_check_failed',
      details: { check: { status: 'unverified' } },
    })
    expect(vi.mocked(runResourceVerificationCheck)).toHaveBeenCalledTimes(1)
  })

  const checkPayload = {
    name: 'PiperNet',
    identifier: 'resource://pipernet',
    scopes: ['mcp:tool:call'],
    operation_enforcement: 'transport_uniform',
    upstream_url: 'https://api.pipernet.example',
    credential_provider_id: 'provider-1',
    check: true,
  }

  it('creates the resource when a caracal_mandate connectivity check is guarded', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', { stsUrl: 'http://sts.test' } as never)
    redis.incr.mockResolvedValue(1)
    vi.mocked(runResourceVerificationCheck).mockResolvedValue({
      status: 'guarded',
      detail: 'The upstream rejected an invalid Caracal mandate.',
      checked_at: '2026-07-16T00:00:00.000Z',
    })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // zoneExists
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // providerExists
      .mockResolvedValueOnce({ rows: [{ provider_kind: 'caracal_mandate' }] }) // kind lookup
      .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'resource://pipernet' }] }) // insert

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources', payload: checkPayload })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'res-1', identifier: 'resource://pipernet' })
    expect(vi.mocked(runResourceVerificationCheck)).toHaveBeenCalledTimes(1)
  })

  it('rate-limits the pre-create connectivity check per zone', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', { stsUrl: 'http://sts.test' } as never)
    redis.incr.mockResolvedValue(11)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // zoneExists
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // providerExists
      .mockResolvedValueOnce({ rows: [{ provider_kind: 'caracal_mandate' }] }) // kind lookup

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources', payload: checkPayload })

    expect(res.statusCode).toBe(429)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_test_rate_limited' })
    expect(vi.mocked(runResourceVerificationCheck)).not.toHaveBeenCalled()
  })

  it('skips the connectivity check when the bound provider is not a caracal_mandate', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', { stsUrl: 'http://sts.test' } as never)
    redis.incr.mockResolvedValue(1)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // zoneExists
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // providerExists
      .mockResolvedValueOnce({ rows: [{ provider_kind: 'api_key' }] }) // kind lookup
      .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'resource://pipernet' }] }) // insert

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources', payload: checkPayload })

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(runResourceVerificationCheck)).not.toHaveBeenCalled()
  })

  it('skips the connectivity check when no verifier issuer is configured', async () => {
    const { app, db, redis } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', {} as never)
    redis.incr.mockResolvedValue(1)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // zoneExists
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // providerExists
      .mockResolvedValueOnce({ rows: [{ provider_kind: 'caracal_mandate' }] }) // kind lookup
      .mockResolvedValueOnce({ rows: [{ id: 'res-1', identifier: 'resource://pipernet' }] }) // insert

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/resources', payload: checkPayload })

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(runResourceVerificationCheck)).not.toHaveBeenCalled()
  })

  it('rejects a resource name longer than the maximum length', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        name: 'a'.repeat(201),
        upstream_url: 'https://api.pipernet.example',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_resource' })
  })

  it('rejects scope and operation lists beyond the payload caps', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValue({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const base = {
      name: 'PiperNet',
      upstream_url: 'https://api.pipernet.example',
      credential_provider_id: 'provider-1',
    }
    const tooManyScopes = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: { ...base, scopes: Array.from({ length: 65 }, (_, i) => `scope-${i}`) },
    })
    const tooManyOperations = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        ...base,
        scopes: ['read'],
        operations: Array.from({ length: 257 }, (_, i) => ({ method: 'GET', path: `/v1/${i}`, scope: 'read' })),
      },
    })
    const emptyScope = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: { ...base, scopes: [''] },
    })

    for (const res of [tooManyScopes, tooManyOperations, emptyScope]) {
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_resource' })
    }
  })

  it('rejects provider references outside the zone', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        scopes: ['read'],
        credential_provider_id: 'provider-other-zone',
      },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_not_found' })
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('rejects relative or provider-shaped resource identifiers', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    for (const identifier of ['pipernet', 'provider://pipernet']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/zones/z1/resources',
        payload: {
          identifier,
          upstream_url: 'https://api.pipernet.example',
          scopes: ['read'],
          credential_provider_id: 'provider-1',
        },
      })

      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_resource_identifier' })
    }
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects resources without Gateway routing', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [{ exists: 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'upstream_url_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('requires a provider for gateway-routed resources', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'credential_provider_required' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('creates the resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'res-1',
            zone_id: 'z1',
            identifier: 'resource://api',
            upstream_url: 'https://api.example.com',
            scopes: ['read'],
          },
        ],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'res-1', identifier: 'resource://api' })
    const insertValues = db.query.mock.calls[2]![1] as unknown[]
    expect(insertValues[6]).toBe('provider-1')
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('rejects operations whose scope is not declared on the resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://nucleus',
        upstream_url: 'https://api.pipernet.example',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
        operations: [{ method: 'get', path: '/api/get_payment', scope: 'write' }],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'operation_scope_not_in_resource_scopes' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('defaults new gateway resources to enforced operation authority', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'res-1',
            zone_id: 'z1',
            identifier: 'resource://nucleus',
            upstream_url: 'https://api.pipernet.example',
            scopes: ['read'],
            operations: [{ method: 'GET', path: '/api/get_payment', scope: 'read' }],
            operation_enforcement: 'enforced',
          },
        ],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://nucleus',
        upstream_url: 'https://api.pipernet.example',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
        operations: [{ method: 'get', path: '/api/get_payment', scope: 'read' }],
      },
    })

    const insertValues = db.query.mock.calls[2]![1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(insertValues[7]).toBe(JSON.stringify([{ method: 'GET', path: '/api/get_payment', scope: 'read' }]))
    expect(insertValues[8]).toBe('enforced')
  })

  it('suffixes generated resource identifiers when the resource name already exists in the zone', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'res-2',
            zone_id: 'z1',
            identifier: 'resource://api-2',
            upstream_url: 'https://api.example.com',
            scopes: ['read'],
          },
        ],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        name: 'API',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    const insertValues = db.query.mock.calls[4]![1] as unknown[]
    expect(res.statusCode).toBe(201)
    expect(insertValues[3]).toBe('resource://api-2')
  })

  it('returns conflict for explicit duplicate resource identifiers', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const conflict = Object.assign(new Error('duplicate resource identifier'), {
      code: '23505',
      constraint: 'resources_zone_id_identifier_key',
    })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockRejectedValueOnce(conflict)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_identifier_conflict' })
  })

  it('rejects resource creation when the zone resource quota is exhausted', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    app.decorate('cfg', { maxResourcesPerZone: 1 })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ resource_count: '1' }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'resource://api',
        upstream_url: 'https://api.example.com',
        scopes: ['read'],
        credential_provider_id: 'provider-1',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_quota_exceeded' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('blocks generic creation of the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'caracal-control',
        scopes: ['control:agent:write'],
      },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'protected_resource' })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('allows the Control path to create the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes, { prefix: '/v1' }, { actor: { scope: 'global' } })
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'provider-none-z1' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'res-control', identifier: 'caracal-control', scopes: ['control:agent:write'] }] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/resources',
      payload: {
        identifier: 'caracal-control',
        scopes: ['control:agent:write'],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'res-control', identifier: 'caracal-control' })
  })
})

describe('PATCH /v1/zones/:zoneId/resources/:id', () => {
  it('returns 404 when the resource is missing during patch', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/missing',
      payload: { name: 'Missing' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns no_fields when patch does not change resource data', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              identifier: 'resource://api',
              upstream_url: 'https://api.example.com',
              credential_provider_id: 'provider-1',
              scopes: ['read'],
              operations: [],
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'no_fields' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('rejects provider rebinding outside the zone', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: { credential_provider_id: 'provider-other-zone' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'provider_not_found' })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('patches the resource identifier in place', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              identifier: 'resource://api',
              upstream_url: 'https://api.example.com',
              credential_provider_id: 'provider-1',
              scopes: ['read'],
              operations: [],
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'res-1',
              zone_id: 'z1',
              identifier: 'resource://api/v2',
              upstream_url: 'https://api.example.com',
              scopes: ['read'],
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: { identifier: 'resource://api/v2' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      identifier: 'resource://api/v2',
    })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE resources'), expect.arrayContaining(['res-1', 'z1']))
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rejects resource identifier patches that use the provider namespace', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              identifier: 'resource://api',
              upstream_url: 'https://api.example.com',
              credential_provider_id: 'provider-1',
              scopes: ['read'],
              operations: [],
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-1',
      payload: { identifier: 'provider://api' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_resource_identifier' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })

  it('blocks generic edits to the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              identifier: 'caracal-control',
              upstream_url: null,
              credential_provider_id: null,
              scopes: ['control:agent:write'],
              operations: [],
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/zones/z1/resources/res-control',
      payload: { scopes: ['control:agent:write'] },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'protected_resource' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })
})

describe('DELETE /v1/zones/:zoneId/resources/:id', () => {
  it('returns 404 when deleting a missing resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/zones/z1/resources/missing',
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resource_not_found' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('archives the resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ identifier: 'resource://api' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/zones/z1/resources/res-1',
    })

    expect(res.statusCode).toBe(204)
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('SET archived_at = now()'), expect.arrayContaining(['res-1', 'z1']))
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalled()
  })

  it('blocks deletion of the Control API resource', async () => {
    const { app, db } = buildRouteApp(resourcesRoutes)
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ identifier: 'caracal-control' }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/zones/z1/resources/res-control',
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'protected_resource' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })
})
