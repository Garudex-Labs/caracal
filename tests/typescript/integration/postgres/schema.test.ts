// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Integration tests that execute the real schema: zone row-level security, outbox dedupe, and the admin audit hash chain.

import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertAdminAuditRecord } from '../../../../packages/adminAudit/ts/src/index.js'
import { insertAiProvider, setAiProviderReconciliation, upsertAiProvider } from '../../../../apps/api/src/operator-ai-store.js'

// These assertions are about SQL the unit suites can only match as text, so they need a real
// database. Without one the tier is skipped rather than silently passing on a mock.
const databaseUrl = process.env.CARACAL_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip

let pool: pg.Pool

beforeAll(async () => {
  if (!databaseUrl) return
  pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
})

afterAll(async () => {
  await pool?.end()
})

async function makeZone(client: pg.PoolClient, label: string): Promise<string> {
  const id = randomUUID()
  await client.query(`INSERT INTO zones (id, name, slug) VALUES ($1, $2, $3)`, [id, `${label} ${id}`, `${label}-${id}`])
  return id
}

suite('zone row-level security', () => {
  it('hides another zone rows from a zone-scoped session', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const zoneA = await makeZone(client, 'rls-a')
      const zoneB = await makeZone(client, 'rls-b')
      for (const [zone, name] of [
        [zoneA, 'anton'],
        [zoneB, 'fiona'],
      ]) {
        await client.query(`INSERT INTO applications (id, zone_id, name, registration_method) VALUES ($1, $2, $3, 'managed')`, [
          randomUUID(),
          zone,
          name,
        ])
      }

      // caracalapi is the API's runtime role and does not carry BYPASSRLS, so the policy is
      // actually enforced for this session rather than skipped as it would be for the owner.
      await client.query('SET LOCAL ROLE caracalapi')
      await client.query('SELECT set_config($1, $2, true)', ['caracal.zone_id', zoneA])
      const scoped = await client.query<{ zone_id: string }>(`SELECT zone_id FROM applications WHERE zone_id = ANY($1)`, [[zoneA, zoneB]])
      expect(scoped.rows.map((r) => r.zone_id)).toEqual([zoneA])

      // The control plane runs with the wildcard sentinel and must still see every zone.
      await client.query('SELECT set_config($1, $2, true)', ['caracal.zone_id', '*'])
      const wildcard = await client.query<{ zone_id: string }>(`SELECT zone_id FROM applications WHERE zone_id = ANY($1)`, [[zoneA, zoneB]])
      expect(new Set(wildcard.rows.map((r) => r.zone_id))).toEqual(new Set([zoneA, zoneB]))
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('refuses a write that would land in another zone', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const zoneA = await makeZone(client, 'rls-write-a')
      const zoneB = await makeZone(client, 'rls-write-b')
      await client.query('SET LOCAL ROLE caracalapi')
      await client.query('SELECT set_config($1, $2, true)', ['caracal.zone_id', zoneA])
      await expect(
        client.query(`INSERT INTO applications (id, zone_id, name, registration_method) VALUES ($1, $2, 'smuggled', 'managed')`, [
          randomUUID(),
          zoneB,
        ]),
      ).rejects.toThrow(/row-level security/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

suite('coordinator outbox dedupe', () => {
  async function enqueue(client: pg.PoolClient, dedupeKey: string): Promise<number> {
    const res = await client.query(
      `INSERT INTO caracal_outbox (id, producer, topic, dedupe_key, payload_json)
       VALUES ($1, 'coordinator', 'caracal.sessions.revoke', $2, '{}'::jsonb)
       ON CONFLICT (producer, topic, dedupe_key) DO NOTHING`,
      [randomUUID(), dedupeKey],
    )
    return res.rowCount ?? 0
  }

  it('collapses a repeated key and keeps a distinct occurrence', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const session = randomUUID()
      // Entity-scoped keys are what made a second suspension of the same session vanish; an
      // occurrence-scoped key must still be published.
      expect(await enqueue(client, `suspend:${session}:1`)).toBe(1)
      expect(await enqueue(client, `suspend:${session}:1`)).toBe(0)
      expect(await enqueue(client, `suspend:${session}:2`)).toBe(1)

      const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM caracal_outbox WHERE dedupe_key LIKE $1`, [
        `suspend:${session}:%`,
      ])
      expect(Number(rows[0].n)).toBe(2)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

suite('admin audit hash chain', () => {
  function record(zoneId: string, path: string) {
    return {
      requestId: randomUUID(),
      actorId: 'admin:test',
      actorName: 'test',
      actorScope: 'global',
      action: `POST ${path}`,
      method: 'POST',
      path,
      zoneId,
      entityType: 'zones',
      entityId: zoneId,
      statusCode: 201,
      payloadJson: { rls_mode: 'control_plane_wildcard' },
    }
  }

  it('links each record to the previous one and advances the sequence', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const zone = await makeZone(client, 'audit-chain')
      const hmacKey = Buffer.alloc(32, 7)

      await insertAdminAuditRecord(client, record(zone, '/v1/zones'), hmacKey)
      await insertAdminAuditRecord(client, record(zone, '/v1/zones/x/applications'), hmacKey)

      const { rows } = await client.query<{
        chain_seq: string
        content_sha256: string
        prev_content_sha256: string
        chain_hmac: string
      }>(
        `SELECT chain_seq, content_sha256, prev_content_sha256, chain_hmac
         FROM admin_audit_events WHERE zone_id = $1 ORDER BY chain_seq`,
        [zone],
      )

      expect(rows).toHaveLength(2)
      expect(Number(rows[0].chain_seq)).toBe(1)
      expect(Number(rows[1].chain_seq)).toBe(2)
      expect(rows[0].prev_content_sha256 ?? '').toBe('')
      // The chain is only tamper-evident if each link actually carries the prior digest.
      expect(rows[1].prev_content_sha256).toBe(rows[0].content_sha256)
      expect(rows[0].chain_hmac).toBeTruthy()
      expect(rows[1].chain_hmac).not.toBe(rows[0].chain_hmac)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('keeps a separate chain per zone', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const zoneA = await makeZone(client, 'audit-a')
      const zoneB = await makeZone(client, 'audit-b')
      await insertAdminAuditRecord(client, record(zoneA, '/v1/zones'), null)
      await insertAdminAuditRecord(client, record(zoneB, '/v1/zones'), null)

      const { rows } = await client.query<{ zone_id: string; chain_seq: string }>(
        `SELECT zone_id, chain_seq FROM admin_audit_events WHERE zone_id = ANY($1) ORDER BY zone_id`,
        [[zoneA, zoneB]],
      )
      expect(rows.every((r) => Number(r.chain_seq) === 1)).toBe(true)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

suite('operator provider reconciliation schema', () => {
  it('defaults existing lifecycle writes to ready and enforces durable state values', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const slug = `test_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const { rows } = await client.query<{
        reconciliation_state: string
        reconciliation_error_code: string | null
        credential_required: boolean
        reconciled_at: string | null
      }>(
        `INSERT INTO operator_ai_providers (slug, label, base_url)
         VALUES ($1, 'Test', 'https://example.test/v1')
         RETURNING reconciliation_state, reconciliation_error_code, credential_required, reconciled_at`,
        [slug],
      )
      expect(rows[0]).toEqual({
        reconciliation_state: 'ready',
        reconciliation_error_code: null,
        credential_required: false,
        reconciled_at: null,
      })
      await expect(
        client.query(`UPDATE operator_ai_providers SET reconciliation_state = 'unknown' WHERE slug = $1`, [slug]),
      ).rejects.toThrow(/operator_ai_providers_reconciliation_state_check/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('rejects a duplicate lifecycle create without replacing the existing row', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const slug = `test_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const input = {
        slug,
        label: 'Original',
        baseUrl: 'https://original.example/v1',
        models: ['original-model'],
        contextWindow: 0,
        enabled: true,
        auth: { location: 'header' as const, headerName: 'Authorization', authScheme: 'Bearer' },
        reconciliationState: 'pending' as const,
        reconciliationErrorCode: null,
        credentialRequired: true,
      }
      expect(await insertAiProvider(client, input)).toMatchObject({ slug, label: 'Original' })
      expect(await insertAiProvider(client, { ...input, label: 'Replacement' })).toBeNull()
      const { rows } = await client.query<{ label: string }>('SELECT label FROM operator_ai_providers WHERE slug = $1', [slug])
      expect(rows[0]?.label).toBe('Original')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('refuses every lifecycle write that would revive a delete tombstone', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const slug = `test_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const input = {
        slug,
        label: 'Doomed',
        baseUrl: 'https://doomed.example/v1',
        models: ['doomed-model'],
        contextWindow: 0,
        enabled: true,
        auth: { location: 'header' as const, headerName: 'Authorization', authScheme: 'Bearer' },
        reconciliationState: 'ready' as const,
        reconciliationErrorCode: null,
        credentialRequired: false,
      }
      await insertAiProvider(client, input)
      expect(await setAiProviderReconciliation(client, slug, 'deleting', null, false)).toMatchObject({ reconciliationState: 'deleting' })

      // An edit or rotation that read the row before the remove claimed it must lose the race
      // in the database, not merely in the manager's pre-read check.
      expect(await upsertAiProvider(client, { ...input, label: 'Resurrected', reconciliationState: 'pending' })).toBeNull()
      expect(await setAiProviderReconciliation(client, slug, 'pending', null, true)).toBeNull()
      expect(await setAiProviderReconciliation(client, slug, 'ready', null, false)).toBeNull()

      const { rows } = await client.query<{ label: string; reconciliation_state: string }>(
        'SELECT label, reconciliation_state FROM operator_ai_providers WHERE slug = $1',
        [slug],
      )
      expect(rows[0]).toEqual({ label: 'Doomed', reconciliation_state: 'deleting' })
      // Remove stays retryable: a write that keeps the tombstone is still allowed.
      expect(await setAiProviderReconciliation(client, slug, 'deleting', 'reconciliation_failed', false)).toMatchObject({
        reconciliationState: 'deleting',
      })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
