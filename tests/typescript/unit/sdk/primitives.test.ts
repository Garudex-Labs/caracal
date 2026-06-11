// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Integration-style tests for SDK primitives: spawn (with grant) and delegate drive the coordinator client end-to-end.

import { describe, it, expect, vi } from 'vitest'
import { spawn, delegate, Grant } from '../../../../packages/sdk/ts/src/primitives.js'
import { type CoordinatorClient } from '../../../../packages/sdk/ts/src/coordinator.js'
import { bind, current, type CaracalContext } from '../../../../packages/sdk/ts/src/context.js'

interface Recorder {
  client: CoordinatorClient
  calls: { method: string; path: string }[]
}

function recorder(agentId = 'agent-new', edgeId = 'edge-new'): Recorder {
  const calls: { method: string; path: string }[] = []
  const fetchImpl = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET'
    const path = new URL(url).pathname
    calls.push({ method, path })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (path.endsWith('/delegations')) {
      return new Response(JSON.stringify({ delegation_edge_id: edgeId }), { status: 200 })
    }
    return new Response(JSON.stringify({ agent_session_id: agentId }), { status: 200 })
  }) as unknown as typeof fetch
  return { client: { baseUrl: 'http://coord', fetchImpl }, calls }
}

function baseCtx(overrides: Partial<CaracalContext> = {}): CaracalContext {
  return {
    subjectToken: 'tok',
    zoneId: 'zone-1',
    applicationId: 'app-1',
    agentSessionId: 'agent-parent',
    sessionId: 'sess-1',
    traceId: 'trace-1',
    hop: 0,
    ...overrides,
  }
}

describe('spawn', () => {
  it('binds the spawned context and terminates an instance afterwards', async () => {
    const { client, calls } = recorder()
    let boundAgent: string | undefined
    const result = await spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {
      boundAgent = current()?.agentSessionId
      return 'done'
    })
    expect(result).toBe('done')
    expect(boundAgent).toBe('agent-new')
    expect(calls.map((c) => c.method)).toContain('DELETE')
  })

  it('runs lifecycle hooks around the bound function', async () => {
    const { client } = recorder()
    const onAgentStart = vi.fn()
    const onAgentEnd = vi.fn()
    await spawn(
      { coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', onAgentStart, onAgentEnd },
      async () => {},
    )
    expect(onAgentStart).toHaveBeenCalledOnce()
    expect(onAgentEnd).toHaveBeenCalledOnce()
  })

  it('still terminates and runs onAgentEnd when fn throws', async () => {
    const { client, calls } = recorder()
    const onAgentEnd = vi.fn()
    await expect(
      spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', onAgentEnd }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(onAgentEnd).toHaveBeenCalledOnce()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('terminates without running onAgentEnd when onAgentStart throws', async () => {
    const { client, calls } = recorder()
    const onAgentEnd = vi.fn()
    await expect(
      spawn(
        {
          coordinator: client,
          zoneId: 'zone-1',
          applicationId: 'app-1',
          subjectToken: 'tok',
          onAgentStart: async () => {
            throw new Error('start failed')
          },
          onAgentEnd,
        },
        async () => {},
      ),
    ).rejects.toThrow('start failed')
    expect(onAgentEnd).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('inherits the parent agent session as parentId', async () => {
    const { client, calls } = recorder()
    await bind(baseCtx(), async () => {
      await spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {})
    })
    expect(calls.some((c) => c.path.endsWith('/agents'))).toBe(true)
  })

  it('carries the parent narrowing edge forward on an intra-app inherit child', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/agents')) {
        bodies.push(JSON.parse(init?.body ?? '{}'))
        return new Response(JSON.stringify({ agent_session_id: 'agent-child', delegation_edge_id: 'edge-child' }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    let childEdge: string | undefined
    let childHop: number | undefined
    await bind(baseCtx({ delegationEdgeId: 'edge-parent', hop: 1 }), async () => {
      await spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {
        childEdge = current()?.delegationEdgeId
        childHop = current()?.hop
      })
    })
    expect(bodies[0]?.inherit_parent_edge_id).toBe('edge-parent')
    expect(childEdge).toBe('edge-child')
    expect(childHop).toBe(2)
  })

  it('does not request an inherit edge when spawning into another application', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/agents')) {
        bodies.push(JSON.parse(init?.body ?? '{}'))
        return new Response(JSON.stringify({ agent_session_id: 'agent-child' }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    let childEdge: string | undefined
    await bind(baseCtx({ delegationEdgeId: 'edge-parent', hop: 1 }), async () => {
      await spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'other-app', subjectToken: 'tok' }, async () => {
        childEdge = current()?.delegationEdgeId
      })
    })
    expect(bodies[0]?.inherit_parent_edge_id).toBeUndefined()
    expect(childEdge).toBeUndefined()
  })
})

describe('delegate', () => {
  it('requires an active context', async () => {
    const { client } = recorder()
    await expect(
      delegate({ coordinator: client, toAgentSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] }, async () => {}),
    ).rejects.toThrow(/requires a Caracal context/)
  })

  it('requires an active agent session in context', async () => {
    const { client } = recorder()
    await bind(baseCtx({ agentSessionId: undefined }), async () => {
      await expect(
        delegate({ coordinator: client, toAgentSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] }, async () => {}),
      ).rejects.toThrow(/active agent session/)
    })
  })

  it('records a delegation edge and increments the hop in the child context', async () => {
    const { client } = recorder('agent-new', 'edge-42')
    await bind(baseCtx(), async () => {
      const childHop = await delegate(
        { coordinator: client, toAgentSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] },
        async () => ({ hop: current()?.hop, edge: current()?.delegationEdgeId }),
      )
      expect(childHop.hop).toBe(1)
      expect(childHop.edge).toBe('edge-42')
    })
  })
})

describe('spawn with narrow grant', () => {
  it('requires an active agent session', async () => {
    const { client } = recorder()
    await expect(
      spawn(
        { coordinator: client, zoneId: 'zone-1', applicationId: 'app-2', subjectToken: 'tok', grant: Grant.narrow(['read']) },
        async () => {},
      ),
    ).rejects.toThrow(/active parent agent session/)
  })

  it('spawns a child, records the delegation, and binds the merged context', async () => {
    const { client, calls } = recorder('agent-child', 'edge-child')
    await bind(baseCtx(), async () => {
      const out = await spawn(
        { coordinator: client, zoneId: 'zone-1', applicationId: 'app-2', subjectToken: 'tok', grant: Grant.narrow(['read']) },
        async () => ({
          agent: current()?.agentSessionId,
          edge: current()?.delegationEdgeId,
          hop: current()?.hop,
        }),
      )
      expect(out).toMatchObject({ agent: 'agent-child', edge: 'edge-child', hop: 1 })
    })
    expect(calls.some((c) => c.path.endsWith('/delegations'))).toBe(true)
  })

  it('terminates the spawned child when delegation creation fails', async () => {
    const calls: { method: string; path: string }[] = []
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      calls.push({ method, path })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/delegations')) return new Response('denied', { status: 403 })
      return new Response(JSON.stringify({ agent_session_id: 'agent-orphan' }), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }

    await bind(baseCtx(), async () => {
      await expect(
        spawn(
          { coordinator: client, zoneId: 'zone-1', applicationId: 'app-2', subjectToken: 'tok', grant: Grant.narrow(['read']) },
          async () => {},
        ),
      ).rejects.toThrow()
    })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('terminates without running onAgentEnd when delegated child start hook throws', async () => {
    const { client, calls } = recorder('agent-child', 'edge-child')
    const onAgentEnd = vi.fn()

    await bind(baseCtx(), async () => {
      await expect(
        spawn(
          {
            coordinator: client,
            zoneId: 'zone-1',
            applicationId: 'app-2',
            subjectToken: 'tok',
            grant: Grant.narrow(['read']),
            onAgentStart: async () => {
              throw new Error('start failed')
            },
            onAgentEnd,
          },
          async () => {},
        ),
      ).rejects.toThrow('start failed')
    })
    expect(onAgentEnd).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('terminateAgent throws when the coordinator DELETE fails', async () => {
    const { terminateAgent } = await import('../../../../packages/sdk/ts/src/coordinator.js')
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await expect(terminateAgent(client, 'tok', 'zone-1', 'agent-9')).rejects.toThrow(/coordinator DELETE .* failed: 404 not found/)
  })
})
