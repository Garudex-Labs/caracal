// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Authority-record reaper: expires active STS records past their TTL or whose zone has been deleted.

import type { FastifyBaseLogger } from 'fastify'
import { newTraceContext, runWithTrace } from '@caracalai/core'
import type { DB } from '../db.js'

const REAP_LOCK_KEY = '7163920485318481'
const REAP_BATCH_SIZE = 500

export async function runSessionsReap(db: DB): Promise<number> {
  const client = await db.connect()
  try {
    const { rows } = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock($1::bigint) AS acquired`, [REAP_LOCK_KEY])
    if (!rows[0]?.acquired) return 0
    try {
      const { rowCount } = await client.query(
        `WITH reapable_authority_records AS (
           SELECT s.id
            FROM authority_records s
           WHERE s.status = 'active'
             AND (s.expires_at < now()
               OR NOT EXISTS (SELECT 1 FROM zones z WHERE z.id = s.zone_id))
           ORDER BY s.created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE authority_records s
         SET status = 'expired'
         FROM reapable_authority_records
         WHERE s.id = reapable_authority_records.id`,
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

export function startSessionsReaper(db: DB, log: FastifyBaseLogger, intervalMs = 300_000): NodeJS.Timeout {
  return setInterval(() => {
    runWithTrace(newTraceContext(), () => runSessionsReap(db)).catch((err) => {
      log.error({ err }, 'sessions reaper failed')
    })
  }, intervalMs)
}
