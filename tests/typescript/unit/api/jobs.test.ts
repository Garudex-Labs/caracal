// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for API background jobs and advisory-lock guarded cleanup.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDCRGC, startDCRGC } from '../../../../apps/api/src/jobs/dcr-gc.js'
import { runSessionsReap, startSessionsReaper } from '../../../../apps/api/src/jobs/sessions-reaper.js'
import type { DB } from '../../../../apps/api/src/db.js'

type QueryResult = { rows?: Array<Record<string, unknown>>; rowCount?: number | null }
type QueryStep = QueryResult | Error

class FakeClient {
  readonly query = vi.fn(async (_sql: string, _args?: unknown[]) => {
    const step = this.steps.shift()
    if (step instanceof Error) throw step
    return { rows: [], rowCount: 0, ...step }
  })
  readonly release = vi.fn()

  constructor(private readonly steps: QueryStep[]) {}
}

function dbWithClient(client: FakeClient): DB {
  return {
    query: vi.fn(),
    connect: vi.fn(async () => client),
    end: vi.fn(),
  } as unknown as DB
}

function silentLog() {
  return { error: vi.fn() }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DCR garbage collection job', () => {
  it('archives expired DCR applications in deterministic batches', async () => {
    const client = new FakeClient([{ rows: [{ acquired: true }] }, { rowCount: 4 }, { rowCount: 1 }])
    const db = dbWithClient(client)

    await expect(runDCRGC(db)).resolves.toBe(4)
    expect(client.query).toHaveBeenCalledTimes(3)
    expect(client.query.mock.calls[1][1]).toEqual([500])
    expect(client.query.mock.calls[1][0]).toContain("registration_method = 'dcr'")
    expect(client.query.mock.calls[2][0]).toContain('pg_advisory_unlock')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('normalizes null row counts to zero', async () => {
    const client = new FakeClient([{ rows: [{ acquired: true }] }, { rowCount: null }, { rowCount: 1 }])
    await expect(runDCRGC(dbWithClient(client))).resolves.toBe(0)
  })

  it('returns zero and releases the connection when another worker owns the advisory lock', async () => {
    const client = new FakeClient([{ rows: [{ acquired: false }] }])

    await expect(runDCRGC(dbWithClient(client))).resolves.toBe(0)
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('skips interval work when another worker owns the advisory lock', async () => {
    vi.useFakeTimers()
    const client = new FakeClient([{ rows: [{ acquired: false }] }])
    const timer = startDCRGC(dbWithClient(client), silentLog() as never, 10)

    await vi.advanceTimersByTimeAsync(10)
    clearInterval(timer)

    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('unlocks and logs when a leader execution fails', async () => {
    vi.useFakeTimers()
    const log = silentLog()
    const err = new Error('postgres timeout')
    const client = new FakeClient([{ rows: [{ acquired: true }] }, err, { rowCount: 1 }])
    const timer = startDCRGC(dbWithClient(client), log as never, 10)

    await vi.advanceTimersByTimeAsync(10)
    clearInterval(timer)

    expect(client.query).toHaveBeenCalledTimes(3)
    expect(client.query.mock.calls[2][0]).toContain('pg_advisory_unlock')
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith({ err }, 'DCR garbage collection failed')
  })

  it('handles leader executions with null row counts', async () => {
    vi.useFakeTimers()
    const log = silentLog()
    const client = new FakeClient([{ rows: [{ acquired: true }] }, { rowCount: null }, { rowCount: 1 }])
    const timer = startDCRGC(dbWithClient(client), log as never, 10)

    await vi.advanceTimersByTimeAsync(10)
    clearInterval(timer)

    expect(client.query).toHaveBeenCalledTimes(3)
    expect(client.query.mock.calls[2][0]).toContain('pg_advisory_unlock')
    expect(log.error).not.toHaveBeenCalled()
  })
})

describe('sessions reaper job', () => {
  it('expires active sessions whose zones no longer exist', async () => {
    const client = new FakeClient([{ rows: [{ acquired: true }] }, { rowCount: 3 }, { rowCount: 1 }])
    const db = dbWithClient(client)

    await expect(runSessionsReap(db)).resolves.toBe(3)
    expect(client.query).toHaveBeenCalledTimes(3)
    expect(client.query.mock.calls[1][0]).toContain("s.status = 'active'")
    expect(client.query.mock.calls[1][1]).toEqual([500])
    expect(client.query.mock.calls[2][0]).toContain('pg_advisory_unlock')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('returns zero and releases the connection when lock acquisition fails', async () => {
    const client = new FakeClient([{ rows: [{ acquired: false }] }])

    await expect(runSessionsReap(dbWithClient(client))).resolves.toBe(0)
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('unlocks and releases when expiration query fails', async () => {
    const err = new Error('deadlock')
    const client = new FakeClient([{ rows: [{ acquired: true }] }, err, { rowCount: 1 }])

    await expect(runSessionsReap(dbWithClient(client))).rejects.toThrow(err)
    expect(client.query).toHaveBeenCalledTimes(3)
    expect(client.query.mock.calls[2][0]).toContain('pg_advisory_unlock')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('logs asynchronous timer failures without throwing from the interval', async () => {
    vi.useFakeTimers()
    const log = silentLog()
    const err = new Error('connect failed')
    const db = {
      query: vi.fn(),
      connect: vi.fn(async () => {
        throw err
      }),
      end: vi.fn(),
    } as unknown as DB
    const timer = startSessionsReaper(db, log as never, 10)

    await vi.advanceTimersByTimeAsync(10)
    clearInterval(timer)

    expect(log.error).toHaveBeenCalledWith({ err }, 'sessions reaper failed')
  })
})
