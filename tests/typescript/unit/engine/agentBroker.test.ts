// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the governed agent broker: fail-closed tool hooks and credential-free model forwarding.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentAdapter } from '../../../../packages/engine/src/agentAdapters.js'
import type { ToolDecision } from '../../../../packages/engine/src/agentAdapters.js'
import { startAgentBroker, type AgentBroker, type AgentBrokerOptions } from '../../../../packages/engine/src/agentBroker.js'

const adapter = agentAdapter('claude-code')
let broker: AgentBroker | undefined

afterEach(async () => {
  await broker?.close()
  broker = undefined
})

async function start(overrides: Partial<AgentBrokerOptions> = {}): Promise<AgentBroker> {
  broker = await startAgentBroker({
    adapter,
    decide: async () => ({ allow: true }),
    forward: async () => new Response('{}'),
    ...overrides,
  })
  return broker
}

async function hook(b: AgentBroker, body: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${b.url}${adapter.hookPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  return { status: res.status, json: await res.json() }
}

const toolCall = (tool: unknown) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'ls' } })
const denial = (reason: string) => adapter.hookResponse({ allow: false, reason })

describe('agent broker tool hook', () => {
  it('asks Caracal about the tool scope and allows on a mint', async () => {
    const decide = vi.fn(async (): Promise<ToolDecision> => ({ allow: true }))
    const b = await start({ decide })
    expect(await hook(b, toolCall('Bash'))).toEqual({ status: 200, json: {} })
    expect(decide).toHaveBeenCalledWith('tool:Bash')
  })

  it('answers a rejected decision with an explicit deny naming only the code and request id', async () => {
    const err = Object.assign(new Error('Bearer eyJhbGciOiJFUzI1NiJ9.secret.sig rejected'), {
      code: 'access_denied',
      requestId: 'req-42',
      httpStatus: 403,
    })
    const b = await start({ decide: async () => Promise.reject(err) })
    expect(await hook(b, toolCall('Edit'))).toEqual({ status: 200, json: denial('caracal: access_denied (request_id=req-42)') })
  })

  it('denies when the decision outlives its deadline instead of letting the agent time out open', async () => {
    const b = await start({ decide: () => new Promise(() => {}), decisionTimeoutMs: 50 })
    expect(await hook(b, toolCall('Bash'))).toEqual({ status: 200, json: denial('caracal: tool decision timed out') })
  })

  it('denies payloads it cannot attribute to a tool without asking Caracal', async () => {
    const decide = vi.fn(async (): Promise<ToolDecision> => ({ allow: true }))
    const b = await start({ decide })
    expect(await hook(b, '{not json')).toMatchObject({ status: 200, json: denial('caracal: error') })
    expect(await hook(b, toolCall(undefined))).toEqual({ status: 200, json: denial('caracal: unrecognized tool call') })
    expect(await hook(b, toolCall('Bash tool:Edit'))).toEqual({ status: 200, json: denial('caracal: unrecognized tool call') })
    expect(decide).not.toHaveBeenCalled()
  })

  it('reports every decision to the launcher', async () => {
    const onDecision = vi.fn()
    const b = await start({ decide: async () => ({ allow: false, reason: 'caracal: access_denied' }), onDecision })
    await hook(b, toolCall('WebFetch'))
    expect(onDecision).toHaveBeenCalledWith('WebFetch', { allow: false, reason: 'caracal: access_denied' })
  })

  it('serves nothing outside its per-launch path secret', async () => {
    const decide = vi.fn(async (): Promise<ToolDecision> => ({ allow: true }))
    const b = await start({ decide })
    const origin = new URL(b.url).origin
    const res = await fetch(`${origin}${adapter.hookPath}`, { method: 'POST', body: toolCall('Bash') })
    expect(res.status).toBe(404)
    expect(new URL(b.url).pathname).toMatch(/^\/[0-9a-f]{32}$/)
    expect(decide).not.toHaveBeenCalled()
  })
})

describe('agent broker model forwarding', () => {
  it('forwards method, path, query, and body without agent credentials', async () => {
    const forward = vi.fn(
      async (_path: string, _init: RequestInit) =>
        new Response('{"id":"msg"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const b = await start({ forward })
    const res = await fetch(`${b.url}/model/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'x-api-key': 'sk-agent-supplied',
        authorization: 'Bearer agent',
        'x-caracal-resource': 'resource://hoolibox',
        'anthropic-version': '2023-06-01',
      },
      body: '{"stream":true}',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"id":"msg"}')
    const [path, init] = forward.mock.calls[0]!
    const headers = init.headers as Headers
    expect(path).toBe('/v1/messages?beta=true')
    expect(init.method).toBe('POST')
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('{"stream":true}')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-caracal-resource')).toBe(false)
  })

  it('streams the upstream body and drops headers that break the hop', async () => {
    const forward = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: message_start\n\n'))
            controller.enqueue(new TextEncoder().encode('event: message_stop\n\n'))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream', trailer: 'X-Caracal-Revoked', 'x-request-id': 'gw-1' } },
      )
    const b = await start({ forward })
    const res = await fetch(`${b.url}/model/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-request-id')).toBe('gw-1')
    expect(res.headers.has('trailer')).toBe(false)
    expect(await res.text()).toBe('event: message_start\n\nevent: message_stop\n\n')
  })

  it('answers HEAD probes without a body', async () => {
    const b = await start({ forward: async () => new Response('ignored', { headers: { trailer: 'X-Caracal-Revoked' } }) })
    const res = await fetch(`${b.url}/model/api/hello`, { method: 'HEAD' })
    expect(res.status).toBe(200)
  })

  it('reports Caracal denials as final and other failures as retryable', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'access_denied', requestId: 'req-7', httpStatus: 403 })
    let b = await start({ forward: async () => Promise.reject(denied) })
    let res = await fetch(`${b.url}/model/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'permission_error', message: 'caracal: access_denied (request_id=req-7)' },
    })
    await b.close()

    b = await start({ forward: async () => Promise.reject(new Error('connect ECONNREFUSED')) })
    res = await fetch(`${b.url}/model/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'api_error', message: 'caracal: error' } })
  })
})

describe('agent broker guard readiness', () => {
  const guarded = agentAdapter('openclaw')

  it('refuses model calls until the agent guard reports it loaded', async () => {
    const forward = vi.fn(async () => new Response('{}'))
    const b = await start({ adapter: guarded, forward })
    let res = await fetch(`${b.url}/model/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'permission_error', message: 'caracal: agent guard not loaded' } })
    expect(forward).not.toHaveBeenCalled()

    res = await fetch(`${b.url}${guarded.readyPath}`, { method: 'POST' })
    expect(res.status).toBe(204)
    res = await fetch(`${b.url}/model/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(forward).toHaveBeenCalledOnce()
  })

  it('answers the guard in its own decision format', async () => {
    const b = await start({ adapter: guarded, decide: async () => ({ allow: false, reason: 'caracal: access_denied' }) })
    const res = await fetch(`${b.url}${guarded.hookPath}`, { method: 'POST', body: JSON.stringify({ toolName: 'exec' }) })
    expect(await res.json()).toEqual({ allow: false, reason: 'caracal: access_denied' })
  })
})
