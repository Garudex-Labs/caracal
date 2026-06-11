// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Service lease sweeper suspends service agent sessions with expired heartbeat leases.

import type { Pool } from 'pg'
import { cfg } from '../config.js'
import { spawnLockKey, suspendSubtree } from '../routes/agents.js'
import { type JobHandle, type JobLogger, makeIntervalJob } from './job.js'

const SWEEP_LOCK = 'coordinator:service_lease_sweep'

export const serviceLeaseSweeperStats = {
  runs: 0,
  failures: 0,
  suspended: 0,
}

export async function runServiceLeaseSweep(db: Pool): Promise<number> {
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
    const { rows: expired } = await client.query<{ id: string; zone_id: string }>(
      `SELECT id, zone_id FROM agent_sessions
       WHERE status = 'active'
         AND lifecycle = 'service'
         AND heartbeat_deadline_at IS NOT NULL
         AND heartbeat_deadline_at < now()
       ORDER BY heartbeat_deadline_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [cfg.sweeperBatchSize],
    )
    if (expired.length === 0) {
      await client.query('COMMIT')
      return 0
    }
    const byZone = new Map<string, string[]>()
    for (const row of expired) {
      const list = byZone.get(row.zone_id) ?? []
      list.push(row.id)
      byZone.set(row.zone_id, list)
    }
    let suspended = 0
    for (const [zoneId, ids] of byZone) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [spawnLockKey(zoneId)])
      suspended += await suspendSubtree(client, zoneId, ids, 'service_heartbeat_lost')
    }
    await client.query('COMMIT')
    return suspended
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export function startServiceLeaseSweeper(
  db: Pool,
  options: { intervalMs?: number; log?: JobLogger } = {},
): JobHandle {
  const intervalMs = options.intervalMs ?? cfg.serviceLeaseSweepIntervalMs
  return makeIntervalJob(
    () => {
      serviceLeaseSweeperStats.runs += 1
      return runServiceLeaseSweep(db).then((suspended) => {
        serviceLeaseSweeperStats.suspended += suspended
      })
    },
    intervalMs,
    (err) => {
      serviceLeaseSweeperStats.failures += 1
      options.log?.error({ err }, 'service_lease_sweep_failed')
    },
  )
}
