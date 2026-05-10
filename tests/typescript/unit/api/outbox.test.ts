// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the OutboxDispatcher dispatch loop and backoff handling.

import { describe, it, expect, vi } from 'vitest'
import { enqueueOutbox, OutboxDispatcher } from '../../../../apps/api/src/outbox.js'

function makeLogger() {
  return vi.fn()
}

describe('enqueueOutbox', () => {
  it('inserts a row with serialized JSON payload', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const id = await enqueueOutbox(client, {
      streamName: 'stream.x',
      payload: { zone_id: 'z1', n: 1 },
      requestId: 'req-1',
    })
    expect(id).toEqual(expect.any(String))
    expect(client.query).toHaveBeenCalledOnce()
    const [, params] = client.query.mock.calls[0]
    expect(params[1]).toBe('stream.x')
    expect(JSON.parse(params[2])).toMatchObject({ zone_id: 'z1', n: 1 })
    expect(params[4]).toBe('req-1')
  })
})

describe('OutboxDispatcher', () => {
  function makeDeps(claimRows: Array<{ id: string; stream_name: string; payload_json: Record<string, unknown>; attempts: number }>) {
    const dbCalls: Array<{ sql: string; params?: unknown[] }> = []
    const db = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        dbCalls.push({ sql, params })
        if (sql.includes('UPDATE event_outbox SET\n         locked_until')) {
          return Promise.resolve({ rows: claimRows })
        }
        return Promise.resolve({ rows: [], rowCount: 1 })
      }),
    }
    const redis = { xadd: vi.fn() }
    return { db, redis, dbCalls }
  }

  it('dispatches a claimed row to redis and marks it dispatched', async () => {
    const { db, redis, dbCalls } = makeDeps([
      { id: 'r1', stream_name: 'stream.x', payload_json: { a: '1' }, attempts: 1 },
    ])
    redis.xadd.mockResolvedValue('0-1')
    const dispatcher = new OutboxDispatcher({ db: db as never, redis: redis as never, workerId: 'w', log: makeLogger() })
    await dispatcher.tick()
    expect(redis.xadd).toHaveBeenCalledWith('stream.x', '*', 'a', '1')
    expect(dbCalls.some((c) => c.sql.includes('SET dispatched_at = now()'))).toBe(true)
  })

  it('reschedules with backoff on dispatch failure below max attempts', async () => {
    const { db, redis, dbCalls } = makeDeps([
      { id: 'r1', stream_name: 'stream.x', payload_json: { a: '1' }, attempts: 2 },
    ])
    redis.xadd.mockRejectedValueOnce(new Error('boom'))
    const dispatcher = new OutboxDispatcher({ db: db as never, redis: redis as never, workerId: 'w', maxAttempts: 5, log: makeLogger() })
    await dispatcher.tick()
    const reschedule = dbCalls.find((c) => c.sql.includes("available_at = now() + ($2 || ' seconds')::interval"))
    expect(reschedule).toBeDefined()
  })

  it('parks the row past the deadline after max attempts exceeded', async () => {
    const { db, redis, dbCalls } = makeDeps([
      { id: 'r1', stream_name: 'stream.x', payload_json: { a: '1' }, attempts: 5 },
    ])
    redis.xadd.mockRejectedValueOnce(new Error('boom'))
    const dispatcher = new OutboxDispatcher({ db: db as never, redis: redis as never, workerId: 'w', maxAttempts: 5, log: makeLogger() })
    await dispatcher.tick()
    const park = dbCalls.find((c) => c.sql.includes("available_at = 'infinity'::timestamptz"))
    expect(park).toBeDefined()
  })
})
