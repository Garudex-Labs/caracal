// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Sessions orphan reaper: archives sessions whose zone has been deleted.

import type { FastifyBaseLogger } from 'fastify'
import type { DB } from '../db.js'

const REAP_LOCK_KEY = '7163920485318481'

export async function runSessionsReap(db: DB): Promise<number> {
  const client = await db.connect()
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
      [REAP_LOCK_KEY],
    )
    if (!rows[0]?.acquired) return 0
    try {
      const { rowCount } = await client.query(
        `UPDATE sessions s
         SET status = 'expired'
         WHERE s.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM zones z WHERE z.id = s.zone_id)`,
      )
      return rowCount ?? 0
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [REAP_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

export function startSessionsReaper(
  db: DB,
  log: FastifyBaseLogger,
  intervalMs = 300_000,
): NodeJS.Timeout {
  return setInterval(() => {
    runSessionsReap(db).catch((err) => {
      log.error({ err }, 'sessions reaper failed')
    })
  }, intervalMs)
}
