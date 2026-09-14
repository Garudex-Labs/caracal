// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Integration tests that execute the real schema: zone row-level security, outbox dedupe, and the admin audit hash chain.

import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertAdminAuditRecord } from '../../../../packages/adminAudit/ts/src/index.js'

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

  it('resets the zone scope when the transaction ends', async () => {
    const client = await pool.connect()
    const zoneA = await makeZone(client, 'rls-local-a')
    const zoneB = await makeZone(client, 'rls-local-b')
    const applicationA = randomUUID()
    const applicationB = randomUUID()
    try {
      await client.query(
        "INSERT INTO applications (id, zone_id, name, registration_method) VALUES ($1, $2, $3, 'managed'), ($4, $5, $6, 'managed')",
        [applicationA, zoneA, 'anton-local', applicationB, zoneB, 'fiona-local'],
      )
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE caracalapi')
      await client.query('SELECT set_config($1, $2, true)', ['caracal.zone_id', zoneA])
      const scoped = await client.query<{ zone_id: string }>('SELECT zone_id FROM applications WHERE id = ANY($1)', [
        [applicationA, applicationB],
      ])
      expect(scoped.rows).toEqual([{ zone_id: zoneA }])
      await client.query('COMMIT')

      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE caracalapi')
      const nextScope = await client.query<{ zone_id: string | null }>("SELECT current_setting('caracal.zone_id', true) AS zone_id")
      expect(nextScope.rows[0]?.zone_id).not.toBe(zoneA)
      await client.query('ROLLBACK')
    } finally {
      await client.query('DELETE FROM applications WHERE id = ANY($1)', [[applicationA, applicationB]]).catch(() => {})
      await client.query('DELETE FROM zones WHERE id = ANY($1)', [[zoneA, zoneB]]).catch(() => {})
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
