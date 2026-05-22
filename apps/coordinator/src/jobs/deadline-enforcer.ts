// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Deadline enforcer: transitions invocations past deadline to failed (retryable)
// or timed_out based on remaining attempts.

import type { Pool } from 'pg'
import { cfg } from '../config.js'
import { enqueueMany, Topics, type OutboxItem } from '../outbox.js'
import { type JobHandle, type JobLogger, makeIntervalJob } from './job.js'

const SWEEP_LOCK = 'coordinator:invocation_deadline'

interface OverdueRow {
  id: string
  zone_id: string
  service_id: string
  status: 'failed' | 'timed_out'
}

export async function runDeadlineSweep(db: Pool): Promise<number> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: lock } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,
      [SWEEP_LOCK],
    )
    if (!lock[0]?.acquired) {
      await client.query('ROLLBACK')
      return 0
    }
    const { rows } = await client.query<OverdueRow>(
      `UPDATE agent_invocations AS i
       SET status = CASE WHEN i.attempts < i.max_attempts THEN 'failed' ELSE 'timed_out' END,
           started_at = CASE WHEN i.attempts < i.max_attempts THEN NULL ELSE i.started_at END,
           completed_at = CASE WHEN i.attempts < i.max_attempts THEN NULL ELSE now() END,
           error_json = COALESCE(i.error_json, '{}'::jsonb)
                        || jsonb_build_object('reason', 'deadline_exceeded'),
           updated_at = now()
       WHERE i.id IN (
         SELECT id FROM agent_invocations
         WHERE status = 'running'
           AND deadline_at IS NOT NULL
           AND deadline_at < now()
         ORDER BY deadline_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING i.id, i.zone_id, i.service_id, i.status`,
      [cfg.sweeperBatchSize],
    )
    if (rows.length > 0) {
      const items: OutboxItem[] = rows.map((row): OutboxItem => ({
        topic: Topics.InvocationsLifecycle,
        dedupeKey: `invocation.${row.status}:${row.id}`,
        payload: {
          event: `invocation.${row.status}`,
          zone_id: row.zone_id,
          service_id: row.service_id,
          invocation_id: row.id,
        },
      }))
      await enqueueMany(client, items)
    }
    await client.query('COMMIT')
    return rows.length
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export function startDeadlineEnforcer(
  db: Pool,
  options: { intervalMs?: number; log?: JobLogger } = {},
): JobHandle {
  const intervalMs = options.intervalMs ?? cfg.deadlineSweepIntervalMs
  return makeIntervalJob(
    () => runDeadlineSweep(db),
    intervalMs,
    (err) => options.log?.error({ err }, 'deadline_sweep_failed'),
  )
}
