// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy-set route tests for graceful degradation when STS returns an unparseable (non-JSON) response body.

import { describe, it, expect, vi } from 'vitest'
import { policySetsRoutes } from '../../../../../apps/api/src/routes/policy-sets.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('policy-sets STS response degradation', () => {
  it('degrades gracefully when STS returns an unparseable simulation body', async () => {
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
      .mockResolvedValueOnce({ rows: [] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'content-type': 'application/json' } }))

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
      explanation: { evaluation: 'failed', reason: 'STS simulation returned an unparseable response' },
      result: null,
    })
    expect(JSON.parse(res.body).warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^sts_simulation_invalid_response:/)]))
    fetchMock.mockRestore()
  })

  it('marks STS failed when the status response body is unparseable', async () => {
    const { app, db } = buildRouteApp(policySetsRoutes)
    app.decorate('cfg', {
      stsUrl: 'http://sts.local',
      gatewayStsHmacKey: Buffer.alloc(32, 1),
    } as never)
    db.query
      .mockResolvedValueOnce({ rows: [{ active_version_id: 'psv-1', shadow_version_id: null, manifest_sha256: 'sha-1' }] })
      .mockResolvedValueOnce({
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
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }))

    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/zones/z1/policy-sets/ps-1/activation-status?version_id=psv-1&outbox_id=outbox-1',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.sts.state).toBe('failed')
    expect(body.sts.detail).toMatch(/invalid STS response/)
    expect(body.propagation_status).toBe('failed')
    fetchMock.mockRestore()
  })
})
