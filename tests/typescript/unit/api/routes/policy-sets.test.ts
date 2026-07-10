// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy set route unit tests for activation contract checks and durable outbox enqueue.

import { describe, it, expect, vi } from 'vitest'
import { policySetsRoutes } from '../../../../../apps/api/src/routes/policy-sets.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('POST /v1/zones/:zoneId/policy-sets/:id/activate', () => {
  it('rejects policies that are not data documents', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'psv-1', manifest_json: [{ policy_version_id: 'pv-1' }], schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'pv-1', content: 'package caracal.authz\ndefault allow = false', zone_id: 'z1', schema_version: '2026-05-20' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/activate',
      payload: { version_id: 'psv-1' },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_policy_contract' })
  })

  it('rejects manifests that reference policies in another zone', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'psv-1', manifest_json: [{ policy_version_id: 'pv-1' }], schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'pv-1', content: 'package caracal.authz\nresult := {}', zone_id: 'z2', schema_version: '2026-05-20' }],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/activate',
      payload: { version_id: 'psv-1' },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error_description).toMatch(/different zone/)
  })

  it('activates valid version, deactivates sibling sets, enqueues outbox row in TX, returns 202', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    const manifest = [{ policy_version_id: 'pv-1' }]
    const content = '# caracal:data-document\npackage caracal.authz\ngrants := {}'
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'psv-1', manifest_json: manifest, schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pv-1', content, zone_id: 'z1', schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({ rows: [] })

    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'psv-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/activate',
      payload: { version_id: 'psv-1' },
    })

    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body)).toMatchObject({ activated: true, version_id: 'psv-1' })
    expect(JSON.parse(res.body).outbox_id).toEqual(expect.any(String))
    expect(JSON.parse(res.body).status_url).toContain('/activation-status?version_id=psv-1&outbox_id=')
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls.at(-1)).toBe('COMMIT')
    expect(sqls.some((sql) => sql.includes('pg_advisory_xact_lock') && sql.includes('hashtext'))).toBe(true)
    expect(sqls.some((sql) => sql.includes('FOR UPDATE OF ps, psv') && sql.includes('ps.archived_at IS NULL'))).toBe(true)
    expect(sqls.some((sql) => sql.includes('policy_set_id <> $2') && sql.includes('active_version_id = NULL'))).toBe(true)
    expect(sqls.some((sql) => sql.includes('INSERT INTO event_outbox'))).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('does not reactivate a set archived before the transaction lock', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    const manifest = [{ policy_version_id: 'pv-1' }]
    const content = '# caracal:data-document\npackage caracal.authz\ngrants := {}'
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'psv-1', manifest_json: manifest, schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pv-1', content, zone_id: 'z1', schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({ rows: [] })

    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/activate',
      payload: { version_id: 'psv-1' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'version_not_found' })
    const sqls = client.query.mock.calls.map((call) => String(call[0]))
    expect(sqls.some((sql) => sql.includes('active_version_id = $1'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('INSERT INTO event_outbox'))).toBe(false)
    expect(sqls.at(-1)).toBe('ROLLBACK')
  })
})

describe('GET /v1/zones/:zoneId/policy-sets/:id/activation-status', () => {
  it('reports active binding, dispatched outbox, and loaded STS bundle', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    app.decorate('cfg', {
      stsUrl: 'http://sts.local',
      gatewayStsHmacKey: Buffer.alloc(32, 1),
    } as never)
    db.query.mockResolvedValueOnce({ rows: [{ active_version_id: 'psv-1', manifest_sha256: 'sha-1' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'outbox-1',
          stream_name: 'caracal.policy.invalidate',
          payload_json: { zone_id: 'z1', policy_set_id: 'ps-1', policy_set_version_id: 'psv-1' },
          attempts: 1,
          last_error: null,
          dispatched_at: new Date('2026-01-01T00:00:00Z'),
          available_at: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          zone_id: 'z1',
          loaded: true,
          policy_set_version_id: 'psv-1',
          manifest_sha256: 'sha-1',
          loaded_at: '2026-01-01T00:00:01Z',
          age_seconds: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/policy-sets/ps-1/activation-status?version_id=psv-1&outbox_id=outbox-1',
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      active: true,
      propagation_status: 'loaded',
      outbox: { id: 'outbox-1', state: 'dispatched' },
      sts: { state: 'loaded', policy_set_version_id: 'psv-1' },
    })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://sts.local/internal/policy/status/z1')
    fetchMock.mockRestore()
  })

  it('reports missing bindings, missing active versions, and pending propagation', async () => {
    const missingBinding = buildRouteApp(policySetsRoutes)
    missingBinding.db.query.mockResolvedValueOnce({ rows: [] })
    await missingBinding.app.ready()
    const missingBindingRes = await missingBinding.app.inject({
      method: 'GET',
      url: '/v1/zones/z1/policy-sets/ps-1/activation-status',
    })
    expect(missingBindingRes.statusCode).toBe(404)
    expect(JSON.parse(missingBindingRes.body)).toMatchObject({ error: 'policy_set_binding_not_found' })

    const noActive = buildRouteApp(policySetsRoutes)
    noActive.db.query.mockResolvedValueOnce({ rows: [{ active_version_id: null, manifest_sha256: null }] })
    await noActive.app.ready()
    const noActiveRes = await noActive.app.inject({
      method: 'GET',
      url: '/v1/zones/z1/policy-sets/ps-1/activation-status',
    })
    expect(noActiveRes.statusCode).toBe(404)
    expect(JSON.parse(noActiveRes.body)).toMatchObject({ error: 'active_policy_set_version_not_found' })

    const pending = buildRouteApp(policySetsRoutes)
    pending.db.query
      .mockResolvedValueOnce({ rows: [{ active_version_id: 'psv-1', manifest_sha256: 'sha-1' }] })
      .mockResolvedValueOnce({ rows: [] })
    await pending.app.ready()
    const pendingRes = await pending.app.inject({
      method: 'GET',
      url: '/v1/zones/z1/policy-sets/ps-1/activation-status',
    })
    expect(pendingRes.statusCode).toBe(200)
    expect(JSON.parse(pendingRes.body)).toMatchObject({
      propagation_status: 'waiting_for_outbox',
      outbox: { state: 'missing' },
      sts: { state: 'not_configured' },
    })
  })
})

describe('POST /v1/zones/:zoneId/policy-sets/:id/simulate', () => {
  it('validates rollout contract without mutating bindings', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    const manifest = [{ policy_version_id: 'pv-1' }]
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'psv-1', manifest_json: manifest, manifest_sha256: 'sha-1', schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'pv-1',
            content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
            zone_id: 'z1',
            schema_version: '2026-05-20',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/simulate',
      payload: {
        version_id: 'psv-1',
        input: {
          schema_version: '2026-05-20',
          principal: { zone_id: 'z1' },
          resource: { identifier: 'resource://calendar' },
          action: { id: 'token_exchange' },
          context: {},
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      dry_run: true,
      would_activate: true,
      version_id: 'psv-1',
      input_schema_version: '2026-05-20',
    })
    expect(db.connect).not.toHaveBeenCalled()
  })

  it('executes supplied input through STS when internal simulation is configured', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    app.decorate('cfg', {
      stsUrl: 'http://sts.local',
      gatewayStsHmacKey: Buffer.alloc(32, 1),
    } as never)
    const manifest = [{ policy_version_id: 'pv-1' }]
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'psv-1', manifest_json: manifest, manifest_sha256: 'sha-1', schema_version: '2026-05-20' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'pv-1',
            content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
            zone_id: 'z1',
            schema_version: '2026-05-20',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          policy_set_id: 'ps-1',
          version_id: 'psv-1',
          manifest_sha256: 'sha-1',
          result: {
            decision: 'allow',
            evaluation_status: 'complete',
            determining_policies: [],
            diagnostics: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/simulate',
      payload: {
        version_id: 'psv-1',
        input: {
          schema_version: '2026-05-20',
          principal: { zone_id: 'z1' },
          resource: { identifier: 'resource://calendar' },
          action: { id: 'token_exchange' },
          context: {},
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      explanation: { evaluation: 'executed', decision: 'allow' },
      result: { decision: 'allow', evaluation_status: 'complete' },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://sts.local/internal/policy/simulate')
    expect((init as RequestInit).headers).toMatchObject({
      'content-type': 'application/json',
      'X-Caracal-Gateway-Timestamp': expect.any(String),
      'X-Caracal-Gateway-Request': expect.any(String),
      'X-Caracal-Gateway-Signature': expect.any(String),
    })
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
    fetchMock.mockRestore()
  })

  it('rejects manifests whose policy versions pin different schemas', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'psv-1',
            manifest_json: [{ policy_version_id: 'pv-1' }, { policy_version_id: 'pv-2' }],
            manifest_sha256: 'sha-1',
            schema_version: '2026-05-20',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'pv-1',
            content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
            zone_id: 'z1',
            schema_version: '2026-05-20',
          },
          {
            id: 'pv-2',
            content: '# caracal:data-document\npackage caracal.authz\napp_ids := {}',
            zone_id: 'z1',
            schema_version: '2026-03-16',
          },
        ],
      })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/simulate',
      payload: { version_id: 'psv-1' },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error_description).toContain('does not match policy set schema')
  })

  it('returns input warnings and STS simulation failure details', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    app.decorate('cfg', {
      stsUrl: 'http://sts.local',
      gatewayStsHmacKey: Buffer.alloc(32, 1),
    } as never)
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: 'psv-1', manifest_json: [{ policy_version_id: 'pv-1' }], manifest_sha256: 'sha-1', schema_version: '2026-05-20' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'pv-1',
            content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
            zone_id: 'z1',
            schema_version: '2026-05-20',
          },
        ],
      })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'simulation_failed',
          detail: 'OPA unavailable',
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    )

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/simulate',
      payload: {
        version_id: 'psv-1',
        input: { schema_version: 'bad', principal: { zone_id: 'z2' } },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      would_activate: false,
      warnings: expect.arrayContaining([
        'input_schema_mismatch:bad',
        'principal_zone_mismatch',
        'missing_resource',
        'missing_action',
        'missing_context',
        'sts_simulation_failed:simulation_failed',
      ]),
      explanation: { evaluation: 'failed', reason: 'OPA unavailable' },
    })
    fetchMock.mockRestore()
  })
})

function setActor(app: ReturnType<typeof buildRouteApp>['app']) {
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { actor: unknown }).actor = { id: 'a1', name: 'operator', scope: 'zone', zoneId: 'z1' }
  })
}

describe('GET /v1/zones/:zoneId/policy-sets', () => {
  it('lists policy sets for the zone', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1' }, { id: 'ps-2' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policy-sets' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toHaveLength(2)
    expect(body.next_cursor).toBeNull()
  })

  it('returns a single policy set', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1', active_version_id: 'v1' }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policy-sets/ps-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'ps-1' })
  })

  it('returns 404 for a missing policy set', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policy-sets/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_set_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/policy-sets create', () => {
  it('creates a policy set and its binding in a transaction', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // zoneExists
    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'ps-1', zone_id: 'z1', name: 'Set' }] }) // INSERT policy_sets
      .mockResolvedValueOnce({ rows: [] }) // INSERT binding
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/policy-sets', payload: { name: 'Set' } })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'ps-1' })
  })

  it('returns 409 when the name is already taken in the zone', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // zoneExists
    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'policy_sets_zone_id_name_key',
        }),
      ) // INSERT policy_sets conflict
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/policy-sets', payload: { name: 'Set' } })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_set_name_conflict' })
  })

  it('returns 404 when the zone does not exist', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    db.query.mockResolvedValueOnce({ rows: [] }) // zoneExists -> false

    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/zones/z1/policy-sets', payload: { name: 'Set' } })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'zone_not_found' })
  })
})

describe('POST /v1/zones/:zoneId/policy-sets/:id/versions', () => {
  it('creates a version after validating the manifest contract', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'pv-1',
          content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
          zone_id: 'z1',
          schema_version: '2026-05-20',
        },
      ],
    })
    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'psv-1', policy_set_id: 'ps-1', version: 1, manifest_sha256: 'sha', schema_version: '2026-05-20' }],
      })
      .mockResolvedValueOnce({ rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/versions',
      payload: { manifest: [{ policy_version_id: 'pv-1' }] },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'psv-1', version_id: 'psv-1', version: 1 })
    expect(client.query.mock.calls[1][0]).toContain('pg_advisory_xact_lock')
  })

  it('rejects duplicate and missing policy version manifests', async () => {
    const duplicate = buildRouteApp(policySetsRoutes)
    setActor(duplicate.app)
    duplicate.db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1' }] }).mockResolvedValueOnce({
      rows: [{ id: 'pv-1', content: 'package caracal.authz\nresult := {"allow": true}', zone_id: 'z1', schema_version: '2026-05-20' }],
    })
    await duplicate.app.ready()
    const duplicateRes = await duplicate.app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/versions',
      payload: { manifest: [{ policy_version_id: 'pv-1' }, { policy_version_id: 'pv-1' }] },
    })
    expect(duplicateRes.statusCode).toBe(422)
    expect(JSON.parse(duplicateRes.body).error_description).toContain('duplicate')

    const missing = buildRouteApp(policySetsRoutes)
    setActor(missing.app)
    missing.db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1' }] }).mockResolvedValueOnce({ rows: [] })
    await missing.app.ready()
    const missingRes = await missing.app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/versions',
      payload: { manifest: [{ policy_version_id: 'pv-missing' }] },
    })
    expect(missingRes.statusCode).toBe(422)
    expect(JSON.parse(missingRes.body).error_description).toContain('missing policy versions')
  })

  it('returns 404 when the policy set is missing', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    db.query.mockResolvedValueOnce({ rows: [] }) // policy set lookup

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/versions',
      payload: { manifest: [{ policy_version_id: 'pv-1' }] },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_set_not_found' })
  })

  it('rejects manifests pinned to an unsupported stored schema version', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'pv-1',
          content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
          zone_id: 'z1',
          schema_version: '1900-01-01',
        },
      ],
    })

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/versions',
      payload: { manifest: [{ policy_version_id: 'pv-1' }] },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_policy_contract' })
    expect(JSON.parse(res.body).error_description).toContain('unsupported_schema_version')
  })

  it('blocks the version when the merged bundle fails to compile on STS', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    app.decorate('cfg', {
      stsUrl: 'http://sts.local',
      gatewayStsHmacKey: Buffer.alloc(32, 1),
    } as never)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'pv-1',
          content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
          zone_id: 'z1',
          schema_version: '2026-05-20',
        },
      ],
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'policy_eval_failed', detail: 'compile simulation policy bundle: rego_type_error' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/versions',
      payload: { manifest: [{ policy_version_id: 'pv-1' }] },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_policy_bundle' })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://sts.local/internal/policy/simulate')
    fetchMock.mockRestore()
  })

  it('returns 503 when bundle verification is unreachable', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    setActor(app)
    app.decorate('cfg', {
      stsUrl: 'http://sts.local',
      gatewayStsHmacKey: Buffer.alloc(32, 1),
    } as never)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ps-1' }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 'pv-1',
          content: '# caracal:data-document\npackage caracal.authz\ngrants := {}',
          zone_id: 'z1',
          schema_version: '2026-05-20',
        },
      ],
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'))

    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/zones/z1/policy-sets/ps-1/versions',
      payload: { manifest: [{ policy_version_id: 'pv-1' }] },
    })

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_verification_unavailable' })
    fetchMock.mockRestore()
  })
})

describe('GET /v1/zones/:zoneId/policy-sets/:id/versions/:versionId', () => {
  it('returns a policy set version', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'psv-1', version: 1, policies: ['pv-1'] }] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policy-sets/ps-1/versions/psv-1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'psv-1' })
  })

  it('returns 404 for a missing version', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    db.query.mockResolvedValueOnce({ rows: [] })

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/zones/z1/policy-sets/ps-1/versions/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_set_version_not_found' })
  })
})

describe('DELETE /v1/zones/:zoneId/policy-sets/:id', () => {
  it('archives the set, clears its active binding, and enqueues an invalidation', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/policy-sets/ps-1' })

    expect(res.statusCode).toBe(204)
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((sql) => sql.includes('pg_advisory_xact_lock') && sql.includes('hashtext'))).toBe(true)
    expect(sqls.some((sql) => sql.includes('active_version_id = NULL'))).toBe(true)
    expect(sqls.some((sql) => sql.includes('INSERT INTO event_outbox'))).toBe(true)
    expect(sqls.at(-1)).toBe('COMMIT')
  })

  it('archives an inactive set without enqueueing an invalidation', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/policy-sets/ps-1' })

    expect(res.statusCode).toBe(204)
    const sqls = client.query.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((sql) => sql.includes('INSERT INTO event_outbox'))).toBe(false)
  })

  it('returns 404 when the policy set is missing', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    const client = { query: vi.fn(), release: vi.fn() }
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValue({ rows: [] })
    db.connect.mockResolvedValueOnce(client)

    await app.ready()
    const res = await app.inject({ method: 'DELETE', url: '/v1/zones/z1/policy-sets/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_set_not_found' })
  })
})
