// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Retention cleaner: expires stale delegation edges and prunes terminal coordinator rows.

import type { Pool } from 'pg'
import { cfg } from '../config.js'
import { bumpDelegationEpoch } from '../delegationEpochs.js'
import { Topics, enqueueMany, type OutboxItem } from '../outbox.js'
import { type JobHandle, type JobLogger, makeIntervalJob } from './job.js'

const CLEANUP_LOCK = 'coordinator:retention_cleanup'

interface RetentionCleanupResult {
  expiredEdges: number
  deletedEdges: number
  deletedOutbox: number
}

interface ExpiredEdge {
  id: string
  zone_id: string
  source_session_id: string
  target_session_id: string
}

export const retentionCleanerStats = {
  runs: 0,
  failures: 0,
  expired_edges: 0,
  deleted_edges: 0,
  deleted_outbox: 0,
}

const emptyResult = (): RetentionCleanupResult => ({
  expiredEdges: 0,
  deletedEdges: 0,
  deletedOutbox: 0,
})

export async function runRetentionCleanup(db: Pool): Promise<RetentionCleanupResult> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: lock } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
      [CLEANUP_LOCK],
    )
    if (!lock[0]?.acquired) {
      await client.query('ROLLBACK')
      return emptyResult()
    }

    const { rows: expiredRows } = await client.query<ExpiredEdge>(
      `WITH expired AS (
         SELECT id
         FROM delegation_edges
         WHERE status = 'active' AND expires_at < now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE delegation_edges d
       SET status = 'expired', updated_at = now()
       FROM expired
       WHERE d.id = expired.id
       RETURNING d.id, d.zone_id, d.source_session_id, d.target_session_id`,
      [cfg.retentionCleanupBatchSize],
    )
    const outboxItems: OutboxItem[] = []
    const expiredByZone = new Map<string, ExpiredEdge[]>()
    for (const row of expiredRows) {
      const zoneRows = expiredByZone.get(row.zone_id)
      if (zoneRows) {
        zoneRows.push(row)
      } else {
        expiredByZone.set(row.zone_id, [row])
      }
    }
    for (const [zoneId, rows] of expiredByZone) {
      const epoch = await bumpDelegationEpoch(client, zoneId)
      outboxItems.push({
        topic: Topics.DelegationsInvalidate,
        dedupeKey: `edge_expire:${zoneId}:${epoch}`,
        payload: {
          event: 'edge_expire',
          zone_id: zoneId,
          affected_edges: rows.length,
          edge_ids: rows.map((row) => row.id),
          epoch,
        },
      })
    }
    await enqueueMany(client, outboxItems)
    const { rowCount: deletedEdges } = await client.query(
      `WITH old_edges AS (
         SELECT id
         FROM delegation_edges
         WHERE status IN ('revoked', 'expired')
           AND COALESCE(revoked_at, expires_at, updated_at, created_at)
               < now() - ($1::int * interval '1 day')
         ORDER BY COALESCE(revoked_at, expires_at, updated_at, created_at)
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM delegation_edges d
       USING old_edges
       WHERE d.id = old_edges.id`,
      [cfg.delegationRetentionDays, cfg.retentionCleanupBatchSize],
    )
    const { rowCount: deletedOutbox } = await client.query(
      `WITH old_rows AS (
         SELECT id
         FROM caracal_outbox
         WHERE producer = 'coordinator'
           AND status IN ('published', 'dead')
           AND updated_at < now() - ($1::int * interval '1 day')
         ORDER BY updated_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM caracal_outbox o
       USING old_rows
       WHERE o.id = old_rows.id`,
      [cfg.outboxRetentionDays, cfg.retentionCleanupBatchSize],
    )
    await client.query('COMMIT')
    return {
      expiredEdges: expiredRows.length,
      deletedEdges: deletedEdges ?? 0,
      deletedOutbox: deletedOutbox ?? 0,
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export function startRetentionCleaner(
  db: Pool,
  options: { intervalMs?: number; log?: JobLogger } = {},
): JobHandle {
  const intervalMs = options.intervalMs ?? cfg.retentionCleanupIntervalMs
  return makeIntervalJob(
    () => {
      retentionCleanerStats.runs += 1
      return runRetentionCleanup(db).then((result) => {
        retentionCleanerStats.expired_edges += result.expiredEdges
        retentionCleanerStats.deleted_edges += result.deletedEdges
        retentionCleanerStats.deleted_outbox += result.deletedOutbox
      })
    },
    intervalMs,
    (err) => {
      retentionCleanerStats.failures += 1
      options.log?.error({ err }, 'retention_cleanup_failed')
    },
  )
}
