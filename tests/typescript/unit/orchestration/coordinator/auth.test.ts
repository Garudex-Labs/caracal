// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator bearer authentication guard unit tests.

import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import '../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { isSessionMandate, validateSubjectProofClaims, verifyBearer } from '../../../../../apps/coordinator/src/auth.js'

function jwtWith(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.addHook('preHandler', verifyBearer)
  app.get('/secure', async () => ({ ok: true }))
  app.get('/stats', async () => ({ ok: true }))
  app.get('/zones/:zoneId/agents', async (req) => ({ auth: req.caracalAuth }))
  app.patch('/zones/:zoneId/agents/:id/suspend', async (req) => ({ auth: req.caracalAuth }))
  app.post('/zones/:zoneId/agents', async () => ({ ok: true }))
  app.get('/zones/:zoneId/agent-services', async (req) => ({ auth: req.caracalAuth }))
  app.get('/zones/:zoneId/invocations', async (req) => ({ auth: req.caracalAuth }))
  app.get('/zones/:zoneId/invocations/:id', async (req) => ({ auth: req.caracalAuth }))
  app.post('/zones/:zoneId/invocations', async () => ({ ok: true }))
  app.get('/zones/:zoneId/delegations/inbound/:sessionId/:id', async (req) => ({ auth: req.caracalAuth }))
  app.post('/zones/:zoneId/outbox/:id/requeue', async (req) => ({ auth: req.caracalAuth }))
  return app
}

describe('coordinator bearer authentication', () => {
  it('accepts only Session-class runtime mandates', () => {
    expect(isSessionMandate({ use: 'session' })).toBe(true)
    expect(isSessionMandate({ use: 'gateway' })).toBe(false)
    expect(isSessionMandate({ use: 'resource' })).toBe(false)
    expect(isSessionMandate({})).toBe(false)
  })

  it('accepts only an identity-only federated Subject mandate as attribution proof', () => {
    const proof = validateSubjectProofClaims(
      {
        sub: 'user:richard.hendricks@piedpiper.example',
        client_id: 'app-1',
        sid: 'subject-record',
        root_sid: 'subject-record',
        use: 'session',
        sub_type: 'user',
        iat: 1,
        jti: 'proof-jti',
      },
      'app-1',
    )
    expect(proof).toEqual({ ok: true, authorityRecordId: 'subject-record', subject: 'user:richard.hendricks@piedpiper.example' })
  })

  it('rejects Subject proofs issued to another application or carrying authority', () => {
    const base = {
      sub: 'user:richard.hendricks@piedpiper.example',
      client_id: 'app-1',
      sid: 'subject-record',
      root_sid: 'subject-record',
      use: 'session',
      sub_type: 'user',
      iat: 1,
      jti: 'proof-jti',
    }
    expect(validateSubjectProofClaims(base, 'app-2')).toMatchObject({
      ok: false,
      status: 403,
      error: 'subject_proof_application_mismatch',
    })
    expect(validateSubjectProofClaims({ ...base, scope: 'agent:lifecycle' }, 'app-1')).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_subject_proof',
    })
    expect(validateSubjectProofClaims({ ...base, agent_session_id: 'session-1' }, 'app-1')).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_subject_proof',
    })
  })

  it('rejects oversized bearer tokens before decoding', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: `Bearer ${'x'.repeat(4097)}` },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'missing_token' })
  })

  it('rejects malformed decoded zone ids before JWKS resolution', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: `Bearer ${jwtWith({ zone_id: '../z1' })}` },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_token' })
  })

  it('accepts the managed operator token on metrics and operator management endpoints', async () => {
    const app = buildApp()
    await app.ready()

    const stats = await app.inject({
      method: 'GET',
      url: '/stats',
      headers: { authorization: 'Bearer coordinator-operator-token' },
    })
    const secure = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Bearer coordinator-operator-token' },
    })
    const agents = await app.inject({
      method: 'GET',
      url: '/zones/019e5da7-7834-7309-857f-b983bbcd40e3/agents',
      headers: { authorization: 'Bearer coordinator-operator-token' },
    })
    const suspend = await app.inject({
      method: 'PATCH',
      url: '/zones/019e5da7-7834-7309-857f-b983bbcd40e3/agents/a1/suspend',
      headers: { authorization: 'Bearer coordinator-operator-token' },
    })
    const create = await app.inject({
      method: 'POST',
      url: '/zones/019e5da7-7834-7309-857f-b983bbcd40e3/agents',
      headers: { authorization: 'Bearer coordinator-operator-token' },
    })
    const requeue = await app.inject({
      method: 'POST',
      url: '/zones/019e5da7-7834-7309-857f-b983bbcd40e3/outbox/019e5da7-7834-7309-857f-b983bbcd40e4/requeue',
      headers: { authorization: 'Bearer coordinator-operator-token' },
    })

    expect(stats.statusCode).toBe(200)
    expect(agents.statusCode).toBe(200)
    expect(agents.json().auth.scopes).toContain('coordinator.admin')
    expect(suspend.statusCode).toBe(200)
    expect(suspend.json().auth.clientId).toBe('caracal-operator')
    expect(requeue.statusCode).toBe(200)
    expect(requeue.json().auth.scopes).toContain('coordinator.admin')
    expect(create.statusCode).toBe(401)
    expect(secure.statusCode).toBe(401)
    expect(secure.json()).toEqual({ error: 'invalid_token' })
  })

  it('grants the operator token read-only access to the execution layer but not detail or mutation', async () => {
    const app = buildApp()
    await app.ready()
    const zone = '019e5da7-7834-7309-857f-b983bbcd40e3'
    const auth = { authorization: 'Bearer coordinator-operator-token' }

    const services = await app.inject({ method: 'GET', url: `/zones/${zone}/agent-services`, headers: auth })
    const invocations = await app.inject({ method: 'GET', url: `/zones/${zone}/invocations`, headers: auth })
    const inbound = await app.inject({ method: 'GET', url: `/zones/${zone}/delegations/inbound/s1/e1`, headers: auth })
    const invocationDetail = await app.inject({ method: 'GET', url: `/zones/${zone}/invocations/i1`, headers: auth })
    const invocationCreate = await app.inject({ method: 'POST', url: `/zones/${zone}/invocations`, headers: auth })

    expect(services.statusCode).toBe(200)
    expect(invocations.statusCode).toBe(200)
    expect(invocations.json().auth.scopes).toContain('coordinator.admin')
    expect(inbound.statusCode).toBe(200)
    expect(inbound.json().auth.scopes).toContain('coordinator.admin')
    expect(invocationDetail.statusCode).toBe(401)
    expect(invocationCreate.statusCode).toBe(401)
  })

  it('requires the managed operator token for metrics routes', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/stats',
      headers: { authorization: 'Bearer not-the-operator-token' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'operator_token_required' })
  })
})
