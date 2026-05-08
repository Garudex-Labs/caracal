// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Transactional outbox: durable enqueue inside the caller's transaction plus
// a cooperative dispatcher that drains rows to Redis streams with backoff.

import { v7 as uuidv7 } from 'uuid'
import { STREAM_SIG_FIELD, loadStreamsHmacKey, signStream } from '@caracalai/shared'
import type { DB } from './db.js'
import type { RedisClient } from './redis.js'

export type OutboxPayload = Record<string, string | number | boolean | null>

export interface OutboxRow {
  id: string
  stream_name: string
  payload_json: OutboxPayload
  attempts: number
}

interface ClientLike {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>
}

export interface EnqueueArgs {
  streamName: string
  payload: OutboxPayload
  requestId?: string | null
  availableAt?: Date
}

export async function enqueueOutbox(client: ClientLike, args: EnqueueArgs): Promise<string> {
  const id = uuidv7()
  await client.query(
    `INSERT INTO event_outbox (id, stream_name, payload_json, available_at, request_id)
     VALUES ($1, $2, $3::jsonb, COALESCE($4, now()), $5)`,
    [
      id,
      args.streamName,
      JSON.stringify(args.payload),
      args.availableAt ?? null,
      args.requestId ?? null,
    ],
  )
  return id
}

function flattenForXAdd(payload: OutboxPayload): string[] {
  const fields: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue
    fields.push(key, String(value))
  }
  return fields
}

function backoffSeconds(attempts: number): number {
  const cap = 60
  const base = Math.min(cap, 2 ** Math.min(attempts, 6))
  const jitter = Math.random() * 0.3 * base
  return Math.floor(base + jitter)
}

export interface DispatcherOptions {
  db: DB
  redis: RedisClient
  workerId: string
  batchSize?: number
  pollIntervalMs?: number
  lockDurationSec?: number
  maxAttempts?: number
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
}

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopping = false
  private readonly streamHmacKey: Buffer | null

  constructor(private readonly opts: DispatcherOptions) {
    this.streamHmacKey = loadStreamsHmacKey()
    if (this.streamHmacKey === null && process.env.CARACAL_ENV && ['production', 'prod', 'staging'].includes(process.env.CARACAL_ENV)) {
      throw new Error('STREAMS_HMAC_KEY is required in production')
    }
  }

  start(): void {
    if (this.timer) return
    const interval = this.opts.pollIntervalMs ?? 250
    this.timer = setInterval(() => {
      void this.tick()
    }, interval)
    this.opts.log('info', 'outbox dispatcher started', { workerId: this.opts.workerId, intervalMs: interval })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    this.opts.log('info', 'outbox dispatcher stopped', { workerId: this.opts.workerId })
  }

  async tick(): Promise<void> {
    if (this.running || this.stopping) return
    this.running = true
    try {
      const rows = await this.claimBatch()
      for (const row of rows) {
        await this.dispatch(row)
      }
    } catch (err) {
      this.opts.log('error', 'outbox dispatcher tick failed', {
        err: (err as Error).message,
      })
    } finally {
      this.running = false
    }
  }

  private async claimBatch(): Promise<OutboxRow[]> {
    const batchSize = this.opts.batchSize ?? 32
    const lockSec = this.opts.lockDurationSec ?? 30
    const { rows } = await this.opts.db.query<OutboxRow>(
      `UPDATE event_outbox SET
         locked_until = now() + ($1 || ' seconds')::interval,
         locked_by    = $2,
         attempts     = attempts + 1
       WHERE id IN (
         SELECT id FROM event_outbox
         WHERE dispatched_at IS NULL
           AND available_at  <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY available_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, stream_name, payload_json, attempts`,
      [String(lockSec), this.opts.workerId, batchSize],
    )
    return rows
  }

  private async dispatch(row: OutboxRow): Promise<void> {
    const signed: OutboxPayload = { ...row.payload_json }
    if (this.streamHmacKey) {
      signed[STREAM_SIG_FIELD] = signStream(this.streamHmacKey, row.stream_name, signed)
    }
    const fields = flattenForXAdd(signed)
    try {
      await this.opts.redis.xadd(row.stream_name, '*', ...fields)
      await this.opts.db.query(
        `UPDATE event_outbox
         SET dispatched_at = now(), locked_until = NULL, last_error = NULL
         WHERE id = $1`,
        [row.id],
      )
      this.opts.log('info', 'outbox event dispatched', {
        id: row.id, stream: row.stream_name, attempts: row.attempts,
      })
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      const maxAttempts = this.opts.maxAttempts ?? 100
      if (row.attempts >= maxAttempts) {
        this.opts.log('error', 'outbox event abandoned after max attempts', {
          id: row.id, stream: row.stream_name, attempts: row.attempts, err: message,
        })
        await this.opts.db.query(
          `UPDATE event_outbox
           SET locked_until = NULL,
               available_at = now() + INTERVAL '1 hour',
               last_error   = $2
           WHERE id = $1`,
          [row.id, message],
        )
        return
      }
      const delay = backoffSeconds(row.attempts)
      await this.opts.db.query(
        `UPDATE event_outbox
         SET locked_until = NULL,
             available_at = now() + ($2 || ' seconds')::interval,
             last_error   = $3
         WHERE id = $1`,
        [row.id, String(delay), message],
      )
      this.opts.log('warn', 'outbox event dispatch failed; will retry', {
        id: row.id, stream: row.stream_name, attempts: row.attempts, delaySec: delay, err: message,
      })
    }
  }
}
