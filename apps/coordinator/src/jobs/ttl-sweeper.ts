// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TTL sweeper: terminates expired agents and their descendants transactionally.

import type { Pool } from 'pg'
import { cfg } from '../config.js'
import { spawnLockKey, terminateSubtree } from '../routes/agents.js'
import type { JobLogger } from './outbox-publisher.js'

const SWEEP_LOCK = 'coordinator:ttl_sweep'

export const ttlSweeperStats = {
  runs: 0,
  failures: 0,
  terminated: 0,
}

export async function runTTLSweep(db: Pool): Promise<number> {
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
       WHERE status IN ('active','suspended')
         AND ttl_seconds IS NOT NULL
         AND spawned_at + (ttl_seconds * interval '1 second') < now()
       ORDER BY id
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
    let terminated = 0
    for (const [zoneId, ids] of byZone) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [spawnLockKey(zoneId)])
      terminated += await terminateSubtree(client, zoneId, ids, 'ttl')
    }
    await client.query('COMMIT')
    return terminated
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export interface TTLSweeperHandle {
  stop: () => Promise<void>
}

export function startTTLSweeper(
  db: Pool,
  options: { intervalMs?: number; log?: JobLogger } = {},
): TTLSweeperHandle {
  const intervalMs = options.intervalMs ?? cfg.ttlSweepIntervalMs
  const log = options.log
  let running = false
  let stopped = false
  let pending: Promise<unknown> = Promise.resolve()

  const tick = (): void => {
    if (stopped || running) return
    running = true
    ttlSweeperStats.runs += 1
    pending = runTTLSweep(db)
      .then((terminated) => {
        ttlSweeperStats.terminated += terminated
      })
      .catch((err) => {
        ttlSweeperStats.failures += 1
        log?.error({ err }, 'ttl_sweep_failed')
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
