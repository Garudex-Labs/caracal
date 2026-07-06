// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Notification dispatcher: fans out approval audit events to zone webhook sinks with signed, retried deliveries.

import { createHmac } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { v7 as uuidv7 } from 'uuid'
import { newTraceContext, runWithTrace } from '@caracalai/core'
import { loadZoneKek, open } from '@caracalai/server-core'
import type { DB } from '../db.js'
import { withTransaction } from '../db.js'

const DISPATCH_LOCK_KEY = '7163920485318484'
const FANOUT_SINK_BATCH = 200
const FANOUT_EVENT_BATCH = 100
const DELIVER_BATCH = 25
const DELIVER_TIMEOUT_MS = 10_000
const MAX_DELIVERY_ATTEMPTS = 8
const SETTLED_RETENTION = '7 days'
const CLEANUP_BATCH = 500
const SEAL_NONCE_BYTES = 12

export interface SinkFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }): Promise<{ status: number }>
}

interface SinkRow {
  id: string
  zone_id: string
  event_types: string[]
  cursor_chain_seq: string
}

interface AuditEventRow {
  id: string
  zone_id: string
  event_type: string
  decision: string | null
  metadata_json: Record<string, unknown> | null
  occurred_at: string | Date
  chain_seq: string
}

interface DeliveryRow {
  id: string
  sink_id: string
  event_id: string
  event_type: string
  payload_json: Record<string, unknown>
  attempts: number
  url: string
  secret_ct: Buffer
}

// The wire payload a sink receives: the authorization facts of one approval lifecycle
// event, exactly as the zone audit stream recorded them. The audit stream already defines
// what is safe to share, so the payload carries its metadata verbatim and adds nothing.
export function sinkPayload(event: AuditEventRow): Record<string, unknown> {
  const occurred = event.occurred_at instanceof Date ? event.occurred_at.toISOString() : new Date(event.occurred_at).toISOString()
  return {
    id: event.id,
    type: event.event_type,
    zone_id: event.zone_id,
    decision: event.decision,
    occurred_at: occurred,
    data: event.metadata_json ?? {},
  }
}

// HMAC-SHA256 over `<timestamp>.<body>`, hex-encoded and versioned. Binding the timestamp
// into the signed material lets a receiver reject replayed deliveries by age without
// parsing the body first.
export function signSinkPayload(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

// Exponential backoff for a failed delivery: 30s doubling to a 15-minute ceiling, with
// jitter so a sink outage does not synchronize every retry into one thundering batch.
export function sinkBackoffSeconds(attempts: number): number {
  const base = Math.min(900, 30 * 2 ** Math.max(0, attempts - 1))
  return Math.floor(base + Math.random() * 0.3 * base)
}

function openSecret(packed: Buffer): string {
  const plaintext = open(loadZoneKek(), {
    nonce: packed.subarray(0, SEAL_NONCE_BYTES),
    ciphertext: packed.subarray(SEAL_NONCE_BYTES),
  })
  try {
    return plaintext.toString('utf8')
  } finally {
    plaintext.fill(0)
  }
}

// Advances one sink through the zone audit stream: matching events become pending
// deliveries and the cursor moves in the same transaction, so an event is enqueued
// exactly once per sink. When the batch drains to the stream head the cursor jumps to
// the head sequence, so a zone busy with unrelated events never forces a rescan.
async function fanOutSink(db: DB, sink: SinkRow): Promise<number> {
  const { rows: events } = await db.query<AuditEventRow>(
    `SELECT id, zone_id, event_type, decision, metadata_json, occurred_at, chain_seq
     FROM audit_events
     WHERE zone_id = $1 AND chain_seq > $2 AND event_type = ANY($3)
     ORDER BY chain_seq ASC LIMIT $4`,
    [sink.zone_id, sink.cursor_chain_seq, sink.event_types, FANOUT_EVENT_BATCH],
  )
  let nextCursor: string
  if (events.length === FANOUT_EVENT_BATCH) {
    nextCursor = events[events.length - 1].chain_seq
  } else {
    const { rows: head } = await db.query<{ seq: string }>(
      `SELECT COALESCE(MAX(chain_seq), 0)::text AS seq FROM audit_events WHERE zone_id = $1`,
      [sink.zone_id],
    )
    nextCursor = head[0]?.seq ?? sink.cursor_chain_seq
  }
  if (events.length === 0 && nextCursor === sink.cursor_chain_seq) return 0
  await withTransaction(db, async (client) => {
    for (const event of events) {
      await client.query(
        `INSERT INTO notification_deliveries (id, sink_id, zone_id, event_id, event_type, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (sink_id, event_id) DO NOTHING`,
        [uuidv7(), sink.id, sink.zone_id, event.id, event.event_type, JSON.stringify(sinkPayload(event))],
      )
    }
    await client.query(
      `UPDATE notification_sinks SET cursor_chain_seq = GREATEST(cursor_chain_seq, $2) WHERE id = $1`,
      [sink.id, nextCursor],
    )
  })
  return events.length
}

async function deliverOne(db: DB, delivery: DeliveryRow, fetchImpl: SinkFetch): Promise<boolean> {
  const body = JSON.stringify(delivery.payload_json)
  const timestamp = String(Math.floor(Date.now() / 1000))
  let status = 0
  let failure: string | null = null
  try {
    const secret = openSecret(delivery.secret_ct)
    const res = await fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Caracal-Event': delivery.event_type,
        'X-Caracal-Delivery': delivery.id,
        'X-Caracal-Sink': delivery.sink_id,
        'X-Caracal-Timestamp': timestamp,
        'X-Caracal-Signature': signSinkPayload(secret, timestamp, body),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
    })
    status = res.status
    if (status < 200 || status >= 300) failure = `sink responded ${status}`
  } catch (err) {
    failure = (err as Error).message ?? String(err)
  }
  if (!failure) {
    await db.query(
      `UPDATE notification_deliveries
       SET delivered_at = now(), response_status = $2, last_error = NULL
       WHERE id = $1`,
      [delivery.id, status],
    )
    await db.query(
      `UPDATE notification_sinks
       SET last_success_at = now(), consecutive_failures = 0, last_error = NULL
       WHERE id = $1`,
      [delivery.sink_id],
    )
    return true
  }
  const abandoned = delivery.attempts >= MAX_DELIVERY_ATTEMPTS
  await db.query(
    abandoned
      ? `UPDATE notification_deliveries
         SET abandoned_at = now(), response_status = NULLIF($2, 0), last_error = $3
         WHERE id = $1`
      : `UPDATE notification_deliveries
         SET available_at = now() + ($4 || ' seconds')::interval, response_status = NULLIF($2, 0), last_error = $3
         WHERE id = $1`,
    abandoned
      ? [delivery.id, status, failure]
      : [delivery.id, status, failure, String(sinkBackoffSeconds(delivery.attempts))],
  )
  await db.query(
    `UPDATE notification_sinks
     SET last_failure_at = now(), consecutive_failures = consecutive_failures + 1, last_error = $2
     WHERE id = $1`,
    [delivery.sink_id, failure],
  )
  return false
}

// One dispatch pass: enqueue new deliveries from the audit stream, post everything due,
// and prune settled records past retention. Replicas coordinate through an advisory
// lock; the claim itself also skips locked rows, so a lock lapse can never double-send.
export async function runNotificationDispatch(db: DB, fetchImpl: SinkFetch = fetch as unknown as SinkFetch): Promise<{ enqueued: number; delivered: number; failed: number }> {
  const client = await db.connect()
  const totals = { enqueued: 0, delivered: 0, failed: 0 }
  try {
    const { rows } = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock($1::bigint) AS acquired`, [DISPATCH_LOCK_KEY])
    if (!rows[0]?.acquired) return totals
    try {
      const { rows: sinks } = await db.query<SinkRow>(
        `SELECT id, zone_id, event_types, cursor_chain_seq::text AS cursor_chain_seq
         FROM notification_sinks WHERE active ORDER BY created_at LIMIT $1`,
        [FANOUT_SINK_BATCH],
      )
      for (const sink of sinks) {
        totals.enqueued += await fanOutSink(db, sink)
      }
      const { rows: due } = await db.query<DeliveryRow>(
        `UPDATE notification_deliveries d
         SET attempts = d.attempts + 1
         FROM notification_sinks s
         WHERE s.id = d.sink_id AND d.id IN (
           SELECT d2.id FROM notification_deliveries d2
           JOIN notification_sinks s2 ON s2.id = d2.sink_id
           WHERE d2.delivered_at IS NULL AND d2.abandoned_at IS NULL
             AND d2.available_at <= now() AND s2.active
           ORDER BY d2.available_at
           LIMIT $1
           FOR UPDATE OF d2 SKIP LOCKED
         )
         RETURNING d.id, d.sink_id, d.event_id, d.event_type, d.payload_json, d.attempts, s.url, s.secret_ct`,
        [DELIVER_BATCH],
      )
      for (const delivery of due) {
        if (await deliverOne(db, delivery, fetchImpl)) totals.delivered += 1
        else totals.failed += 1
      }
      await db.query(
        `DELETE FROM notification_deliveries WHERE id IN (
           SELECT id FROM notification_deliveries
           WHERE (delivered_at IS NOT NULL OR abandoned_at IS NOT NULL)
             AND created_at < now() - $1::interval
           LIMIT $2
         )`,
        [SETTLED_RETENTION, CLEANUP_BATCH],
      )
      return totals
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [DISPATCH_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

export function startNotificationDispatcher(db: DB, log: FastifyBaseLogger, intervalMs = 5_000): NodeJS.Timeout {
  return setInterval(() => {
    runWithTrace(newTraceContext(), () => runNotificationDispatch(db)).catch((err) => {
      log.error({ err }, 'notification dispatcher failed')
    })
  }, intervalMs)
}
