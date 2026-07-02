// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Message run deadline reaper: forces expired chat runs to the timeout terminal state.

import type { FastifyBaseLogger } from 'fastify'
import type { DB } from '../db.js'

const REAP_LOCK_KEY = '7163920485318482'
const REAP_BATCH_SIZE = 500

// Any non-terminal run whose deadline has passed is force-settled: a timeout event is
// appended to the ledger and the run row is moved to the timeout terminal state. Every
// non-terminal state may transition to timeout, so no run can outlive its strict limit.
export async function runMessageRunsReap(db: DB): Promise<number> {
  const client = await db.connect()
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
      [REAP_LOCK_KEY],
    )
    if (!rows[0]?.acquired) return 0
    try {
      const { rowCount } = await client.query(
        `WITH expired AS (
           SELECT id, zone_id, conversation_id, last_event_seq
           FROM operator_message_runs
           WHERE state <> ALL (ARRAY['completed', 'cancelled', 'failed', 'timeout'])
             AND deadline_at IS NOT NULL
             AND deadline_at < now()
           ORDER BY deadline_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         ),
         events AS (
           INSERT INTO operator_message_run_events
             (id, run_id, zone_id, conversation_id, event_seq, state, reason)
           SELECT gen_random_uuid()::text, e.id, e.zone_id, e.conversation_id,
                  e.last_event_seq + 1, 'timeout', 'deadline_exceeded'
           FROM expired e
           RETURNING run_id, event_seq
         )
         UPDATE operator_message_runs r
         SET state = 'timeout',
             reason = COALESCE(r.reason, 'deadline_exceeded'),
             completed_at = COALESCE(r.completed_at, now()),
             last_event_seq = ev.event_seq,
             updated_at = now()
         FROM events ev
         WHERE r.id = ev.run_id`,
        [REAP_BATCH_SIZE],
      )
      return rowCount ?? 0
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [REAP_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

export function startMessageRunsReaper(
  db: DB,
  log: FastifyBaseLogger,
  intervalMs = 30_000,
): NodeJS.Timeout {
  return setInterval(() => {
    runMessageRunsReap(db).catch((err) => {
      log.error({ err }, 'message runs reaper failed')
    })
  }, intervalMs)
}
