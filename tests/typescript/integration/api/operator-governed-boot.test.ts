// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Boot-level coverage for the governed Operator wiring: real buildApp(), real provisioning
// routes and Postgres custody, and the real SDK application transport over HTTP protocol fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startGovernedOperatorHarness,
  type GovernedOperatorHarness,
} from '../../../shared/test-utils/typescript/governed-operator-harness.js'

const databaseUrl = process.env.CARACAL_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
let harness: GovernedOperatorHarness | undefined

beforeEach(() => {
  vi.stubEnv('SECRET_STORE_KEK', '8f3d9a712c45e6b0d18f2a4c6e9b3d57a1c4f8020e6a9c3d5b7f1a2c4e6d8b90')
  vi.stubEnv('CARACAL_SECRET_BACKEND', 'builtin')
  vi.stubEnv('CARACAL_MODE', 'dev')
})

afterEach(async () => {
  try {
    await harness?.close()
  } finally {
    harness = undefined
    vi.unstubAllEnvs()
  }
})

suite('governed Operator boot wiring', () => {
  it('provisions and seals its model provider before serving through applicationTransport', async () => {
    harness = await startGovernedOperatorHarness(databaseUrl!)
    const auth = { authorization: `Bearer ${harness.adminToken}` }

    const status = await fetch(`${harness.apiUrl}/v1/operator/status`, { headers: auth })
    expect(status.status).toBe(200)
    const statusBody = (await status.json()) as {
      system_zone_id: string | null
      governed_execution: { configured: boolean; zone_id?: string }
    }
    expect(statusBody.governed_execution).toEqual({ configured: true, zone_id: statusBody.system_zone_id })
    expect(statusBody.system_zone_id).toBeTruthy()

    const { rows } = await harness.pool.query<{
      provider_kind: string
      config_json: Record<string, unknown>
      secret_config_keys: string[]
      resource_identifier: string
      upstream_url: string
      envelope: Buffer
      operator_application_id: string
    }>(
      `SELECT p.provider_kind, p.config_json, p.secret_config_keys,
                r.identifier AS resource_identifier, r.upstream_url, s.envelope,
                a.id AS operator_application_id
         FROM zones z
         JOIN applications a ON a.zone_id = z.id AND a.name = 'caracal.sys/operator' AND a.archived_at IS NULL
         JOIN providers p ON p.zone_id = z.id AND p.archived_at IS NULL
         JOIN resources r ON r.zone_id = z.id AND r.credential_provider_id = p.id AND r.archived_at IS NULL
         JOIN secret_store s ON s.zone_id = z.id AND s.ref = 'zones/' || z.id || '/providers/' || p.id || '/secretConfig'
         WHERE z.id = $1 AND r.identifier = $2`,
      [statusBody.system_zone_id, harness.resourceIdentifier],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider_kind: 'api_key',
      secret_config_keys: ['api_key'],
      resource_identifier: harness.resourceIdentifier,
    })
    expect(rows[0].config_json).not.toHaveProperty('api_key')
    expect(rows[0].upstream_url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(Buffer.isBuffer(rows[0].envelope)).toBe(true)
    expect(rows[0].envelope.includes(Buffer.from(harness.upstreamKey))).toBe(false)

    const check = await fetch(`${harness.apiUrl}/v1/operator/ai/check`, { method: 'POST', headers: auth })
    expect(check.status).toBe(200)
    expect(await check.json()).toMatchObject({ ok: true, provider: harness.providerId, model: harness.model })

    expect(harness.stsScopes).toEqual(['agent:lifecycle', 'llm:invoke'])
    expect(harness.stsExchanges).toEqual([
      { scope: 'agent:lifecycle', zoneId: statusBody.system_zone_id, applicationId: rows[0].operator_application_id },
      { scope: 'llm:invoke', zoneId: statusBody.system_zone_id, applicationId: rows[0].operator_application_id },
    ])
    expect(harness.gatewayCalls).toHaveLength(1)
    expect(harness.gatewayCalls[0]).toMatchObject({
      authorization: 'Bearer operator-mandate-1',
      resource: harness.resourceIdentifier,
      path: '/chat/completions',
    })
    expect(harness.gatewayCalls[0].authorization).not.toContain(harness.upstreamKey)
    expect(harness.gatewayCalls[0].baggage).toContain(`caracal.agent_session=${harness.sessionIds.at(-1)}`)
    expect(harness.gatewayCalls[0].baggage).toContain('caracal.delegation_edge=operator-delegation-1')

    expect(harness.upstreamCalls).toHaveLength(1)
    expect(harness.upstreamCalls[0]).toMatchObject({
      authorization: `Bearer ${harness.upstreamKey}`,
      path: '/v1/chat/completions',
    })
    expect(JSON.parse(harness.upstreamCalls[0].body)).toMatchObject({ model: harness.model })
  }, 45_000)
})
