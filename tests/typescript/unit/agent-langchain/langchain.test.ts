// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the LangChain adapter: run, node, tool, delegate.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaracalCallbackHandler } from '../../../../packages/framework-adaptor/agent-langchain/ts/src/langchain.js'

function makeCoordinator(extra?: ReturnType<typeof vi.fn>[]) {
  const calls = [
    { ok: true, status: 200, json: async () => ({ agent_session_id: 'ses-1' }) },
    { ok: true, status: 200, json: async () => ({}) },
    ...(extra ?? []),
  ]
  const fetchImpl = vi.fn()
  calls.forEach((r) => fetchImpl.mockResolvedValueOnce(r))
  return { baseUrl: 'http://coord', fetchImpl }
}

const BASE_OPTS = {
  zoneId: 'z1',
  applicationId: 'app1',
  subjectToken: 'tok',
}

describe('CaracalCallbackHandler', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('run executes fn inside an agent session and returns result', async () => {
    const coordinator = makeCoordinator()
    const handler = new CaracalCallbackHandler({ coordinator, ...BASE_OPTS })
    const fn = vi.fn().mockResolvedValue('result')
    const out = await handler.run(fn)
    expect(out).toBe('result')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('run spawns and terminates the agent session', async () => {
    const coordinator = makeCoordinator()
    const handler = new CaracalCallbackHandler({ coordinator, ...BASE_OPTS })
    await handler.run(async () => {})
    const [spawnCall, terminateCall] = coordinator.fetchImpl.mock.calls
    expect((spawnCall[0] as string)).toContain('/zones/z1/agents')
    expect((terminateCall[0] as string)).toContain('ses-1')
  })

  it('node runs fn inside a nested ephemeral session', async () => {
    const coordinator = makeCoordinator([
      { ok: true, status: 200, json: async () => ({ agent_session_id: 'ses-2' }) },
      { ok: true, status: 200, json: async () => ({}) },
    ])
    const handler = new CaracalCallbackHandler({ coordinator, ...BASE_OPTS })
    const fn = vi.fn().mockResolvedValue('node-out')
    const out = await handler.run(async () => handler.node(fn))
    expect(out).toBe('node-out')
    expect(coordinator.fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('tool wraps a LangChainTool and passes outbound headers', async () => {
    const coordinator = makeCoordinator()
    const handler = new CaracalCallbackHandler({ coordinator, ...BASE_OPTS })
    const toolFn = { call: vi.fn().mockResolvedValue('tool-result') }
    let toolOut: unknown
    await handler.run(async () => {
      toolOut = await handler.tool('svc://resource', toolFn)('my-input')
    })
    expect(toolOut).toBe('tool-result')
    const passedHeaders = (toolFn.call.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(passedHeaders['baggage']).toContain('caracal.agent_session=ses-1')
  })
})
