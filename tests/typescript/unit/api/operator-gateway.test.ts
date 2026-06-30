// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator LLM gateway: provider selection, failover, timeout, and key redaction.

import { describe, it, expect, vi } from 'vitest'
import {
  createGateway,
  withUsage,
  preferProvider,
  streamingAnswers,
  GatewayUnavailableError,
  GatewayError,
  GatewayBudgetError,
  type ProviderConfig,
} from '../../../../apps/api/src/operator-gateway.js'
import { ProposedPlan } from '../../../../apps/api/src/operator-capabilities.js'

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'p1', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', timeoutMs: 1000, contextWindow: 0, ...overrides }
}

function chatResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// Builds an OpenAI-compatible streaming response: one chat.completion.chunk per content delta,
// a terminal stop chunk carrying usage, then the [DONE] sentinel, so streamText parses the same
// shape a real provider sends.
function streamResponse(parts: string[], usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  const frames = parts.map(
    (content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
  )
  const stop = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`
  return new Response(frames.join('') + stop + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('gateway status', () => {
  it('reports disabled with no providers', () => {
    const gateway = createGateway([])
    expect(gateway.status()).toEqual({ enabled: false, providers: [] })
  })

  it('reports each provider availability without leaking keys', () => {
    const gateway = createGateway([provider({ id: 'primary', apiKey: 'sk-secret' }), provider({ id: 'broken', baseUrl: '' })])
    const status = gateway.status()
    expect(status.enabled).toBe(true)
    expect(status.providers).toEqual([
      { id: 'primary', model: 'gpt-x', available: true, contextWindow: 0 },
      { id: 'broken', model: 'gpt-x', available: false, contextWindow: 0 },
    ])
    // The serialized status must never contain the key.
    expect(JSON.stringify(status)).not.toContain('sk-secret')
  })
})

describe('gateway complete', () => {
  it('throws GatewayUnavailableError when nothing is configured', async () => {
    const gateway = createGateway([])
    await expect(gateway.complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(GatewayUnavailableError)
  })

  it('calls the OpenAI-compatible endpoint with the bearer key and returns the completion', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK', { prompt_tokens: 3, completion_tokens: 1 }))
    const gateway = createGateway([provider({ apiKey: 'sk-secret' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'ping' }], { maxTokens: 5 })
    expect(result).toMatchObject({ text: 'OK', provider: 'p1', model: 'gpt-x', promptTokens: 3, completionTokens: 1 })
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-x', max_tokens: 5 })
  })

  it('omits the authorization header for a keyless local provider', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const gateway = createGateway(
      [provider({ id: 'local', baseUrl: 'http://localhost:11434/v1', model: 'llama' })],
      fetchMock as unknown as typeof fetch,
    )
    await gateway.complete([{ role: 'user', content: 'ping' }])
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('fails over to the next provider on a 5xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(chatResponse('OK'))
    const gateway = createGateway([provider({ id: 'primary' }), provider({ id: 'secondary' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'ping' }])
    expect(result.provider).toBe('secondary')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails over on a network error', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('connection refused')).mockResolvedValueOnce(chatResponse('OK'))
    const gateway = createGateway([provider({ id: 'primary' }), provider({ id: 'secondary' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'ping' }])
    expect(result.provider).toBe('secondary')
  })

  it('throws GatewayError listing redacted attempts when every provider fails', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    const gateway = createGateway(
      [provider({ id: 'primary', apiKey: 'sk-secret' }), provider({ id: 'secondary', apiKey: 'sk-other' })],
      fetchMock as unknown as typeof fetch,
    )
    const error = await gateway.complete([{ role: 'user', content: 'ping' }]).catch((e) => e)
    expect(error).toBeInstanceOf(GatewayError)
    expect(error.attempts).toHaveLength(2)
    expect(error.attempts.map((a: { provider: string }) => a.provider)).toEqual(['primary', 'secondary'])
    expect(JSON.stringify(error.attempts)).not.toContain('sk-')
  })

  it('treats an empty completion as a failure and fails over', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(chatResponse('')).mockResolvedValueOnce(chatResponse('OK'))
    const gateway = createGateway([provider({ id: 'primary' }), provider({ id: 'secondary' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'ping' }])
    expect(result.provider).toBe('secondary')
  })

  it('aborts a provider that exceeds its timeout and fails over', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      )
      .mockResolvedValueOnce(chatResponse('OK'))
    const gateway = createGateway([provider({ id: 'slow', timeoutMs: 10 }), provider({ id: 'fast' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'ping' }])
    expect(result.provider).toBe('fast')
  })
})

describe('gateway reasoning', () => {
  it('captures the reasoning_content channel and keeps the answer clean', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'It lacks the write scope.', reasoning_content: 'The grant only covers read.' } }],
    })
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'why' }])
    expect(result).toMatchObject({ text: 'It lacks the write scope.', reasoning: 'The grant only covers read.' })
  })

  it('extracts an inline <think> block and strips it from the answer', async () => {
    const fetchMock = vi.fn(async () => chatResponse('<think>Weigh read vs write.</think>It lacks the write scope.'))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'why' }])
    expect(result.text).toBe('It lacks the write scope.')
    expect(result.reasoning).toBe('Weigh read vs write.')
  })

  it('leaves reasoning undefined when the model exposes none', async () => {
    const fetchMock = vi.fn(async () => chatResponse('Plain answer.'))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'why' }])
    expect(result.text).toBe('Plain answer.')
    expect(result.reasoning).toBeUndefined()
  })
})

describe('gateway active model', () => {
  it('reports no active model when no provider is configured', () => {
    expect(createGateway([]).active()).toBeNull()
  })

  it('reports the first available provider model and its context window', () => {
    const gateway = createGateway([
      provider({ id: 'broken', baseUrl: '' }),
      provider({ id: 'primary', model: 'gpt-x', contextWindow: 128000 }),
    ])
    expect(gateway.active()).toEqual({ model: 'gpt-x', contextWindow: 128000 })
  })
})

describe('gateway completeObject', () => {
  const validPlan = { summary: 'Connect GitHub', steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub' } }] }

  function objectResponse(value: unknown, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }], usage }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('returns the schema-validated object with provider attribution and usage', async () => {
    const fetchMock = vi.fn(async () => objectResponse(validPlan, { prompt_tokens: 6, completion_tokens: 2 }))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const result = await gateway.completeObject([{ role: 'user', content: 'connect github' }], ProposedPlan)
    expect(result).toMatchObject({ value: validPlan, provider: 'p1', model: 'gpt-x', promptTokens: 6, completionTokens: 2 })
  })

  it('throws GatewayUnavailableError when nothing is configured', async () => {
    const gateway = createGateway([])
    await expect(gateway.completeObject([{ role: 'user', content: 'hi' }], ProposedPlan)).rejects.toBeInstanceOf(GatewayUnavailableError)
  })

  it('fails over to the next provider when a response does not satisfy the schema', async () => {
    // An empty steps array violates the plan schema, so the first provider's response is
    // rejected and the gateway fails over rather than returning an unvalidated object.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(objectResponse({ summary: 'x', steps: [] }))
      .mockResolvedValueOnce(objectResponse(validPlan))
    const gateway = createGateway([provider({ id: 'primary' }), provider({ id: 'secondary' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.completeObject([{ role: 'user', content: 'connect' }], ProposedPlan)
    expect(result).toMatchObject({ value: validPlan, provider: 'secondary' })
  })

  it('reports redacted attempts when every provider returns an off-schema object', async () => {
    const fetchMock = vi.fn(async () => objectResponse({ summary: 'x', steps: [] }))
    const gateway = createGateway(
      [provider({ id: 'primary', apiKey: 'sk-secret' }), provider({ id: 'secondary', apiKey: 'sk-other' })],
      fetchMock as unknown as typeof fetch,
    )
    const error = await gateway.completeObject([{ role: 'user', content: 'connect' }], ProposedPlan).catch((e) => e)
    expect(error).toBeInstanceOf(GatewayError)
    expect(error.attempts).toHaveLength(2)
    expect(JSON.stringify(error.attempts)).not.toContain('sk-')
  })

  it('tallies usage and honors provider preference', async () => {
    const fetchMock = vi.fn(async () => objectResponse(validPlan, { prompt_tokens: 10, completion_tokens: 4 }))
    const base = createGateway([provider({ id: 'first' }), provider({ id: 'second' })], fetchMock as unknown as typeof fetch)
    const { gateway, usage } = withUsage(preferProvider(base, 'second'))
    const result = await gateway.completeObject([{ role: 'user', content: 'go' }], ProposedPlan)
    expect(result.provider).toBe('second')
    expect(usage()).toMatchObject({ inputTokens: 10, outputTokens: 4 })
  })
})

describe('gateway stream', () => {
  it('streams token deltas to the callback and returns the assembled completion', async () => {
    const fetchMock = vi.fn(async () => streamResponse(['Hel', 'lo'], { prompt_tokens: 3, completion_tokens: 2 }))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const deltas: string[] = []
    const result = await gateway.stream([{ role: 'user', content: 'hi' }], (chunk) => deltas.push(chunk))
    expect(deltas.join('')).toBe('Hello')
    expect(result).toMatchObject({ text: 'Hello', provider: 'p1', model: 'gpt-x', promptTokens: 3, completionTokens: 2 })
  })

  it('fails over to the next provider when a stream yields no text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([]))
      .mockResolvedValueOnce(streamResponse(['done']))
    const gateway = createGateway([provider({ id: 'primary' }), provider({ id: 'secondary' })], fetchMock as unknown as typeof fetch)
    const deltas: string[] = []
    const result = await gateway.stream([{ role: 'user', content: 'hi' }], (chunk) => deltas.push(chunk))
    expect(result.provider).toBe('secondary')
    expect(deltas.join('')).toBe('done')
  })
})

describe('streamingAnswers', () => {
  const validPlan = { summary: 'Connect GitHub', steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub' } }] }

  it('streams a free-text completion through the underlying stream', async () => {
    const fetchMock = vi.fn(async () => streamResponse(['Hi', ' there']))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const deltas: string[] = []
    const wrapped = streamingAnswers(gateway, (chunk) => deltas.push(chunk))
    const result = await wrapped.complete([{ role: 'user', content: 'hi' }])
    expect(deltas.join('')).toBe('Hi there')
    expect(result.text).toBe('Hi there')
  })

  it('leaves completeObject untouched so structured calls never stream', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const deltas: string[] = []
    const wrapped = streamingAnswers(gateway, (chunk) => deltas.push(chunk))
    const result = await wrapped.completeObject([{ role: 'user', content: 'connect github' }], ProposedPlan)
    expect(result.value).toEqual(validPlan)
    expect(deltas).toHaveLength(0)
  })
})

describe('withUsage', () => {
  it('tallies real prompt and completion tokens across calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse('one', { prompt_tokens: 100, completion_tokens: 20 }))
      .mockResolvedValueOnce(chatResponse('two', { prompt_tokens: 30, completion_tokens: 5 }))
    const base = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const { gateway, usage } = withUsage(base)

    expect(usage()).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    await gateway.complete([{ role: 'user', content: 'a' }])
    await gateway.complete([{ role: 'user', content: 'b' }])
    expect(usage()).toMatchObject({ inputTokens: 130, outputTokens: 25 })
  })

  it('records the provider and model that served, tracking a failover across calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse('one'))
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(chatResponse('two'))
    const base = createGateway(
      [provider({ id: 'primary', model: 'gpt-a' }), provider({ id: 'secondary', model: 'gpt-b' })],
      fetchMock as unknown as typeof fetch,
    )
    const { gateway, usage } = withUsage(base)
    await gateway.complete([{ role: 'user', content: 'a' }])
    await gateway.complete([{ role: 'user', content: 'b' }])
    // The first call was served by the primary; the second failed over to the secondary, so both
    // providers are recorded in served order and the last served provider is the secondary.
    expect(usage()).toMatchObject({ provider: 'secondary', model: 'gpt-b', providers: ['primary', 'secondary'] })
  })

  it('reports a null served provider when no completion succeeded', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const base = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const { usage } = withUsage(base, { maxCalls: 1 })
    expect(usage()).toMatchObject({ provider: null, model: null, providers: [] })
  })

  it('treats missing usage as zero without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('no usage'))
    const { gateway, usage } = withUsage(createGateway([provider()], fetchMock as unknown as typeof fetch))
    await gateway.complete([{ role: 'user', content: 'a' }])
    expect(usage()).toMatchObject({ inputTokens: 0, outputTokens: 0 })
  })

  it('enforces the per-turn model-call budget, refusing a call beyond it', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const base = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const { gateway } = withUsage(base, { maxCalls: 2 })
    await gateway.complete([{ role: 'user', content: 'a' }])
    await gateway.complete([{ role: 'user', content: 'b' }])
    // The third call is refused before reaching a provider, so only two requests were made.
    await expect(gateway.complete([{ role: 'user', content: 'c' }])).rejects.toBeInstanceOf(GatewayBudgetError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('counts text and object completions against one shared budget', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const base = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const { gateway } = withUsage(base, { maxCalls: 1 })
    await gateway.complete([{ role: 'user', content: 'a' }])
    await expect(gateway.completeObject([{ role: 'user', content: 'b' }], ProposedPlan)).rejects.toBeInstanceOf(GatewayBudgetError)
  })

  it('imposes no budget when maxCalls is absent or zero', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const base = createGateway([provider()], fetchMock as unknown as typeof fetch)
    const { gateway } = withUsage(base, { maxCalls: 0 })
    for (let i = 0; i < 5; i += 1) await gateway.complete([{ role: 'user', content: 'x' }])
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
})

describe('gateway governance', () => {
  it('clamps a completion output request down to the Caracal ceiling', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch, { maxOutputTokens: 256, maxCallsPerTurn: 0 })
    await gateway.complete([{ role: 'user', content: 'hi' }], { maxTokens: 5000 })
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(256)
  })

  it('sets the ceiling when a completion left the output open', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch, { maxOutputTokens: 256, maxCallsPerTurn: 0 })
    await gateway.complete([{ role: 'user', content: 'hi' }])
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(256)
  })

  it('leaves a request below the ceiling unchanged', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch, { maxOutputTokens: 4096, maxCallsPerTurn: 0 })
    await gateway.complete([{ role: 'user', content: 'hi' }], { maxTokens: 600 })
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(600)
  })

  it('applies the ceiling to structured completions too', async () => {
    const validPlan = { summary: 'Connect GitHub', steps: [{ id: 's1', capability: 'connectProvider', args: { name: 'GitHub' } }] }
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch, { maxOutputTokens: 128, maxCallsPerTurn: 0 })
    await gateway.completeObject([{ role: 'user', content: 'connect github' }], ProposedPlan, { maxTokens: 9000 })
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(128)
  })

  it('does not constrain output when no governance ceiling is configured', async () => {
    const fetchMock = vi.fn(async () => chatResponse('OK'))
    const gateway = createGateway([provider()], fetchMock as unknown as typeof fetch)
    await gateway.complete([{ role: 'user', content: 'hi' }], { maxTokens: 5000 })
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(5000)
  })
})

describe('provider preference', () => {
  it('tries the preferred provider before the failover order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('OK'))
    const gateway = createGateway([provider({ id: 'first' }), provider({ id: 'second' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'hi' }], {
      preferredProvider: 'second',
    })
    expect(result.provider).toBe('second')
  })

  it('ignores a preference for an unknown provider and uses the normal order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('OK'))
    const gateway = createGateway([provider({ id: 'first' }), provider({ id: 'second' })], fetchMock as unknown as typeof fetch)
    const result = await gateway.complete([{ role: 'user', content: 'hi' }], {
      preferredProvider: 'missing',
    })
    expect(result.provider).toBe('first')
  })

  it('preferProvider injects the preference into every completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('OK'))
    const base = createGateway([provider({ id: 'first' }), provider({ id: 'second' })], fetchMock as unknown as typeof fetch)
    const preferred = preferProvider(base, 'second')
    const result = await preferred.complete([{ role: 'user', content: 'hi' }])
    expect(result.provider).toBe('second')
  })

  it('preferProvider with a null id is a passthrough', () => {
    const base = createGateway([provider()])
    expect(preferProvider(base, null)).toBe(base)
  })
})
