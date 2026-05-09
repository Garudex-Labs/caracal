// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the CrewAI adapter: runWithAgent, runCrewWithAgent, outboundHeaders.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runWithAgent,
  runCrewWithAgent,
  outboundHeaders,
} from '../../../../packages/framework-adaptor/agent-crewai/ts/src/crewai.js'

function makeCoordinator() {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ agent_session_id: 'ses-1' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
  return { baseUrl: 'http://coord', fetchImpl }
}

const BASE_OPTS = {
  zoneId: 'z1',
  applicationId: 'app1',
  subjectToken: 'tok',
}

describe('runWithAgent', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('runs the task inside an agent session and returns its result', async () => {
    const coordinator = makeCoordinator()
    const task = { execute: vi.fn().mockResolvedValue('done') }
    const result = await runWithAgent({ coordinator, ...BASE_OPTS }, task, { x: 1 })
    expect(result).toBe('done')
    expect(task.execute).toHaveBeenCalledWith({ x: 1 })
    expect(coordinator.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('spawns then terminates the agent session', async () => {
    const coordinator = makeCoordinator()
    const task = { execute: vi.fn().mockResolvedValue(null) }
    await runWithAgent({ coordinator, ...BASE_OPTS }, task, {})
    const [spawnCall, terminateCall] = coordinator.fetchImpl.mock.calls
    expect((spawnCall[0] as string)).toContain('/zones/z1/agents')
    expect((terminateCall[0] as string)).toContain('ses-1')
  })
})

describe('runCrewWithAgent', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('runs fn inside an agent session and returns its result', async () => {
    const coordinator = makeCoordinator()
    const fn = vi.fn().mockResolvedValue(42)
    const result = await runCrewWithAgent({ coordinator, ...BASE_OPTS }, fn)
    expect(result).toBe(42)
    expect(fn).toHaveBeenCalledOnce()
  })
})

describe('outboundHeaders', () => {
  it('returns envelope headers within an active agent session', async () => {
    const coordinator = makeCoordinator()
    let headers: Record<string, string> = {}
    await runCrewWithAgent({ coordinator, ...BASE_OPTS }, async () => {
      headers = outboundHeaders()
    })
    expect(headers).toHaveProperty('authorization', 'Bearer tok')
    expect(headers['baggage']).toContain('caracal.agent_session=ses-1')
  })
})
