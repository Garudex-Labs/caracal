// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// DCR auto-archive job: marks expired DCR apps as archived 24 hours after expires_at.

import type { FastifyBaseLogger } from 'fastify'
import type { DB } from '../db.js'

const GC_LOCK_KEY = '7163920485318472'

export async function runDCRGC(db: DB): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE applications
     SET archived_at = now()
     WHERE registration_method = 'dcr'
       AND expires_at IS NOT NULL
       AND expires_at < now() - INTERVAL '24 hours'
       AND archived_at IS NULL`,
  )
  return rowCount ?? 0
}

export async function runDCRGCIfLeader(db: DB): Promise<number | null> {
  const client = await db.connect()
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
      [GC_LOCK_KEY],
    )
    if (!rows[0]?.acquired) return null
    try {
      const { rowCount } = await client.query(
        `UPDATE applications
         SET archived_at = now()
         WHERE registration_method = 'dcr'
           AND expires_at IS NOT NULL
           AND expires_at < now() - INTERVAL '24 hours'
           AND archived_at IS NULL`,
      )
      return rowCount ?? 0
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [GC_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

export function startDCRGC(db: DB, log: FastifyBaseLogger, intervalMs = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    runDCRGCIfLeader(db).catch((err) => {
      log.error({ err }, 'DCR garbage collection failed')
    })
  }, intervalMs)
}
