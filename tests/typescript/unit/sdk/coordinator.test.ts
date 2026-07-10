// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the coordinator REST client: wire mapping, errors, cancellation, and URL handling.

import { describe, it, expect, vi } from 'vitest'
import {
  CoordinatorError,
  startCoordinatorSession,
  terminateAgent,
  createDelegation,
  heartbeatAgent,
  type CoordinatorCallEvent,
  type CoordinatorClient,
} from '../../../../packages/sdk/ts/src/coordinator.js'

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: Record<string, unknown> | undefined
}

function stub(respond: (rec: Recorded) => Response): { client: CoordinatorClient; calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rec: Recorded = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers as HeadersInit),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(rec)
    return respond(rec)
  }) as unknown as typeof fetch
  return { client: { baseUrl: 'http://coord', fetchImpl }, calls }
}

describe('coordinator client', () => {
  it('maps the spawn response to camelCase and sends the idempotency key', async () => {
    const { client, calls } = stub(
      () =>
        new Response(
          JSON.stringify({
            agent_session_id: 'agent-1',
            delegation_edge_id: 'edge-1',
            heartbeat_deadline_at: '2026-07-04T12:00:00.000Z',
          }),
          { status: 201 },
        ),
    )
    const res = await startCoordinatorSession(client, 'tok', { zoneId: 'z1', applicationId: 'app-1', idempotencyKey: 'key-1' })
    expect(res).toEqual({ sessionId: 'agent-1', delegationId: 'edge-1', heartbeatDeadlineAt: '2026-07-04T12:00:00.000Z' })
    expect(calls[0].headers.get('idempotency-key')).toBe('key-1')
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok')
  })

  it('rejects a spawn response that lacks an agent session id', async () => {
    const { client } = stub(() => new Response(JSON.stringify({}), { status: 201 }))
    await expect(startCoordinatorSession(client, 'tok', { zoneId: 'z1', applicationId: 'app-1' })).rejects.toThrow(
      /missing agent_session_id/,
    )
  })

  it('raises CoordinatorError carrying method, path, status, and body', async () => {
    const { client } = stub(() => new Response('zone quota exceeded', { status: 403 }))
    const err = await startCoordinatorSession(client, 'tok', { zoneId: 'z1', applicationId: 'app-1' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CoordinatorError)
    const coordErr = err as CoordinatorError
    expect(coordErr.method).toBe('POST')
    expect(coordErr.path).toBe('/zones/z1/agents')
    expect(coordErr.status).toBe(403)
    expect(coordErr.message).toBe('coordinator POST /zones/z1/agents failed: 403 zone quota exceeded')
  })

  it('normalizes a trailing slash on the base URL', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord/', fetchImpl }
    await terminateAgent(client, 'tok', 'z1', 'agent-1')
    expect(calls[0]).toBe('http://coord/zones/z1/agents/agent-1')
  })

  it('treats a 204 terminate as success', async () => {
    const { client } = stub(() => new Response(null, { status: 204 }))
    await expect(terminateAgent(client, 'tok', 'z1', 'agent-1')).resolves.toBeUndefined()
  })

  it('omits resource_id from a delegation without one and maps the response', async () => {
    const { client, calls } = stub(
      () =>
        new Response(JSON.stringify({ delegation_edge_id: 'edge-9', scopes: ['read'], expires_at: '2026-07-04T12:00:00.000Z' }), {
          status: 201,
        }),
    )
    const res = await createDelegation(client, 'tok', {
      zoneId: 'z1',
      issuerApplicationId: 'app-1',
      sourceSessionId: 's1',
      targetSessionId: 's2',
      receiverApplicationId: 'app-2',
      scopes: ['read'],
    })
    expect(res).toEqual({ delegationId: 'edge-9', scopes: ['read'], expiresAt: '2026-07-04T12:00:00.000Z' })
    expect(calls[0].body).not.toHaveProperty('resource_id')
  })

  it('sends resource_id when the delegation names a resource', async () => {
    const { client, calls } = stub(() => new Response(JSON.stringify({ delegation_edge_id: 'edge-9' }), { status: 201 }))
    await createDelegation(client, 'tok', {
      zoneId: 'z1',
      issuerApplicationId: 'app-1',
      sourceSessionId: 's1',
      targetSessionId: 's2',
      receiverApplicationId: 'app-2',
      resourceId: 'resource://pipernet',
      scopes: ['read'],
    })
    expect(calls[0].body?.resource_id).toBe('resource://pipernet')
  })

  it('rejects a delegation response that lacks an edge id', async () => {
    const { client } = stub(() => new Response(JSON.stringify({}), { status: 201 }))
    await expect(
      createDelegation(client, 'tok', {
        zoneId: 'z1',
        issuerApplicationId: 'app-1',
        sourceSessionId: 's1',
        targetSessionId: 's2',
        receiverApplicationId: 'app-2',
        scopes: ['read'],
      }),
    ).rejects.toThrow(/missing delegation_edge_id/)
  })

  it('sends the heartbeat status and parses the renewed lease', async () => {
    const { client, calls } = stub(
      () =>
        new Response(JSON.stringify({ agent: { status: 'active', heartbeat_deadline_at: '2026-07-04T12:02:00.000Z' }, service: null }), {
          status: 200,
        }),
    )
    const res = await heartbeatAgent(client, 'tok', 'z1', 'agent-1', 'degraded')
    expect(calls[0].body).toEqual({ status: 'degraded' })
    expect(res).toEqual({ status: 'active', heartbeatDeadlineAt: '2026-07-04T12:02:00.000Z' })
  })

  it('escapes path segments in zone and agent ids', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await terminateAgent(client, 'tok', 'z/1', 'agent 1')
    expect(calls[0]).toBe('http://coord/zones/z%2F1/agents/agent%201')
  })

  it('aborts the request when the caller signal fires', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      init.signal?.throwIfAborted()
      return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 201 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    const controller = new AbortController()
    controller.abort()
    await expect(startCoordinatorSession(client, 'tok', { zoneId: 'z1', applicationId: 'app-1' }, controller.signal)).rejects.toThrow()
  })

  it('emits coordinator.call events for success, denial, and transport failure', async () => {
    const events: CoordinatorCallEvent[] = []
    const { client } = stub((rec) =>
      rec.method === 'DELETE'
        ? new Response(JSON.stringify({ error: 'denied' }), { status: 403 })
        : new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 201 }),
    )
    client.onEvent = (event) => {
      events.push(event)
      throw new Error('sink failure')
    }

    await startCoordinatorSession(client, 'tok', { zoneId: 'z1', applicationId: 'app-1' })
    await expect(terminateAgent(client, 'tok', 'z1', 'agent-1')).rejects.toThrow(CoordinatorError)

    const failing: CoordinatorClient = {
      baseUrl: 'http://coord',
      fetchImpl: (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch,
      onEvent: (event) => events.push(event),
    }
    await expect(startCoordinatorSession(failing, 'tok', { zoneId: 'z1', applicationId: 'app-1' })).rejects.toThrow('network down')

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ type: 'coordinator.call', method: 'POST', ok: true, status: 201 })
    expect(events[0].path).toBe('/zones/z1/agents')
    expect(events[1]).toMatchObject({ type: 'coordinator.call', method: 'DELETE', ok: false, status: 403 })
    expect(events[2]).toMatchObject({ type: 'coordinator.call', method: 'POST', ok: false, status: 0 })
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0)
  })
})
