// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// a2aCall unit tests: subject token forwarding, error propagation.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { a2aCall } from '../../../../packages/transport/a2a/ts/src/a2a.js'

describe('a2aCall', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('exchanges the subject token and sends a resource token', async () => {
    const captured: { auth?: string; zoneId?: string; applicationId?: string; body?: Record<string, unknown> } = {}
    const fetchMock = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      if (url === 'http://sts:8080/oauth/2/token') {
        const body = opts.body as URLSearchParams
        expect(body.get('subject_token')).toBe('subject-tok')
        expect(body.get('resource')).toBe('http://agent-b:4001')
        expect(body.get('agent_session_id')).toBe('agent-src')
        expect(body.get('delegation_edge_id')).toBe('edge-1')
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'agent-token', expires_in: 900 }),
        }
      }
      const headers = opts.headers as Record<string, string>
      captured.auth = headers['Authorization']
      captured.zoneId = headers['X-Caracal-Zone-Id']
      captured.applicationId = headers['X-Caracal-Application-Id']
      captured.body = JSON.parse(String(opts.body)) as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({ id: 'resp-1', result: 'ok' }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    await a2aCall(
      {
        agentUrl: 'http://agent-b:4001',
        method: 'run',
        params: {},
        requestId: 'req-1',
        agentSessionId: 'agent-src',
        delegationEdgeId: 'edge-1',
      },
      'subject-tok',
      'zone1',
      'app1',
      { stsUrl: 'http://sts:8080' },
    )

    expect(captured.auth).toBe('Bearer agent-token')
    expect(captured.zoneId).toBe('zone1')
    expect(captured.applicationId).toBe('app1')
    expect(captured.body).toMatchObject({ agentSessionId: 'agent-src', delegationEdgeId: 'edge-1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'agent-token', expires_in: 900 }) })
      .mockResolvedValueOnce({ ok: false, status: 403 }))

    await expect(
      a2aCall(
        { agentUrl: 'http://agent-b:4001', method: 'run', params: {}, requestId: 'req-2' },
        'subject-tok',
        'zone1',
        'app1',
        { stsUrl: 'http://sts:8080' },
      ),
    ).rejects.toThrow('A2A call failed: 403')
  })

  it('returns the response body', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'agent-token', expires_in: 900 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'resp-2', result: { data: 42 } }) }))

    const res = await a2aCall(
      { agentUrl: 'http://agent-b:4001', method: 'query', params: { x: 1 }, requestId: 'req-3' },
      'tok',
      'zone1',
      'app2',
      { stsUrl: 'http://sts:8080' },
    )
    expect(res).toEqual({ id: 'resp-2', result: { data: 42 } })
  })

  it('retries transient A2A responses with bounded backoff', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'agent-token', expires_in: 900 }) })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'resp-3', result: 'ok' }) })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const res = await a2aCall(
      { agentUrl: 'http://agent-b:4001', method: 'query', params: {}, requestId: 'req-4' },
      'tok',
      'zone1',
      'app2',
      { stsUrl: 'http://sts:8080', retries: 1, retryBaseMs: 1 },
    )
    expect(res).toEqual({ id: 'resp-3', result: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
