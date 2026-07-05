// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Deadline enforcer unit tests covering retry-aware transitions.

import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import { runDeadlineSweep, startDeadlineEnforcer } from '../../../../../../apps/coordinator/src/jobs/deadline-enforcer.js'

function clientWith(rows: unknown[], acquired = true) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ acquired }] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
}

describe('runDeadlineSweep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips when another node holds the lock', async () => {
    const client = clientWith([], false)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runDeadlineSweep(db as never)).resolves.toBe(0)
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('emits matching outbox events for retry and Console transitions', async () => {
    const rows = [
      { id: 'inv-1', zone_id: 'z1', service_id: 'svc-1', status: 'failed' },
      { id: 'inv-2', zone_id: 'z1', service_id: 'svc-2', status: 'timed_out' },
    ]
    const client = clientWith(rows)
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    const count = await runDeadlineSweep(db as never)
    expect(count).toBe(2)

    const updateCall = client.query.mock.calls.find(
      (call) => String(call[0]).includes("'failed'") && String(call[0]).includes("'timed_out'"),
    )
    expect(updateCall).toBeDefined()

    const outboxInserts = client.query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO caracal_outbox'))
    expect(outboxInserts.length).toBe(1)
    const params = (outboxInserts[0]?.[1] ?? []) as unknown[]
    expect(params).toEqual(expect.arrayContaining(['invocation.failed:inv-1', 'invocation.timed_out:inv-2']))
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rolls back and releases when the transition query fails', async () => {
    const err = new Error('deadlock')
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runDeadlineSweep(db as never)).rejects.toThrow(err)

    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('logs interval failures from the start helper', async () => {
    vi.useFakeTimers()
    const err = new Error('postgres unavailable')
    const log = { error: vi.fn() }
    const db = { connect: vi.fn().mockRejectedValue(err) }
    const handle = startDeadlineEnforcer(db as never, { intervalMs: 10, log })

    await vi.advanceTimersByTimeAsync(10)
    await handle.stop()

    expect(log.error).toHaveBeenCalledWith({ err }, 'deadline_sweep_failed')
  })
})
