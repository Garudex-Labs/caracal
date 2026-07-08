// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Notification dispatcher unit tests for payload signing, backoff, fan-out, and delivery.

import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'

// Test-only deterministic KEK fixture (32-byte hex). Never use in production.
process.env.SECRET_STORE_KEK = '8f3d9a71c2b44e5f96a103d7be28cc41d5f09ab6731e4c8f2a7db56019ce34af'

const { runNotificationDispatch, signSinkPayload, sinkBackoffSeconds, sinkPayload } =
  await import('../../../../../apps/api/src/jobs/notification-dispatcher.js')
const { AAD_NOTIFICATION_SINK_SECRET, loadSecretStoreKek, sealEnvelope } = await import('@caracalai/server-core')
import type { DB } from '../../../../../apps/api/src/db.js'
import type { SinkFetch } from '../../../../../apps/api/src/jobs/notification-dispatcher.js'

function sealedSecret(secret: string): Buffer {
  return sealEnvelope(loadSecretStoreKek(), Buffer.from(secret, 'utf8'), AAD_NOTIFICATION_SINK_SECRET)
}

describe('signSinkPayload', () => {
  it('signs timestamp.body with versioned HMAC-SHA256', () => {
    const want = `v1=${createHmac('sha256', 'nsk_secret').update('1700000000.{"a":1}').digest('hex')}`
    expect(signSinkPayload('nsk_secret', '1700000000', '{"a":1}')).toBe(want)
  })
})

describe('sinkBackoffSeconds', () => {
  it('doubles from 30 seconds to a 15-minute ceiling with bounded jitter', () => {
    for (let i = 0; i < 20; i++) {
      const first = sinkBackoffSeconds(1)
      expect(first).toBeGreaterThanOrEqual(30)
      expect(first).toBeLessThanOrEqual(39)
      const capped = sinkBackoffSeconds(12)
      expect(capped).toBeGreaterThanOrEqual(900)
      expect(capped).toBeLessThanOrEqual(1170)
    }
  })
})

describe('sinkPayload', () => {
  it('carries the audit event facts and its metadata verbatim', () => {
    const payload = sinkPayload({
      id: 'evt-1',
      zone_id: 'z1',
      event_type: 'step_up_issued',
      decision: 'pending',
      metadata_json: { challenge_id: 'challenge-1', tier: 'money' },
      occurred_at: new Date('2026-01-01T00:00:00Z'),
      chain_seq: '7',
    })
    expect(payload).toEqual({
      id: 'evt-1',
      type: 'step_up_issued',
      zone_id: 'z1',
      decision: 'pending',
      occurred_at: '2026-01-01T00:00:00.000Z',
      data: { challenge_id: 'challenge-1', tier: 'money' },
    })
  })
})

interface FakeDbOptions {
  acquired?: boolean
  sinks?: Record<string, unknown>[]
  events?: Record<string, unknown>[]
  due?: Record<string, unknown>[]
}

// Routes every query by SQL shape so one fake covers the lock client, the pool, and the
// fan-out transaction clients withTransaction opens.
function fakeDb(opts: FakeDbOptions) {
  const calls: { sql: string; params?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: opts.acquired ?? true }] }
    if (sql.includes('FROM notification_sinks WHERE active')) return { rows: opts.sinks ?? [] }
    if (sql.includes('FROM audit_events') && sql.includes('chain_seq >')) return { rows: opts.events ?? [] }
    if (sql.includes('COALESCE(MAX(chain_seq), 0)')) return { rows: [{ seq: '9' }] }
    if (sql.includes('SET attempts = d.attempts + 1')) return { rows: opts.due ?? [] }
    return { rows: [], rowCount: 0 }
  })
  const connect = vi.fn(async () => ({ query, release: vi.fn() }))
  return { db: { query, connect } as unknown as DB, calls }
}

const EVENT = {
  id: 'evt-1',
  zone_id: 'z1',
  event_type: 'step_up_issued',
  decision: 'pending',
  metadata_json: { challenge_id: 'challenge-1' },
  occurred_at: '2026-01-01T00:00:00.000Z',
  chain_seq: '8',
}

describe('runNotificationDispatch', () => {
  it('skips the pass entirely when another replica holds the lock', async () => {
    const { db, calls } = fakeDb({ acquired: false })

    await expect(runNotificationDispatch(db, vi.fn())).resolves.toEqual({ enqueued: 0, delivered: 0, failed: 0 })

    expect(calls).toHaveLength(1)
  })

  it('enqueues matching events once per sink and advances the cursor to the stream head', async () => {
    const { db, calls } = fakeDb({
      sinks: [{ id: 'sink-1', zone_id: 'z1', event_types: ['step_up_issued'], cursor_chain_seq: '5' }],
      events: [EVENT],
    })

    const totals = await runNotificationDispatch(db, vi.fn())

    expect(totals.enqueued).toBe(1)
    const insert = calls.find((c) => c.sql.includes('INSERT INTO notification_deliveries'))
    expect(insert?.sql).toContain('ON CONFLICT (sink_id, event_id) DO NOTHING')
    expect(insert?.params?.[3]).toBe('evt-1')
    expect(JSON.parse(String(insert?.params?.[5]))).toMatchObject({ type: 'step_up_issued', data: { challenge_id: 'challenge-1' } })
    const cursor = calls.find((c) => c.sql.includes('SET cursor_chain_seq'))
    expect(cursor?.params).toEqual(['sink-1', '9'])
  })

  it('posts a signed delivery and records success on the delivery and the sink', async () => {
    const secretCt = sealedSecret('nsk_test')
    const { db, calls } = fakeDb({
      due: [
        {
          id: 'd1',
          sink_id: 'sink-1',
          event_id: 'evt-1',
          event_type: 'step_up_issued',
          payload_json: { id: 'evt-1', type: 'step_up_issued' },
          attempts: 1,
          url: 'https://hooks.hooli.example/caracal',
          secret_ct: secretCt,
        },
      ],
    })
    const fetchImpl = vi.fn(async () => ({ status: 200 })) as unknown as SinkFetch

    const totals = await runNotificationDispatch(db, fetchImpl)

    expect(totals.delivered).toBe(1)
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://hooks.hooli.example/caracal')
    expect(init.headers['X-Caracal-Delivery']).toBe('d1')
    expect(init.headers['X-Caracal-Signature']).toBe(signSinkPayload('nsk_test', init.headers['X-Caracal-Timestamp'], init.body))
    expect(calls.some((c) => c.sql.includes('SET delivered_at = now()'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('consecutive_failures = 0'))).toBe(true)
  })

  it('schedules a backoff retry on failure and abandons after the attempt ceiling', async () => {
    const secretCt = sealedSecret('nsk_test')
    const due = {
      id: 'd1',
      sink_id: 'sink-1',
      event_id: 'evt-1',
      event_type: 'step_up_issued',
      payload_json: {},
      attempts: 2,
      url: 'https://hooks.hooli.example/caracal',
      secret_ct: secretCt,
    }
    const failing = vi.fn(async () => ({ status: 503 })) as unknown as SinkFetch

    const retry = fakeDb({ due: [due] })
    const retried = await runNotificationDispatch(retry.db, failing)
    expect(retried.failed).toBe(1)
    const backoff = retry.calls.find((c) => c.sql.includes('SET available_at = now()'))
    expect(backoff?.sql).toContain("seconds')::interval")
    expect(backoff?.params?.[2]).toBe('sink responded 503')

    const final = fakeDb({ due: [{ ...due, attempts: 8 }] })
    await runNotificationDispatch(final.db, failing)
    const abandon = final.calls.find((c) => c.sql.includes('SET abandoned_at = now()'))
    expect(abandon).toBeDefined()
    expect(final.calls.some((c) => c.sql.includes('consecutive_failures = consecutive_failures + 1'))).toBe(true)
  })

  it('prunes settled deliveries past retention every pass', async () => {
    const { db, calls } = fakeDb({})

    await runNotificationDispatch(db, vi.fn())

    const cleanup = calls.find((c) => c.sql.includes('DELETE FROM notification_deliveries'))
    expect(cleanup?.sql).toContain('delivered_at IS NOT NULL OR abandoned_at IS NOT NULL')
    expect(cleanup?.params).toEqual(['7 days', 500])
  })
})
