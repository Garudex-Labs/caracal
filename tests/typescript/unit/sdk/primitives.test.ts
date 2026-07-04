// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Integration-style tests for SDK primitives: spawn (with grant) and delegate drive the coordinator client end-to-end.

import { describe, it, expect, vi } from 'vitest'
import { spawn, spawnService, delegate, Grant } from '../../../../packages/sdk/ts/src/primitives.js'
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

describe('spawnService with grant', () => {
  it('issues a narrowed delegation edge for the service handle', async () => {
    const { client, calls } = recorder('svc-1', 'edge-svc')
    await bind(baseCtx({ delegationEdgeId: 'edge-parent', hop: 1 }), async () => {
      const svc = await spawnService({
        coordinator: client,
        zoneId: 'zone-1',
        applicationId: 'app-2',
        subjectToken: 'tok',
        grant: Grant.narrow(['ledger:read'], { resourceId: 'resource://ledger' }),
      })
      expect(svc.context.delegationEdgeId).toBe('edge-svc')
      expect(svc.context.parentEdgeId).toBe('edge-parent')
      expect(svc.context.hop).toBe(2)
      await svc.close()
    })
    expect(calls.some((c) => c.path.endsWith('/delegations'))).toBe(true)
  })

  it('requires an active parent session for a narrow grant', async () => {
    const { client } = recorder()
    await expect(
      spawnService({
        coordinator: client,
        zoneId: 'zone-1',
        applicationId: 'app-2',
        subjectToken: 'tok',
        grant: Grant.narrow(['read']),
      }),
    ).rejects.toThrow(/active parent agent session/)
  })

  it('terminates the service agent when delegation creation fails', async () => {
    const calls: { method: string; path: string }[] = []
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      calls.push({ method, path })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/delegations')) return new Response('denied', { status: 403 })
      return new Response(JSON.stringify({ agent_session_id: 'svc-orphan' }), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }

    await bind(baseCtx(), async () => {
      await expect(
        spawnService({
          coordinator: client,
          zoneId: 'zone-1',
          applicationId: 'app-2',
          subjectToken: 'tok',
          grant: Grant.narrow(['read']),
        }),
      ).rejects.toThrow()
    })
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/svc-orphan'))).toBe(true)
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

describe('spawn reliability', () => {
  it('retries a transient 5xx spawn with the same idempotency key', async () => {
    vi.useFakeTimers()
    try {
      const keys: (string | null)[] = []
      let spawnCalls = 0
      const fetchImpl = (async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname
        if (init.method === 'DELETE') return new Response(null, { status: 204 })
        if (path.endsWith('/agents')) {
          spawnCalls += 1
          keys.push(new Headers(init.headers as HeadersInit).get('idempotency-key'))
          if (spawnCalls === 1) return new Response('upstream unavailable', { status: 503 })
          return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }) as unknown as typeof fetch
      const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
      const result = spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => 'ok')
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(result).resolves.toBe('ok')
      expect(spawnCalls).toBe(2)
      expect(keys[0]).toBeTruthy()
      expect(keys[1]).toBe(keys[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a 4xx spawn rejection', async () => {
    let spawnCalls = 0
    const fetchImpl = (async () => {
      spawnCalls += 1
      return new Response('bad request', { status: 400 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await expect(
      spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => 'ok'),
    ).rejects.toThrow(/400/)
    expect(spawnCalls).toBe(1)
  })

  it('keeps the fn result when cleanup finds the session already gone', async () => {
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'DELETE') return new Response('{"error":"agent_not_found"}', { status: 404 })
      if (new URL(url).pathname.endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await expect(
      spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => 'result'),
    ).resolves.toBe('result')
  })

  it('keeps the fn error when the cleanup terminate itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchImpl = (async (url: string, init: RequestInit = {}) => {
        if (init.method === 'DELETE') return new Response('db down', { status: 500 })
        if (new URL(url).pathname.endsWith('/agents')) {
          return new Response(JSON.stringify({ agent_session_id: 'agent-1' }), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }) as unknown as typeof fetch
      const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
      await expect(
        spawn({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {
          throw new Error('primary failure')
        }),
      ).rejects.toThrow('primary failure')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('service auto-heartbeat', () => {
  function serviceRecorder(opts: { heartbeat?: (n: number) => Response } = {}) {
    const heartbeats: Record<string, unknown>[] = []
    let beats = 0
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/heartbeat')) {
        beats += 1
        heartbeats.push(JSON.parse(String(init.body)))
        if (opts.heartbeat) return opts.heartbeat(beats)
        return new Response(
          JSON.stringify({ agent: { status: 'active', heartbeat_deadline_at: new Date(Date.now() + 3_000).toISOString() } }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ agent_session_id: 'svc-1', heartbeat_deadline_at: new Date(Date.now() + 3_000).toISOString() }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    return { client: { baseUrl: 'http://coord', fetchImpl } as CoordinatorClient, heartbeats }
  }

  it('renews the lease by default on a cadence derived from the server deadline', async () => {
    vi.useFakeTimers()
    try {
      const { client, heartbeats } = serviceRecorder()
      const svc = await spawnService({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' })
      await vi.advanceTimersByTimeAsync(1_500)
      expect(heartbeats.length).toBeGreaterThanOrEqual(1)
      expect(heartbeats[0]).toEqual({ status: 'healthy' })
      await svc.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the timer and reports onLeaseLost when the session is permanently gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const { client, heartbeats } = serviceRecorder({
        heartbeat: () => new Response('{"error":"agent_not_found"}', { status: 404 }),
      })
      const onLeaseLost = vi.fn()
      const svc = await spawnService({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', onLeaseLost })
      await vi.advanceTimersByTimeAsync(1_500)
      expect(onLeaseLost).toHaveBeenCalledOnce()
      const beatsAfterLoss = heartbeats.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(heartbeats.length).toBe(beatsAfterLoss)
      await svc.close()
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('disables the background timer when heartbeatIntervalMs is zero', async () => {
    vi.useFakeTimers()
    try {
      const { client, heartbeats } = serviceRecorder()
      const svc = await spawnService({
        coordinator: client,
        zoneId: 'zone-1',
        applicationId: 'app-1',
        subjectToken: 'tok',
        heartbeatIntervalMs: 0,
      })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(heartbeats.length).toBe(0)
      await svc.heartbeat('degraded')
      expect(heartbeats).toEqual([{ status: 'degraded' }])
      await svc.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats closing an already-retired session as success', async () => {
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'DELETE') return new Response('{"error":"agent_not_found"}', { status: 404 })
      if (new URL(url).pathname.endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'svc-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    const svc = await spawnService({
      coordinator: client,
      zoneId: 'zone-1',
      applicationId: 'app-1',
      subjectToken: 'tok',
      heartbeatIntervalMs: 0,
    })
    await expect(svc.close()).resolves.toBeUndefined()
  })
})
