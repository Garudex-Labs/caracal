// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Retention cleaner: expires old delegation edges and prunes terminal coordinator rows.

import type { Pool } from 'pg'
import { cfg } from '../config.js'
import type { JobLogger } from './outbox-publisher.js'

const CLEANUP_LOCK = 'coordinator:retention_cleanup'

export interface RetentionCleanupResult {
  expiredEdges: number
  deletedEdges: number
  deletedOutbox: number
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

    const { rowCount: expiredEdges } = await client.query(
      `UPDATE delegation_edges
       SET status = 'expired', updated_at = now()
       WHERE status = 'active' AND expires_at < now()`,
    )
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
      expiredEdges: expiredEdges ?? 0,
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

export interface RetentionCleanerHandle {
  stop: () => Promise<void>
}

export function startRetentionCleaner(
  db: Pool,
  options: { intervalMs?: number; log?: JobLogger } = {},
): RetentionCleanerHandle {
  const intervalMs = options.intervalMs ?? cfg.retentionCleanupIntervalMs
  const log = options.log
  let running = false
  let stopped = false
  let pending: Promise<unknown> = Promise.resolve()

  const tick = (): void => {
    if (stopped || running) return
    running = true
    retentionCleanerStats.runs += 1
    pending = runRetentionCleanup(db)
      .then((result) => {
        retentionCleanerStats.expired_edges += result.expiredEdges
        retentionCleanerStats.deleted_edges += result.deletedEdges
        retentionCleanerStats.deleted_outbox += result.deletedOutbox
      })
      .catch((err) => {
        retentionCleanerStats.failures += 1
        log?.error({ err }, 'retention_cleanup_failed')
      })
      .finally(() => {
        running = false
      })
  }

  const timer = setInterval(tick, intervalMs)
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await pending
    },
  }
}
