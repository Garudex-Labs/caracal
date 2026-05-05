// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// DCR auto-archive job: marks expired DCR apps as archived 24 hours after expires_at.

import type { DB } from '../db.js'

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

export function startDCRGC(db: DB, intervalMs = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    runDCRGC(db).catch((err) => {
      console.error('DCR garbage collection failed:', err)
    })
  }, intervalMs)
}
