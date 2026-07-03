// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Plan secrets reaper: deletes sealed Operator plan credentials past their TTL.

import type { FastifyBaseLogger } from 'fastify'
import { newTraceContext, runWithTrace } from '@caracalai/core'
import type { DB } from '../db.js'

const REAP_LOCK_KEY = '7163920485318483'
const REAP_BATCH_SIZE = 500

export async function runPlanSecretsReap(db: DB): Promise<number> {
  const client = await db.connect()
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
      [REAP_LOCK_KEY],
    )
    if (!rows[0]?.acquired) return 0
    try {
      const { rowCount } = await client.query(
        `WITH expired AS (
           SELECT conversation_id, plan_seq, step_id
           FROM operator_plan_secrets
           WHERE expires_at < now()
           ORDER BY expires_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM operator_plan_secrets s
         USING expired
         WHERE s.conversation_id = expired.conversation_id
           AND s.plan_seq = expired.plan_seq
           AND s.step_id = expired.step_id`,
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

export function startPlanSecretsReaper(
  db: DB,
  log: FastifyBaseLogger,
  intervalMs = 300_000,
): NodeJS.Timeout {
  return setInterval(() => {
    runWithTrace(newTraceContext(), () => runPlanSecretsReap(db)).catch((err) => {
      log.error({ err }, 'plan secrets reaper failed')
    })
  }, intervalMs)
}
