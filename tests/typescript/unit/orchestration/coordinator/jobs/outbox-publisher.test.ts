// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Outbox publisher unit tests covering Redis stream delivery and retry state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'

const { publishBatch, startOutboxPublisher } = await import('../../../../../../apps/coordinator/src/jobs/outbox-publisher.js')

function mockClient(rows: unknown[]) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }),
    release: vi.fn(),
  }
}

describe('publishBatch', () => {
  it('prepends outbox_id and dedupe_key on every published record', async () => {
    const client = mockClient([
      {
        id: 'outbox-1',
        topic: 'caracal.invocations.lifecycle',
        dedupe_key: 'invocation.created:inv-1',
        payload_json: { event: 'created', count: 1 },
        attempts: 0,
      },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    const redis = { xadd: vi.fn().mockResolvedValueOnce('stream-id-1') }

    await publishBatch(db as never, redis as never, 50, 10)

    expect(redis.xadd).toHaveBeenCalledWith(
      'caracal.invocations.lifecycle',
      'MAXLEN',
      '~',
      '12345',
      '*',
      'outbox_id',
      'outbox-1',
      'dedupe_key',
      'invocation.created:inv-1',
      'event',
      'created',
      'count',
      '1',
    )
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'published'"), [['outbox-1']])
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('marks failed rows for retry and serializes nested payloads', async () => {
    const client = mockClient([
      {
        id: 'outbox-1',
        topic: 'caracal.agents.lifecycle',
        dedupe_key: 'spawn:agent-1',
        payload_json: { nested: { id: 'inv-1' } },
        attempts: 0,
      },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    const redis = { xadd: vi.fn().mockRejectedValueOnce(new Error('redis down')) }

    await publishBatch(db as never, redis as never, 50, 10)

    expect(redis.xadd).toHaveBeenCalledWith(
      'caracal.agents.lifecycle',
      'MAXLEN',
      '~',
      '12345',
      '*',
      'outbox_id',
      'outbox-1',
      'dedupe_key',
      'spawn:agent-1',
      'nested',
      '{"id":"inv-1"}',
    )
    const retryUpdate = client.query.mock.calls.find((call) => String(call[0]).includes('available_at = now()'))
    expect(retryUpdate?.[1]).toEqual([['outbox-1']])
  })

  it('promotes rows to dead after max attempts', async () => {
    const client = mockClient([
      { id: 'outbox-1', topic: 'caracal.agents.lifecycle', dedupe_key: 'spawn:agent-1', payload_json: {}, attempts: 9 },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    const redis = { xadd: vi.fn().mockRejectedValueOnce(new Error('boom')) }

    await publishBatch(db as never, redis as never, 50, 10)

    const deadUpdate = client.query.mock.calls.find((call) => String(call[0]).includes("status = 'dead'"))
    expect(deadUpdate?.[1]).toEqual([['outbox-1']])
  })

  it('rolls back and releases when the outbox select fails', async () => {
    const err = new Error('select failed')
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(err).mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    const redis = { xadd: vi.fn() }

    await expect(publishBatch(db as never, redis as never, 50, 10)).rejects.toThrow(err)

    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })
})

describe('startOutboxPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a handle whose stop awaits the in-flight tick', async () => {
    const client = mockClient([])
    const db = { connect: vi.fn().mockResolvedValue(client) }
    const redis = { xadd: vi.fn() }

    const handle = startOutboxPublisher(db as never, redis as never, { intervalMs: 100, batchSize: 50, maxAttempts: 10 })
    await vi.advanceTimersByTimeAsync(100)
    await handle.stop()
    expect(client.release).toHaveBeenCalled()
  })

  it('logs interval failures through the start helper', async () => {
    const err = new Error('connect failed')
    const log = { error: vi.fn() }
    const db = { connect: vi.fn().mockRejectedValue(err) }
    const redis = { xadd: vi.fn() }

    const handle = startOutboxPublisher(db as never, redis as never, { intervalMs: 10, log })
    await vi.advanceTimersByTimeAsync(10)
    await handle.stop()

    expect(log.error).toHaveBeenCalledWith({ err }, 'outbox_batch_publish_failed')
  })
})
