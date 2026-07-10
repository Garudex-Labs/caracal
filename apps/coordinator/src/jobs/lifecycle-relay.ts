// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Lifecycle relay job: observes caracal.agents.lifecycle delivery with HMAC origin verification and dedupe.

import { timingSafeEqual } from 'node:crypto'
import type { Redis } from 'ioredis'
import { STREAM_SIG_FIELD, type StreamValue, signStream } from '@caracalai/core'
import { isPublished, loadStreamsHmacKey } from '@caracalai/server-core'
import { type JobHandle, makeIntervalJob } from './job.js'
import { closeRedis } from '../redis.js'
import { cfg } from '../config.js'

export const LIFECYCLE_STREAM = 'caracal.agents.lifecycle'
export const LIFECYCLE_GROUP = 'coordinator-relay'
const DEDUPE_KEY_PREFIX = 'coordinator:relay_dedupe:'

export interface RelayLogger {
  debug: (obj: object, msg?: string) => void
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export interface LifecycleRelayClient {
  xgroup: Redis['xgroup']
  xreadgroup: Redis['xreadgroup']
  xautoclaim: Redis['xautoclaim']
  xack: Redis['xack']
  set: Redis['set']
}

export interface LifecycleRelayOptions {
  consumer: string
  streamHmacKey: Buffer | null
  requireSignature: boolean
  dedupeTtlMs: number
  claimIdleMs: number
  batchSize?: number
  blockMs?: number
  log?: RelayLogger
}

export const relayStats = {
  observed: 0,
  duplicates: 0,
  invalidSignature: 0,
  failures: 0,
}

export class LifecycleRelay {
  private readonly batchSize: number
  private readonly blockMs: number
  private groupReady = false

  constructor(
    private readonly redis: LifecycleRelayClient,
    private readonly opts: LifecycleRelayOptions,
  ) {
    this.batchSize = opts.batchSize ?? 50
    this.blockMs = opts.blockMs ?? 5_000
    if (opts.requireSignature && !opts.streamHmacKey) {
      throw new Error('streamHmacKey is required when requireSignature is true')
    }
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', LIFECYCLE_STREAM, LIFECYCLE_GROUP, '$', 'MKSTREAM')
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err
    }
    this.groupReady = true
  }

  async pollOnce(): Promise<number> {
    if (!this.groupReady) await this.ensureGroup()
    let handled = await this.drainPending()
    const rows = (await this.redis.xreadgroup(
      'GROUP',
      LIFECYCLE_GROUP,
      this.opts.consumer,
      'COUNT',
      this.batchSize,
      'BLOCK',
      this.blockMs,
      'STREAMS',
      LIFECYCLE_STREAM,
      '>',
    )) as Array<[string, Array<[string, string[]]>]> | null
    for (const [, messages] of rows ?? []) {
      for (const [id, fields] of messages) {
        await this.processMessage(id, fields)
        handled++
      }
    }
    return handled
  }

  private async drainPending(): Promise<number> {
    let handled = 0
    let start = '0-0'
    for (;;) {
      const [next, messages] = (await this.redis.xautoclaim(
        LIFECYCLE_STREAM,
        LIFECYCLE_GROUP,
        this.opts.consumer,
        this.opts.claimIdleMs,
        start,
        'COUNT',
        this.batchSize,
      )) as [string, Array<[string, string[]]>]
      for (const [id, fields] of messages) {
        await this.processMessage(id, fields)
        handled++
      }
      if (messages.length === 0 || next === '' || next === '0-0') return handled
      start = next
    }
  }

  private async processMessage(id: string, fields: string[]): Promise<void> {
    const values = fieldsToValues(fields)
    if (!this.verify(values)) {
      relayStats.invalidSignature++
      this.opts.log?.warn({ id }, 'dropping lifecycle event with invalid origin signature')
      await this.ack(id)
      return
    }
    if (await this.duplicate(values)) {
      relayStats.duplicates++
      this.opts.log?.debug({ id }, 'skipping duplicate lifecycle event')
      await this.ack(id)
      return
    }
    relayStats.observed++
    this.opts.log?.info({ id, event: stringVal(values.event), zone_id: stringVal(values.zone_id) }, 'lifecycle event')
    await this.ack(id)
  }

  private verify(values: Record<string, StreamValue>): boolean {
    if (!this.opts.requireSignature && !this.opts.streamHmacKey) return true
    const got = values[STREAM_SIG_FIELD]
    if (typeof got !== 'string' || !this.opts.streamHmacKey) return false
    const want = signStream(this.opts.streamHmacKey, LIFECYCLE_STREAM, values)
    const gotBytes = Buffer.from(got, 'hex')
    const wantBytes = Buffer.from(want, 'hex')
    return gotBytes.length === wantBytes.length && timingSafeEqual(gotBytes, wantBytes)
  }

  private async duplicate(values: Record<string, StreamValue>): Promise<boolean> {
    const id = values.outbox_id
    if (typeof id !== 'string' || id === '') return false
    try {
      const res = await this.redis.set(DEDUPE_KEY_PREFIX + id, '1', 'PX', this.opts.dedupeTtlMs, 'NX')
      return res !== 'OK'
    } catch (err) {
      this.opts.log?.warn({ err, id }, 'dedupe setnx failed; proceeding')
      return false
    }
  }

  private async ack(id: string): Promise<void> {
    await this.redis.xack(LIFECYCLE_STREAM, LIFECYCLE_GROUP, id)
  }
}

function fieldsToValues(fields: string[]): Record<string, StreamValue> {
  const values: Record<string, StreamValue> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) {
    values[fields[i]!] = fields[i + 1]!
  }
  return values
}

function stringVal(v: StreamValue): string {
  return typeof v === 'string' ? v : ''
}

export function startLifecycleRelay(redis: Redis, options: { log?: RelayLogger } = {}): JobHandle {
  const streamHmacKey = loadStreamsHmacKey()
  const requireSignature = isPublished()
  if (requireSignature && !streamHmacKey) {
    throw new Error('STREAMS_HMAC_KEY is required when CARACAL_MODE=rc or CARACAL_MODE=stable')
  }
  if (!streamHmacKey) {
    options.log?.warn({}, 'STREAMS_HMAC_KEY not set; lifecycle events will not be origin-verified')
  }
  // The relay parks its connection in XREADGROUP BLOCK for up to blockMs, and ioredis
  // serializes commands per connection, so the relay must never share the app's client: a
  // parked read would queue every readiness probe and rate-limit INCR behind it for up to a
  // full block. The relay therefore consumes on its own duplicated connection, closed with
  // the job on stop.
  const consumer = redis.duplicate()
  const relay = new LifecycleRelay(consumer, {
    consumer: cfg.relayConsumerName,
    streamHmacKey,
    requireSignature,
    dedupeTtlMs: cfg.dedupeWindowSec * 1000,
    claimIdleMs: cfg.relayClaimIdleMs,
    log: options.log,
  })
  const job = makeIntervalJob(
    () => relay.pollOnce(),
    cfg.relayIntervalMs,
    (err) => {
      relayStats.failures++
      options.log?.error({ err }, 'lifecycle_relay_failed')
    },
  )
  return {
    stop: async () => {
      await job.stop()
      await closeRedis(consumer)
    },
  }
}
