// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Service lease sweeper unit tests covering heartbeat-loss suspension and revocation.

import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/test-utils/typescript/coordinatorEnv.js'
import {
  runServiceLeaseSweep,
  serviceLeaseSweeperStats,
  startServiceLeaseSweeper,
} from '../../../../../../apps/coordinator/src/jobs/service-lease-sweeper.js'

interface Step {
  match?: RegExp
  rows?: unknown[]
}

function clientFromSteps(steps: Step[]) {
  const calls: Array<[string, unknown[] | undefined]> = []
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      for (const step of steps) {
        if (step.match && step.match.test(sql)) {
          return { rows: step.rows ?? [] }
        }
      }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
}

describe('runServiceLeaseSweep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips work when the advisory lock is held by another node', async () => {
    const client = clientFromSteps([{ match: /pg_try_advisory_xact_lock/, rows: [{ acquired: false }] }])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runServiceLeaseSweep(db as never)).resolves.toBe(0)
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('suspends expired service sessions and emits revocation events', async () => {
    const expired = [
      { id: 'agent-1', zone_id: 'z1' },
      { id: 'agent-2', zone_id: 'z1' },
    ]
    const suspended = [
      { id: 'agent-1', subject_authority_record_id: 'sid-1', parent_id: null },
      { id: 'agent-2', subject_authority_record_id: 'sid-2', parent_id: 'agent-1' },
    ]
    const client = clientFromSteps([])
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      client.calls.push([sql, params])
      if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/FROM sessions[\s\S]*heartbeat_deadline_at < now\(\)[\s\S]*LIMIT/.test(sql)) {
        return { rows: expired }
      }
      if (/WITH RECURSIVE tree[\s\S]*FROM suspended/.test(sql)) {
        return { rows: suspended }
      }
      return { rows: [] }
    }) as never

    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    const count = await runServiceLeaseSweep(db as never)
    expect(count).toBe(2)

    const outboxInserts = client.calls.filter(([sql]) => sql.includes('INSERT INTO caracal_outbox'))
    const allDedupes = outboxInserts.flatMap(([, params]) => (params ?? []) as unknown[])
    expect(allDedupes).toEqual(expect.arrayContaining(['suspend:agent-1', 'suspend:agent-2']))
    const suspension = allDedupes.find(
      (value): value is Record<string, unknown> => typeof value === 'object' && value !== null && value.agent_session_id === 'agent-1',
    )
    expect(suspension).not.toHaveProperty('session_id')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('commits without subtree work when no leases expired', async () => {
    const client = clientFromSteps([
      { match: /pg_try_advisory_xact_lock/, rows: [{ acquired: true }] },
      { match: /FROM sessions[\s\S]*heartbeat_deadline_at < now\(\)[\s\S]*LIMIT/, rows: [] },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runServiceLeaseSweep(db as never)).resolves.toBe(0)

    expect(client.calls.some(([sql]) => sql.includes('WITH RECURSIVE tree'))).toBe(false)
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('rolls back and releases when service lease selection fails', async () => {
    const err = new Error('selection failed')
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ acquired: true }] }
        if (/FROM sessions[\s\S]*heartbeat_deadline_at < now\(\)/.test(sql)) throw err
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }

    await expect(runServiceLeaseSweep(db as never)).rejects.toThrow(err)

    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('updates start-helper stats and logs interval failures', async () => {
    vi.useFakeTimers()
    const beforeRuns = serviceLeaseSweeperStats.runs
    const beforeFailures = serviceLeaseSweeperStats.failures
    const err = new Error('connect failed')
    const log = { error: vi.fn() }
    const db = { connect: vi.fn().mockRejectedValue(err) }
    const handle = startServiceLeaseSweeper(db as never, { intervalMs: 10, log })

    await vi.advanceTimersByTimeAsync(10)
    await handle.stop()

    expect(serviceLeaseSweeperStats.runs).toBe(beforeRuns + 1)
    expect(serviceLeaseSweeperStats.failures).toBe(beforeFailures + 1)
    expect(log.error).toHaveBeenCalledWith({ err }, 'service_lease_sweep_failed')
  })
})
