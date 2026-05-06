// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zone existence guard: confirms a zone id refers to an active (non-archived) row.

import type { DB } from './db.js'

export async function zoneExists(db: DB, zoneId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM zones WHERE id = $1 AND archived_at IS NULL LIMIT 1`,
    [zoneId],
  )
  return rows.length > 0
}
