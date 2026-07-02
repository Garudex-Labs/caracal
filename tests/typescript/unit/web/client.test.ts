// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the web console HTTP client: error taxonomy, request timeout, and cancellation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConsoleApiError, consoleApi } from '../../../../apps/web/src/platform/api/client.ts'

const realFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function eventStreamResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ConsoleApiError taxonomy', () => {
  it('classifies known control-plane states', () => {
    expect(new ConsoleApiError(503, 'control_plane_not_configured').notConfigured).toBe(true)
    expect(new ConsoleApiError(502, 'control_plane_unreachable').unreachable).toBe(true)
    expect(new ConsoleApiError(0, 'timeout').timedOut).toBe(true)
    expect(new ConsoleApiError(0, 'network_error').notConfigured).toBe(false)
  })
})

describe('request success and error mapping', () => {
  it('returns parsed JSON on success and includes credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'z1', name: 'Zone One' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const zone = await consoleApi.zones.get('z1')
    expect(zone).toEqual({ id: 'z1', name: 'Zone One' })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.credentials).toBe('include')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps a structured error body to a ConsoleApiError code', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(404, { error: 'zone_not_found' })) as unknown as typeof fetch
    await expect(consoleApi.zones.get('missing')).rejects.toMatchObject({
      status: 404,
      code: 'zone_not_found',
    })
  })

  it('maps a thrown fetch (offline) to a network_error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(consoleApi.zones.get('z1')).rejects.toMatchObject({ code: 'network_error' })
  })
})

describe('request timeout', () => {
  it('maps an aborted fetch with no caller cancellation to a timeout error', async () => {
    // With no caller signal, an AbortError can only come from the composed request timeout, so
    // the client surfaces it as a reportable `timeout` rather than a silent cancellation.
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException('timeout', 'AbortError')
    }) as unknown as typeof fetch
    await expect(consoleApi.zones.get('z1')).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('request cancellation', () => {
  it('propagates a caller abort as an AbortError, not a reportable failure', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch

    const pending = consoleApi.zones.list(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('operator capabilities', () => {
  it('reports whether the operator service is enabled', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { enabled: false }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const enabled = await consoleApi.operator.status()
    expect(enabled).toBe(false)
    expect(fetchMock.mock.calls[0]![0]).toContain('/v1/operator/status')
  })

  it('reports configured AI providers', async () => {
    const aiStatus = { enabled: true, providers: [{ id: 'primary', model: 'gpt-x', available: true }] }
    const fetchMock = vi.fn(async () => jsonResponse(200, aiStatus))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await consoleApi.operator.aiStatus()
    expect(result).toEqual(aiStatus)
    expect(fetchMock.mock.calls[0]![0]).toContain('/v1/operator/ai/status')
  })

  it('unwraps the capabilities envelope from the live catalog', async () => {
    const capabilities = [
      { id: 'grantAccess', title: 'Grant access', summary: 's', domain: 'grant', mutating: true },
      { id: 'listZones', title: 'List zones', summary: 's', domain: 'zone', mutating: false },
    ]
    const fetchMock = vi.fn(async () => jsonResponse(200, { capabilities }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await consoleApi.operator.capabilities()
    expect(result).toEqual(capabilities)
    expect(fetchMock.mock.calls[0]![0]).toContain('/v1/operator/capabilities')
  })
})

describe('operator plan validation', () => {
  it('posts the proposed plan to the conversation validate endpoint', async () => {
    const validation = {
      ok: true,
      mutating: true,
      mutating_step_count: 1,
      steps: [{ id: 's1', capability: 'createZone', title: 'Create a zone', domain: 'zone', mutating: true }],
      diagnostics: [],
    }
    const fetchMock = vi.fn(async () => jsonResponse(200, validation))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const plan = { summary: 'Stand up prod', steps: [{ id: 's1', capability: 'createZone', args: { name: 'Prod' } }] }
    const result = await consoleApi.operator.validatePlan('z1', 'conv-1', plan)
    expect(result).toEqual(validation)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations/conv-1/plan/validate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(plan)
  })

  it('maps a missing conversation to a ConsoleApiError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(404, { error: 'conversation_not_found' })) as unknown as typeof fetch
    await expect(consoleApi.operator.validatePlan('z1', 'missing', { summary: 'x', steps: [] })).rejects.toMatchObject({
      status: 404,
      code: 'conversation_not_found',
    })
  })
})

describe('operator conversation lifecycle', () => {
  it('lists conversations by following keyset pages', async () => {
    const conv = {
      id: 'conv-1',
      zone_id: 'z1',
      title: 'Connect GitHub',
      status: 'active',
      created_by: 'actor-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      last_activity_at: '2026-01-01T00:00:00Z',
      archived_at: null,
    }
    globalThis.fetch = vi.fn(async () => jsonResponse(200, [conv])) as unknown as typeof fetch
    const rows = await consoleApi.operator.conversations.list('z1')
    expect(rows).toEqual([conv])
  })

  it('passes a search term through to the conversations query', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await consoleApi.operator.conversations.list('z1', { q: 'github' })
    expect(fetchMock.mock.calls[0]![0]).toContain('q=github')
  })

  it('creates a conversation with a title', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { id: 'conv-1', title: 'Audit' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await consoleApi.operator.conversations.create('z1', 'Audit')
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Audit' })
  })

  it('creates an ask-mode conversation when a mode is given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { id: 'conv-1', title: 'Audit', mode: 'ask' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await consoleApi.operator.conversations.create('z1', 'Audit', { mode: 'ask' })
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Audit', mode: 'ask' })
  })

  it('creates a conversation with autopilot engaged when requested', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { id: 'conv-1', title: 'Automate', autopilot: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await consoleApi.operator.conversations.create('z1', 'Automate', { mode: 'agent', autopilot: true })
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Automate', mode: 'agent', autopilot: true })
  })

  it('sets the conversation operation mode through a patch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'conv-1', mode: 'ask' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await consoleApi.operator.conversations.setMode('z1', 'conv-1', 'ask')
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations/conv-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'ask' })
  })

  it('engages autopilot through a patch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'conv-1', autopilot: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await consoleApi.operator.conversations.setAutopilot('z1', 'conv-1', true)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations/conv-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ autopilot: true })
  })

  it('reports autopilot availability from the status probe', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { enabled: true, autopilot: { available: true, capabilities: ['registerApplication'] } }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await consoleApi.operator.autopilotAvailable()).toBe(true)
  })

  it('fetches the working-memory context snapshot', async () => {
    const context = {
      conversation_id: 'conv-1',
      status: 'active',
      turn_count: 3,
      facts: { decided_plans: [], rejected_capabilities: [], applied_change_count: 0, last_error: null },
      latest_plan: null,
      pending_approval: false,
      recent_messages: [],
      last_error: null,
    }
    const fetchMock = vi.fn(async () => jsonResponse(200, context))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await consoleApi.operator.context('z1', 'conv-1')
    expect(result).toEqual(context)
    expect(fetchMock.mock.calls[0]![0]).toContain('/v1/zones/z1/operator-conversations/conv-1/context')
  })

  it('assembles all turns by following after_seq pagination', async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i + 1}`,
      conversation_id: 'conv-1',
      seq: i + 1,
      role: 'user',
      kind: 'message',
      content: {},
      actor_id: 'a',
      created_at: '2026-01-01T00:00:00Z',
    }))
    const secondPage = [
      {
        id: 't201',
        conversation_id: 'conv-1',
        seq: 201,
        role: 'user',
        kind: 'message',
        content: {},
        actor_id: 'a',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, firstPage)).mockResolvedValueOnce(jsonResponse(200, secondPage))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const turns = await consoleApi.operator.listTurns('z1', 'conv-1')
    expect(turns).toHaveLength(201)
    expect(fetchMock.mock.calls[0]![0]).toContain('after_seq=0')
    expect(fetchMock.mock.calls[1]![0]).toContain('after_seq=200')
  })

  it('stops paginating turns after a short page', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, [
        {
          id: 't1',
          conversation_id: 'conv-1',
          seq: 1,
          role: 'user',
          kind: 'message',
          content: {},
          actor_id: 'a',
          created_at: '2026-01-01T00:00:00Z',
        },
      ]),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const turns = await consoleApi.operator.listTurns('z1', 'conv-1')
    expect(turns).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('creates a plan and returns the persisted turn and validation', async () => {
    const body = {
      turn: {
        id: 'turn-2',
        conversation_id: 'conv-1',
        seq: 2,
        role: 'operator',
        kind: 'plan',
        content: {},
        actor_id: 'actor-1',
        created_at: '2026-01-01T00:00:02Z',
      },
      validation: { ok: true, mutating: true, mutating_step_count: 1, steps: [], diagnostics: [] },
    }
    const fetchMock = vi.fn(async () => jsonResponse(201, body))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const plan = {
      summary: 'Connect GitHub',
      steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub', kind: 'oauth2_authorization_code' } }],
    }
    const result = await consoleApi.operator.createPlan('z1', 'conv-1', plan)
    expect(result).toEqual(body)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations/conv-1/plan')
    expect(init.method).toBe('POST')
  })

  it('posts a plan decision', async () => {
    const turn = {
      id: 'turn-3',
      conversation_id: 'conv-1',
      seq: 3,
      role: 'user',
      kind: 'approval',
      content: { plan_seq: 2 },
      actor_id: 'actor-1',
      created_at: '2026-01-01T00:00:03Z',
    }
    const fetchMock = vi.fn(async () => jsonResponse(201, turn))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await consoleApi.operator.decidePlan('z1', 'conv-1', { plan_seq: 2, decision: 'approved' })
    expect(result).toEqual(turn)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations/conv-1/plan/decision')
    expect(JSON.parse(init.body as string)).toEqual({ plan_seq: 2, decision: 'approved' })
  })

  it('maps an already-decided plan to a ConsoleApiError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(409, { error: 'plan_already_decided' })) as unknown as typeof fetch
    await expect(consoleApi.operator.decidePlan('z1', 'conv-1', { plan_seq: 2, decision: 'approved' })).rejects.toMatchObject({
      status: 409,
      code: 'plan_already_decided',
    })
  })

  it('executes an approved plan and returns outputs', async () => {
    const result = {
      ok: true,
      plan_seq: 2,
      executed: [
        {
          id: 'turn-x',
          conversation_id: 'conv-1',
          seq: 5,
          role: 'operator',
          kind: 'execution',
          content: {},
          actor_id: 'actor-1',
          created_at: '2026-01-01T00:00:05Z',
        },
      ],
      outputs: { s1: { zone_id: 'z-new' } },
    }
    const fetchMock = vi.fn(async () => jsonResponse(201, result))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const out = await consoleApi.operator.executePlan('z1', 'conv-1', 2)
    expect(out).toEqual(result)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations/conv-1/plan/execute')
    expect(JSON.parse(init.body as string)).toEqual({ plan_seq: 2 })
  })

  it('maps a non-executable plan to a ConsoleApiError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(422, { error: 'capability_not_executable' })) as unknown as typeof fetch
    await expect(consoleApi.operator.executePlan('z1', 'conv-1', 2)).rejects.toMatchObject({
      status: 422,
      code: 'capability_not_executable',
    })
  })

  it('sends a natural-language message and returns the agent result', async () => {
    const result = {
      intent: 'plan',
      ok: true,
      turn: {
        id: 'turn-2',
        conversation_id: 'conv-1',
        seq: 2,
        role: 'operator',
        kind: 'plan',
        content: {},
        actor_id: 'actor-1',
        created_at: '2026-01-01T00:00:02Z',
      },
      validation: { ok: true, mutating: true, mutating_step_count: 1, steps: [], diagnostics: [] },
      preview: { ok: true, mutating: true, steps: [] },
    }
    const fetchMock = vi.fn(async () => jsonResponse(201, result))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const out = await consoleApi.operator.sendMessage('z1', 'conv-1', 'connect github')
    expect(out).toEqual(result)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain('/v1/zones/z1/operator-conversations/conv-1/message')
    expect(JSON.parse(init.body as string)).toEqual({ message: 'connect github' })
  })

  it('includes the provider when one is chosen for the message', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { intent: 'explain', ok: true, text: 'hi', turn: null }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await consoleApi.operator.sendMessage('z1', 'conv-1', 'why denied', 'anthropic')
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ message: 'why denied', provider: 'anthropic' })
  })

  it('includes durable client and correlation ids when supplied for a message', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(202, {
        intent: 'message_run',
        ok: true,
        duplicate: true,
        message_run: {
          id: 'run-1',
          client_message_id: 'msg-1',
          correlation_id: 'corr-1',
          state: 'waiting_for_model',
          reason: null,
          error_code: null,
          error_detail: null,
          deadline_at: null,
          completed_at: null,
          last_event_seq: 3,
        },
      }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await consoleApi.operator.sendMessage('z1', 'conv-1', 'why denied', undefined, () => {}, undefined, undefined, {
      clientMessageId: 'msg-1',
      correlationId: 'corr-1',
    })
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ message: 'why denied', client_message_id: 'msg-1', correlation_id: 'corr-1' })
    expect(result).toMatchObject({ intent: 'message_run', duplicate: true, message_run: { state: 'waiting_for_model' } })
  })

  it('maps a disabled AI tier on message to a ConsoleApiError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(409, { error: 'ai_unavailable' })) as unknown as typeof fetch
    await expect(consoleApi.operator.sendMessage('z1', 'conv-1', 'hi')).rejects.toMatchObject({
      status: 409,
      code: 'ai_unavailable',
    })
  })

  it('streams progress, reasoning, and answer tokens before the terminal result', async () => {
    const result = { intent: 'explain', ok: true, text: 'Hello world', turn: null }
    const fetchMock = vi.fn(async () =>
      eventStreamResponse([
        'event: stage\ndata: {"stage":"triaging"}\n\n',
        'event: reasoning\ndata: {"text":"checking"}\n\n',
        'event: token\ndata: {"text":"Hello"}\n\n',
        'event: token\ndata: {"text":" world"}\n\n',
        `event: result\ndata: ${JSON.stringify(result)}\n\n`,
      ]),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const stages: string[] = []
    const tokens: string[] = []
    const reasoning: string[] = []

    const out = await consoleApi.operator.sendMessage(
      'z1',
      'conv-1',
      'hi',
      undefined,
      (stage) => stages.push(stage),
      (chunk) => tokens.push(chunk),
      (chunk) => reasoning.push(chunk),
    )

    expect(out).toEqual(result)
    expect(stages).toEqual(['triaging'])
    expect(reasoning).toEqual(['checking'])
    expect(tokens).toEqual(['Hello', ' world'])
  })

  it('maps a terminal SSE error frame to a ConsoleApiError', async () => {
    globalThis.fetch = vi.fn(async () =>
      eventStreamResponse(['event: error\ndata: {"error":"ai_unavailable","status":409}\n\n']),
    ) as unknown as typeof fetch
    await expect(consoleApi.operator.sendMessage('z1', 'conv-1', 'hi')).rejects.toMatchObject({
      status: 409,
      code: 'ai_unavailable',
    })
  })

  it('fails explicitly when an SSE stream ends without a terminal result', async () => {
    globalThis.fetch = vi.fn(async () => eventStreamResponse(['event: token\ndata: {"text":"partial"}\n\n'])) as unknown as typeof fetch
    await expect(consoleApi.operator.sendMessage('z1', 'conv-1', 'hi')).rejects.toMatchObject({
      status: 0,
      code: 'request_failed',
    })
  })
})

describe('read-only system-zone viewer chokepoint', () => {
  function installViewerTab(search: string): void {
    const store = new Map<string, string>()
    ;(globalThis as { window?: unknown }).window = {
      location: { search },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    }
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('blocks a mutating request from the viewer tab without sending it', async () => {
    installViewerTab('?systemZone=1')
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(consoleApi.applications.patch('z1', 'app-1', { name: 'x' })).rejects.toMatchObject({
      status: 403,
      code: 'system_zone_read_only',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks every mutating method from the viewer tab', async () => {
    installViewerTab('?systemZone=1')
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(consoleApi.zones.create({ name: 'n', slug: 's' })).rejects.toMatchObject({ code: 'system_zone_read_only' })
    await expect(consoleApi.applications.delete('z1', 'app-1')).rejects.toMatchObject({ code: 'system_zone_read_only' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still allows reads from the viewer tab', async () => {
    installViewerTab('?systemZone=1')
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'z1', name: 'Zone One' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(consoleApi.zones.get('z1')).resolves.toEqual({ id: 'z1', name: 'Zone One' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not block mutations outside the viewer tab', async () => {
    installViewerTab('')
    const fetchMock = vi.fn(async () => jsonResponse(201, { id: 'app-1' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(consoleApi.applications.create('z1', { name: 'a', registration_method: 'managed' })).resolves.toEqual({ id: 'app-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
