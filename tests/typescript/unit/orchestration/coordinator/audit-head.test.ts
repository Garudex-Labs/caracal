// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Audit gate hot-path query shape and compatibility coverage; live chain verification is in regression.mjs.
import { describe, expect, it } from 'vitest'
import { insertAdminAuditRecord } from '@caracalai/admin-audit'

const record = {
  requestId: 'request',
  actorId: 'app',
  actorName: 'app',
  actorScope: 'agent:lifecycle',
  action: 'POST /agents',
  method: 'POST',
  path: '/agents',
  zoneId: 'zone',
  entityType: 'agents',
  entityId: 'session',
  statusCode: 201,
}

describe('Coordinator audit head lookup', () => {
  it.each(['zone', null])('uses the stored sequence index with zone %s without releasing the chain lock', async (zoneId) => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: sql.includes('FROM admin_audit_events') ? [{ content_sha256: 'previous', chain_seq: '42' }] : [] }
      },
    }
    await insertAdminAuditRecord(db, { ...record, zoneId })
    expect(calls).toHaveLength(3)
    expect(calls[0].sql).toContain('pg_advisory_xact_lock')
    expect(calls[1].sql).toContain('AND chain_seq > 0')
    expect(calls[1].sql).toContain('ORDER BY admin_audit_events.zone_id, admin_audit_events.chain_seq DESC')
    expect(calls[1].params).toEqual(zoneId === null ? [] : [zoneId])
    expect(calls[2].params[15]).toBe('previous')
    expect(calls[2].params[17]).toBe(43)
  })

  it('falls back to the original ordering when only legacy or nonpositive sequence rows exist', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return { rows: sql.includes('COALESCE(chain_seq, 0)') ? [{ content_sha256: 'legacy', chain_seq: 0 }] : [] }
      },
    }
    await insertAdminAuditRecord(db, record)
    expect(calls).toHaveLength(4)
    expect(calls[2].sql).toContain('ORDER BY chain_seq DESC NULLS LAST')
    expect(calls[3].params[15]).toBe('legacy')
    expect(calls[3].params[17]).toBe(1)
  })
})
