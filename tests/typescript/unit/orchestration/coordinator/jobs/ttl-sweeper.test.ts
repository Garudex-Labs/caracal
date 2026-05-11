// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// TTL sweeper unit tests covering leader election and cascade termination.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { runTTLSweep } from '../../../../../../apps/coordinator/src/jobs/ttl-sweeper.js'

beforeAll(() => {
  process.env.ISSUER_URL ??= 'http://issuer.test'
  process.env.AGENT_COORDINATOR_AUDIENCE ??= 'coord.test'
  process.env.STS_URL ??= 'http://sts.test'
  process.env.AGENT_COORDINATOR_SCOPE ??= 'coordinator.use'
  process.env.DATABASE_URL ??= 'postgres://x'
  process.env.REDIS_URL ??= 'redis://x'
})

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

describe('runTTLSweep', () => {
  it('skips work when the advisory lock is held by another node', async () => {
    const client = clientFromSteps([
      { match: /pg_try_advisory_xact_lock/, rows: [{ acquired: false }] },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runTTLSweep(db as never)).resolves.toBe(0)
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('terminates expired sessions across zones via terminateSubtree', async () => {
    const expired = [
      { id: 'agent-1', zone_id: 'z1' },
      { id: 'agent-2', zone_id: 'z1' },
      { id: 'agent-3', zone_id: 'z2' },
    ]
    const terminatedZ1 = [
      { id: 'agent-1', session_sid: 'sid-1', parent_id: null },
      { id: 'agent-2', session_sid: 'sid-2', parent_id: 'agent-1' },
    ]
    const terminatedZ2 = [
      { id: 'agent-3', session_sid: 'sid-3', parent_id: null },
    ]
    let subtreeCall = 0
    const client = clientFromSteps([
      { match: /pg_try_advisory_xact_lock/, rows: [{ acquired: true }] },
      { match: /FROM agent_sessions[\s\S]*FOR UPDATE SKIP LOCKED/, rows: expired },
    ])
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      client.calls.push([sql, params])
      if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/FROM agent_sessions[\s\S]*FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: expired }
      if (/WITH RECURSIVE tree[\s\S]*FROM terminated/.test(sql)) {
        subtreeCall += 1
        return { rows: subtreeCall === 1 ? terminatedZ1 : terminatedZ2 }
      }
      return { rows: [] }
    }) as never

    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    const count = await runTTLSweep(db as never)
    expect(count).toBe(3)

    const outboxInserts = client.calls.filter(([sql]) => sql.includes('INSERT INTO caracal_outbox'))
    expect(outboxInserts.length).toBe(2)
    const allDedupes = outboxInserts.flatMap(([, params]) => (params ?? []) as unknown[])
    expect(allDedupes).toEqual(expect.arrayContaining([
      'agent_terminate:agent-1', 'terminate:agent-1',
      'agent_terminate:agent-2', 'terminate:agent-2',
      'agent_terminate:agent-3', 'terminate:agent-3',
    ]))
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('commits with no work when nothing expired', async () => {
    const client = clientFromSteps([
      { match: /pg_try_advisory_xact_lock/, rows: [{ acquired: true }] },
    ])
    const db = { connect: vi.fn().mockResolvedValueOnce(client) }
    await expect(runTTLSweep(db as never)).resolves.toBe(0)
    const outboxInserts = client.calls.filter(([sql]) => sql.includes('caracal_outbox'))
    expect(outboxInserts.length).toBe(0)
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })
})
