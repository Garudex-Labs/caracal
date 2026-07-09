// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Integration-style tests for SDK primitives: session (with authority) and delegate drive the coordinator client end-to-end.

import { describe, it, expect, vi } from 'vitest'
import { session, startSession, attachSession, delegate, acceptDelegation, Authority } from '../../../../packages/sdk/ts/src/primitives.js'
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
    sessionId: 'agent-parent',
    subjectSessionId: 'sess-1',
    traceId: 'trace-1',
    hop: 0,
    ...overrides,
  }
}

describe('session', () => {
  it('binds the session context and terminates an instance afterwards', async () => {
    const { client, calls } = recorder()
    let boundSession: string | undefined
    const result = await session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {
      boundSession = current()?.sessionId
      return 'done'
    })
    expect(result).toBe('done')
    expect(boundSession).toBe('agent-new')
    expect(calls.map((c) => c.method)).toContain('DELETE')
  })

  it('passes the bound context to fn', async () => {
    const { client } = recorder()
    await session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async (ctx) => {
      expect(ctx.sessionId).toBe('agent-new')
      expect(ctx).toBe(current())
    })
  })

  it('runs lifecycle hooks around the bound function', async () => {
    const { client } = recorder()
    const onSessionStart = vi.fn()
    const onSessionEnd = vi.fn()
    await session(
      { coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', onSessionStart, onSessionEnd },
      async () => {},
    )
    expect(onSessionStart).toHaveBeenCalledOnce()
    expect(onSessionEnd).toHaveBeenCalledOnce()
  })

  it('still terminates and runs onSessionEnd when fn throws', async () => {
    const { client, calls } = recorder()
    const onSessionEnd = vi.fn()
    await expect(
      session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', onSessionEnd }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(onSessionEnd).toHaveBeenCalledOnce()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('terminates without running onSessionEnd when onSessionStart throws', async () => {
    const { client, calls } = recorder()
    const onSessionEnd = vi.fn()
    await expect(
      session(
        {
          coordinator: client,
          zoneId: 'zone-1',
          applicationId: 'app-1',
          subjectToken: 'tok',
          onSessionStart: async () => {
            throw new Error('start failed')
          },
          onSessionEnd,
        },
        async () => {},
      ),
    ).rejects.toThrow('start failed')
    expect(onSessionEnd).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('inherits the parent session as parentId', async () => {
    const { client, calls } = recorder()
    await bind(baseCtx(), async () => {
      await session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {})
    })
    expect(calls.some((c) => c.path.endsWith('/agents'))).toBe(true)
  })

  it('requests server-side inheritance and accepts the mirrored delegation', async () => {
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
    let childDelegation: string | undefined
    let childHop: number | undefined
    await bind(baseCtx({ delegationId: 'edge-parent', hop: 1 }), async () => {
      await session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {
        childDelegation = current()?.delegationId
        childHop = current()?.hop
      })
    })
    expect(bodies[0]?.parent_authority).toBe('inherit')
    expect(bodies[0]).not.toHaveProperty('inherit_parent_edge_id')
    expect(childDelegation).toBe('edge-child')
    expect(childHop).toBe(2)
  })

  it('leaves the child delegation-less when the coordinator mirrors nothing', async () => {
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
    let childDelegation: string | undefined
    await bind(baseCtx({ delegationId: 'edge-parent', hop: 1 }), async () => {
      await session({ coordinator: client, zoneId: 'zone-1', applicationId: 'other-app', subjectToken: 'tok' }, async () => {
        childDelegation = current()?.delegationId
      })
    })
    expect(bodies[0]?.parent_authority).toBe('inherit')
    expect(childDelegation).toBeUndefined()
  })

  it('suppresses inheritance for narrowed authority', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/delegations')) {
        return new Response(JSON.stringify({ delegation_edge_id: 'edge-narrow' }), { status: 200 })
      }
      bodies.push(JSON.parse(init?.body ?? '{}'))
      return new Response(JSON.stringify({ agent_session_id: 'agent-child' }), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await bind(baseCtx({ delegationId: 'edge-parent', hop: 1 }), async () => {
      await session(
        { coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', authority: Authority.narrow(['read']) },
        async () => {},
      )
    })
    expect(bodies[0]?.parent_authority).toBe('none')
  })
})

describe('startSession with authority', () => {
  it('exposes the lease deadline the coordinator reported', async () => {
    const calls: { method: string; path: string }[] = []
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, path: new URL(url).pathname })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ agent_session_id: 'agent-svc', heartbeat_deadline_at: '2026-07-09T12:00:00Z' }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    const svc = await startSession({
      coordinator: { baseUrl: 'http://coord', fetchImpl },
      zoneId: 'zone-1',
      applicationId: 'app-1',
      subjectToken: 'tok',
      heartbeatIntervalMs: 0,
    })
    expect(svc.deadlineAt).toBe('2026-07-09T12:00:00Z')
    await svc.close()
  })

  it('issues a narrowed delegation for the session handle', async () => {
    const { client, calls } = recorder('svc-1', 'edge-svc')
    await bind(baseCtx({ delegationId: 'edge-parent', hop: 1 }), async () => {
      const svc = await startSession({
        coordinator: client,
        zoneId: 'zone-1',
        applicationId: 'app-2',
        subjectToken: 'tok',
        authority: Authority.narrow(['ledger:read'], { resourceId: 'resource://ledger' }),
      })
      expect(svc.context.delegationId).toBe('edge-svc')
      expect(svc.context.parentDelegationId).toBe('edge-parent')
      expect(svc.context.hop).toBe(2)
      await svc.close()
    })
    expect(calls.some((c) => c.path.endsWith('/delegations'))).toBe(true)
  })

  it('requires an active parent session for narrowed authority', async () => {
    const { client } = recorder()
    await expect(
      startSession({
        coordinator: client,
        zoneId: 'zone-1',
        applicationId: 'app-2',
        subjectToken: 'tok',
        authority: Authority.narrow(['read']),
      }),
    ).rejects.toThrow(/active parent session/)
  })

  it('terminates the session when delegation creation fails', async () => {
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
        startSession({
          coordinator: client,
          zoneId: 'zone-1',
          applicationId: 'app-2',
          subjectToken: 'tok',
          authority: Authority.narrow(['read']),
        }),
      ).rejects.toThrow()
    })
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/svc-orphan'))).toBe(true)
  })
})

describe('delegate', () => {
  it('requires an active context', async () => {
    const { client } = recorder()
    await expect(delegate({ coordinator: client, toSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] })).rejects.toThrow(
      /requires a Caracal context/,
    )
  })

  it('requires an active session in context', async () => {
    const { client } = recorder()
    await bind(baseCtx({ sessionId: undefined }), async () => {
      await expect(delegate({ coordinator: client, toSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] })).rejects.toThrow(
        /active session/,
      )
    })
  })

  it('returns the created delegation without rebinding the issuer context', async () => {
    const { client } = recorder('agent-new', 'edge-42')
    await bind(baseCtx(), async () => {
      const res = await delegate({ coordinator: client, toSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] })
      expect(res.delegationId).toBe('edge-42')
      expect(current()?.delegationId).toBeUndefined()
      expect(current()?.hop).toBe(0)
    })
  })

  it('acceptDelegation derives a receiver context presenting the delegation', async () => {
    const ctx = baseCtx({ delegationId: 'edge-own', hop: 1 })
    const accepted = acceptDelegation(ctx, 'edge-42')
    expect(accepted.delegationId).toBe('edge-42')
    expect(accepted.parentDelegationId).toBe('edge-own')
    expect(accepted.hop).toBe(2)
    expect(ctx.delegationId).toBe('edge-own')
  })

  it('accepts a single scope string in Authority.narrow', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/delegations')) {
        bodies.push(JSON.parse(init?.body ?? '{}'))
        return new Response(JSON.stringify({ delegation_edge_id: 'edge-one' }), { status: 200 })
      }
      return new Response(JSON.stringify({ agent_session_id: 'agent-child' }), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await bind(baseCtx(), async () => {
      await session(
        { coordinator: client, zoneId: 'zone-1', applicationId: 'app-2', subjectToken: 'tok', authority: Authority.narrow('read') },
        async () => {},
      )
    })
    expect(bodies[0]?.scopes).toEqual(['read'])
  })

  it('retries a transient delegation failure once with the same idempotency key', async () => {
    vi.useFakeTimers()
    try {
      const keys: (string | null)[] = []
      let attempts = 0
      const fetchImpl = (async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname
        if (path.endsWith('/delegations')) {
          attempts += 1
          keys.push(new Headers(init.headers as HeadersInit).get('idempotency-key'))
          if (attempts === 1) return new Response('upstream unavailable', { status: 503 })
          return new Response(JSON.stringify({ delegation_edge_id: 'edge-retry' }), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }) as unknown as typeof fetch
      const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
      const result = bind(baseCtx(), () => delegate({ coordinator: client, toSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] }))
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(result).resolves.toMatchObject({ delegationId: 'edge-retry' })
      expect(attempts).toBe(2)
      expect(keys[0]).toBeTruthy()
      expect(keys[1]).toBe(keys[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a delegation rejected by policy', async () => {
    let attempts = 0
    const fetchImpl = (async (url: string) => {
      if (new URL(url).pathname.endsWith('/delegations')) {
        attempts += 1
        return new Response('denied', { status: 403 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await bind(baseCtx(), async () => {
      await expect(delegate({ coordinator: client, toSessionId: 'a2', toApplicationId: 'app-2', scopes: ['read'] })).rejects.toThrow()
    })
    expect(attempts).toBe(1)
  })
})

describe('attachSession', () => {
  it('validates the session with a lease renewal and returns a live handle', async () => {
    const calls: { method: string; path: string }[] = []
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      const path = new URL(url).pathname
      calls.push({ method, path })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ agent: { status: 'active', heartbeat_deadline_at: '2026-07-09T12:00:00Z' } }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    const handle = await attachSession({
      coordinator: { baseUrl: 'http://coord', fetchImpl },
      zoneId: 'zone-1',
      applicationId: 'app-1',
      subjectToken: 'tok',
      sessionId: 'agent-persisted',
      heartbeatIntervalMs: 0,
    })
    expect(handle.sessionId).toBe('agent-persisted')
    expect(handle.context.sessionId).toBe('agent-persisted')
    expect(handle.deadlineAt).toBe('2026-07-09T12:00:00Z')
    expect(calls[0].path).toBe('/zones/zone-1/agents/agent-persisted/heartbeat')
    await handle.close()
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/agent-persisted'))).toBe(true)
  })

  it('fails fast when the session is no longer live', async () => {
    const fetchImpl = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    await expect(
      attachSession({
        coordinator: { baseUrl: 'http://coord', fetchImpl },
        zoneId: 'zone-1',
        applicationId: 'app-1',
        subjectToken: 'tok',
        sessionId: 'agent-reaped',
        heartbeatIntervalMs: 0,
      }),
    ).rejects.toThrow(/404/)
  })
})

describe('session with narrowed authority', () => {
  it('requires an active parent session', async () => {
    const { client } = recorder()
    await expect(
      session(
        { coordinator: client, zoneId: 'zone-1', applicationId: 'app-2', subjectToken: 'tok', authority: Authority.narrow(['read']) },
        async () => {},
      ),
    ).rejects.toThrow(/active parent session/)
  })

  it('starts a child, records the delegation, and binds the merged context', async () => {
    const { client, calls } = recorder('agent-child', 'edge-child')
    await bind(baseCtx(), async () => {
      const out = await session(
        { coordinator: client, zoneId: 'zone-1', applicationId: 'app-2', subjectToken: 'tok', authority: Authority.narrow(['read']) },
        async () => ({
          session: current()?.sessionId,
          delegation: current()?.delegationId,
          hop: current()?.hop,
        }),
      )
      expect(out).toMatchObject({ session: 'agent-child', delegation: 'edge-child', hop: 1 })
    })
    expect(calls.some((c) => c.path.endsWith('/delegations'))).toBe(true)
  })

  it('terminates the child when delegation creation fails', async () => {
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
        session(
          { coordinator: client, zoneId: 'zone-1', applicationId: 'app-2', subjectToken: 'tok', authority: Authority.narrow(['read']) },
          async () => {},
        ),
      ).rejects.toThrow()
    })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('terminates without running onSessionEnd when delegated child start hook throws', async () => {
    const { client, calls } = recorder('agent-child', 'edge-child')
    const onSessionEnd = vi.fn()

    await bind(baseCtx(), async () => {
      await expect(
        session(
          {
            coordinator: client,
            zoneId: 'zone-1',
            applicationId: 'app-2',
            subjectToken: 'tok',
            authority: Authority.narrow(['read']),
            onSessionStart: async () => {
              throw new Error('start failed')
            },
            onSessionEnd,
          },
          async () => {},
        ),
      ).rejects.toThrow('start failed')
    })
    expect(onSessionEnd).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('terminateAgent throws when the coordinator DELETE fails', async () => {
    const { terminateAgent } = await import('../../../../packages/sdk/ts/src/coordinator.js')
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await expect(terminateAgent(client, 'tok', 'zone-1', 'agent-9')).rejects.toThrow(/coordinator DELETE .* failed: 404 not found/)
  })
})

describe('session reliability', () => {
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
      const result = session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => 'ok')
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(result).resolves.toBe('ok')
      expect(spawnCalls).toBe(2)
      expect(keys[0]).toBeTruthy()
      expect(keys[1]).toBe(keys[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a 4xx rejection', async () => {
    let spawnCalls = 0
    const fetchImpl = (async () => {
      spawnCalls += 1
      return new Response('bad request', { status: 400 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    await expect(
      session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => 'ok'),
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
      session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => 'result'),
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
        session({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' }, async () => {
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
      const svc = await startSession({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok' })
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
      const svc = await startSession({ coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', onLeaseLost })
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
      const svc = await startSession({
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
    const svc = await startSession({
      coordinator: client,
      zoneId: 'zone-1',
      applicationId: 'app-1',
      subjectToken: 'tok',
      heartbeatIntervalMs: 0,
    })
    await expect(svc.close()).resolves.toBeUndefined()
  })

  it('does not report onLeaseLost for a heartbeat racing close', async () => {
    vi.useFakeTimers()
    try {
      let resolveBeat: ((r: Response) => void) | undefined
      const fetchImpl = (async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname
        if (init.method === 'DELETE') return new Response(null, { status: 204 })
        if (path.endsWith('/heartbeat')) {
          return new Promise<Response>((resolve) => {
            resolveBeat = resolve
          })
        }
        return new Response(JSON.stringify({ agent_session_id: 'svc-1' }), { status: 200 })
      }) as unknown as typeof fetch
      const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
      const onLeaseLost = vi.fn()
      const svc = await startSession({
        coordinator: client,
        zoneId: 'zone-1',
        applicationId: 'app-1',
        subjectToken: 'tok',
        heartbeatIntervalMs: 5,
        onLeaseLost,
      })
      await vi.advanceTimersByTimeAsync(6)
      const closing = svc.close()
      resolveBeat?.(new Response('{"error":"agent_not_found"}', { status: 404 }))
      await closing
      await vi.advanceTimersByTimeAsync(20)
      expect(onLeaseLost).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs onSessionEnd exactly once before terminating on close', async () => {
    const order: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'DELETE') {
        order.push('terminate')
        return new Response(null, { status: 204 })
      }
      if (new URL(url).pathname.endsWith('/agents')) {
        return new Response(JSON.stringify({ agent_session_id: 'svc-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
    const svc = await startSession({
      coordinator: client,
      zoneId: 'zone-1',
      applicationId: 'app-1',
      subjectToken: 'tok',
      heartbeatIntervalMs: 0,
      onSessionEnd: async () => {
        order.push('end')
      },
    })
    await svc.close()
    await svc.close()
    expect(order).toEqual(['end', 'terminate'])
  })

  it('aborts a session retry backoff when the signal fires', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let spawnCalls = 0
      const fetchImpl = (async () => {
        spawnCalls += 1
        return new Response('unavailable', { status: 503 })
      }) as unknown as typeof fetch
      const client: CoordinatorClient = { baseUrl: 'http://coord', fetchImpl }
      const result = session(
        { coordinator: client, zoneId: 'zone-1', applicationId: 'app-1', subjectToken: 'tok', signal: controller.signal },
        async () => 'ok',
      )
      const expectation = expect(result).rejects.toThrow('cancelled')
      await vi.advanceTimersByTimeAsync(0)
      controller.abort(new Error('cancelled'))
      await expectation
      expect(spawnCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
