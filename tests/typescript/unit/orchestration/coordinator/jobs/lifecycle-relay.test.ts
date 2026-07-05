// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Lifecycle relay unit tests covering HMAC verification, dedupe, drain, and acknowledgement.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'

const { LifecycleRelay, LIFECYCLE_STREAM, LIFECYCLE_GROUP } = await import('../../../../../../apps/coordinator/src/jobs/lifecycle-relay.js')

const HMAC_KEY = Buffer.alloc(32, 7)

function sign(values: Record<string, string>): string {
  const keys = Object.keys(values)
    .filter((k) => k !== '_sig')
    .sort()
  let canonical = `${LIFECYCLE_STREAM}\n`
  for (const k of keys) canonical += `${k}=${values[k]}\n`
  return createHmac('sha256', HMAC_KEY).update(canonical).digest('hex')
}

function toFields(values: Record<string, string>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(values)) out.push(k, v)
  return out
}

function mockRedis(overrides: Record<string, unknown> = {}) {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xautoclaim: vi.fn().mockResolvedValue(['0-0', []]),
    xack: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  }
}

function newRelay(redis: ReturnType<typeof mockRedis>, requireSignature = true) {
  return new LifecycleRelay(redis as never, {
    consumer: 'test-consumer',
    streamHmacKey: HMAC_KEY,
    requireSignature,
    dedupeTtlMs: 3_600_000,
    claimIdleMs: 60_000,
  })
}

describe('LifecycleRelay', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('acks a valid signed lifecycle event after deduping', async () => {
    const values = { outbox_id: 'ob-1', event: 'spawn', zone_id: 'zone-a' }
    const signed = { ...values, _sig: sign(values) }
    const redis = mockRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([[LIFECYCLE_STREAM, [['1-0', toFields(signed)]]]])
        .mockResolvedValue(null),
    })
    const relay = newRelay(redis)
    await relay.pollOnce()
    expect(redis.set).toHaveBeenCalledWith('coordinator:relay_dedupe:ob-1', '1', 'PX', 3_600_000, 'NX')
    expect(redis.xack).toHaveBeenCalledWith(LIFECYCLE_STREAM, LIFECYCLE_GROUP, '1-0')
  })

  it('drops and acks an event with an invalid signature', async () => {
    const values = { outbox_id: 'ob-2', event: 'spawn', zone_id: 'zone-a', _sig: 'deadbeef' }
    const redis = mockRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([[LIFECYCLE_STREAM, [['2-0', toFields(values)]]]])
        .mockResolvedValue(null),
    })
    const relay = newRelay(redis)
    await relay.pollOnce()
    expect(redis.set).not.toHaveBeenCalled()
    expect(redis.xack).toHaveBeenCalledWith(LIFECYCLE_STREAM, LIFECYCLE_GROUP, '2-0')
  })

  it('skips and acks a duplicate event', async () => {
    const values = { outbox_id: 'ob-3', event: 'spawn', zone_id: 'zone-a' }
    const signed = { ...values, _sig: sign(values) }
    const redis = mockRedis({
      set: vi.fn().mockResolvedValue(null),
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([[LIFECYCLE_STREAM, [['3-0', toFields(signed)]]]])
        .mockResolvedValue(null),
    })
    const relay = newRelay(redis)
    await relay.pollOnce()
    expect(redis.xack).toHaveBeenCalledWith(LIFECYCLE_STREAM, LIFECYCLE_GROUP, '3-0')
  })

  it('drains pending entries via xautoclaim before reading new ones', async () => {
    const values = { outbox_id: 'ob-4', event: 'terminate', zone_id: 'zone-b' }
    const signed = { ...values, _sig: sign(values) }
    const redis = mockRedis({
      xautoclaim: vi.fn().mockResolvedValueOnce(['0-0', [['4-0', toFields(signed)]]]),
    })
    const relay = newRelay(redis)
    await relay.pollOnce()
    expect(redis.xack).toHaveBeenCalledWith(LIFECYCLE_STREAM, LIFECYCLE_GROUP, '4-0')
  })

  it('tolerates BUSYGROUP when ensuring the consumer group', async () => {
    const redis = mockRedis({
      xgroup: vi.fn().mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists')),
    })
    const relay = newRelay(redis)
    await expect(relay.ensureGroup()).resolves.toBeUndefined()
  })

  it('accepts unsigned events in dev when no key is configured', async () => {
    const values = { outbox_id: 'ob-5', event: 'spawn', zone_id: 'zone-a' }
    const redis = mockRedis({
      xreadgroup: vi
        .fn()
        .mockResolvedValueOnce([[LIFECYCLE_STREAM, [['5-0', toFields(values)]]]])
        .mockResolvedValue(null),
    })
    const relay = new LifecycleRelay(redis as never, {
      consumer: 'test-consumer',
      streamHmacKey: null,
      requireSignature: false,
      dedupeTtlMs: 3_600_000,
      claimIdleMs: 60_000,
    })
    await relay.pollOnce()
    expect(redis.xack).toHaveBeenCalledWith(LIFECYCLE_STREAM, LIFECYCLE_GROUP, '5-0')
  })
})

describe('startLifecycleRelay', () => {
  it('consumes on a dedicated duplicated connection and closes it on stop', async () => {
    const { startLifecycleRelay } = await import('../../../../../../apps/coordinator/src/jobs/lifecycle-relay.js')
    const consumer = { ...mockRedis(), quit: vi.fn().mockResolvedValue('OK'), disconnect: vi.fn() }
    const base = { ...mockRedis(), duplicate: vi.fn(() => consumer) }

    const job = startLifecycleRelay(base as never)
    expect(base.duplicate).toHaveBeenCalledOnce()
    await job.stop()

    // Blocking reads must park only the duplicated connection: the shared client is never
    // read from, and the duplicate is released with the job.
    expect(base.xreadgroup).not.toHaveBeenCalled()
    expect(consumer.quit).toHaveBeenCalledOnce()
  })
})
