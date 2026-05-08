// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Transactional outbox publisher for coordinator Redis Streams events.

import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { STREAM_SIG_FIELD, loadStreamsHmacKey, signStream } from '@caracalai/shared'
import { cfg } from '../config.js'

const streamHmacKey = loadStreamsHmacKey()
if (streamHmacKey === null && process.env.CARACAL_ENV && ['production', 'prod', 'staging'].includes(process.env.CARACAL_ENV)) {
  throw new Error('STREAMS_HMAC_KEY is required in production')
}

interface OutboxRow {
  id: string
  topic: string
  dedupe_key: string
  payload_json: Record<string, unknown>
  attempts: number
}

export interface OutboxPublisherOptions {
  intervalMs?: number
  batchSize?: number
  maxAttempts?: number
}

export interface OutboxPublisherHandle {
  stop: () => Promise<void>
}

export function startOutboxPublisher(
  db: Pool,
  redis: Redis,
  options: OutboxPublisherOptions = {},
): OutboxPublisherHandle {
  const intervalMs = options.intervalMs ?? cfg.outboxIntervalMs
  const batchSize = options.batchSize ?? cfg.outboxBatchSize
  const maxAttempts = options.maxAttempts ?? cfg.outboxMaxAttempts

  let running = false
  let stopped = false
  let pending: Promise<void> = Promise.resolve()

  const tick = (): void => {
    if (stopped || running) return
    running = true
    pending = publishBatch(db, redis, batchSize, maxAttempts)
      .catch((err) => {
        console.error('Outbox batch publish failed:', err)
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

export async function publishBatch(
  db: Pool,
  redis: Redis,
  batchSize: number,
  maxAttempts: number,
): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, topic, dedupe_key, payload_json, attempts
       FROM caracal_outbox
       WHERE producer = 'coordinator'
         AND status = 'pending'
         AND available_at <= now()
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    )
    const published: string[] = []
    const retried: string[] = []
    const dead: string[] = []
    for (const row of rows) {
      try {
        await redis.xadd(row.topic, '*', ...streamFields(row))
        published.push(row.id)
      } catch (err) {
        const nextAttempts = row.attempts + 1
        if (nextAttempts >= maxAttempts) dead.push(row.id)
        else retried.push(row.id)
        console.error(`Outbox publish failed for ${row.id} (attempt ${nextAttempts}):`, err)
      }
    }
    if (published.length > 0) {
      await client.query(
        `UPDATE caracal_outbox
         SET status = 'published', attempts = attempts + 1, published_at = now(), updated_at = now()
         WHERE id = ANY($1::text[])`,
        [published],
      )
    }
    if (retried.length > 0) {
      await client.query(
        `UPDATE caracal_outbox
         SET attempts = attempts + 1,
             available_at = now() + (LEAST(attempts + 1, 60) * interval '1 second'),
             updated_at = now()
         WHERE id = ANY($1::text[])`,
        [retried],
      )
    }
    if (dead.length > 0) {
      await client.query(
        `UPDATE caracal_outbox
         SET status = 'dead', attempts = attempts + 1, updated_at = now()
         WHERE id = ANY($1::text[])`,
        [dead],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

function streamFields(row: OutboxRow): string[] {
  const values: Record<string, string> = { outbox_id: row.id, dedupe_key: row.dedupe_key }
  for (const [key, value] of Object.entries(row.payload_json)) {
    if (key === 'outbox_id' || key === 'dedupe_key' || key === STREAM_SIG_FIELD) continue
    values[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (streamHmacKey) {
    values[STREAM_SIG_FIELD] = signStream(streamHmacKey, row.topic, values)
  }
  const out: string[] = []
  for (const [key, value] of Object.entries(values)) {
    out.push(key, value)
  }
  return out
}
