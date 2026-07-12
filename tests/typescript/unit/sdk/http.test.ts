// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for SDK HTTP context middleware and Fastify hook delegation.

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { caracalContextMiddleware, caracalFastifyHook, type FastifyReplyLike } from '../../../../packages/sdk/ts/src/http.js'
import { Caracal } from '../../../../packages/sdk/ts/src/client.js'

function fakeCaracal(impl: Partial<Caracal>): Caracal {
  return impl as unknown as Caracal
}

function fakeReply() {
  const calls: Record<string, unknown[]> = { code: [], header: [], send: [] }
  const reply: FastifyReplyLike = {
    code(status) {
      calls.code.push(status)
      return reply
    },
    header(name, value) {
      calls.header.push([name, value])
      return reply
    },
    send(payload) {
      calls.send.push(payload)
      return undefined
    },
  }
  return { reply, calls }
}

describe('caracalContextMiddleware', () => {
  it('delegates to the client contextMiddleware', () => {
    const middleware = vi.fn()
    const contextMiddleware = vi.fn(() => middleware)
    const caracal = fakeCaracal({ contextMiddleware: contextMiddleware as unknown as Caracal['contextMiddleware'] })

    const opts = { asApplication: true }
    expect(caracalContextMiddleware(caracal, opts)).toBe(middleware)
    expect(contextMiddleware).toHaveBeenCalledWith(opts)
  })
})

describe('caracalFastifyHook', () => {
  it('binds headers and signals done inside the bound scope', async () => {
    const order: string[] = []
    const bind = vi.fn(async (_headers, cb: () => Promise<void>) => {
      order.push('bind')
      await cb()
      order.push('unbind')
    }) as unknown as Caracal['bindFromHeaders']
    const caracal = fakeCaracal({ bindFromHeaders: bind })

    const done = vi.fn(() => order.push('done'))
    const hook = caracalFastifyHook(caracal)
    hook({ headers: { authorization: 'Bearer y' } }, fakeReply().reply, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(done).toHaveBeenCalledWith()
    expect(order).toEqual(['bind', 'done', 'unbind'])
  })

  it('answers boundary failures with a 401 reply', async () => {
    const bind = vi.fn(async () => {
      throw new Error('verify failed')
    }) as unknown as Caracal['bindFromHeaders']
    const caracal = fakeCaracal({ bindFromHeaders: bind })

    const done = vi.fn()
    const { reply, calls } = fakeReply()
    const hook = caracalFastifyHook(caracal)
    hook({ headers: {} }, reply, done)
    await vi.waitFor(() => expect(calls.send).toHaveLength(1))
    expect(done).not.toHaveBeenCalled()
    expect(calls.code).toEqual([401])
    expect(calls.header).toEqual([['content-type', 'application/json']])
    expect(calls.send[0]).toContain('"error":"unauthorized"')
  })

  it('routes errors raised after entry through done', async () => {
    const failure = new Error('handler blew up')
    const bind = vi.fn(async (_headers, cb: () => Promise<void>) => {
      await cb()
      throw failure
    }) as unknown as Caracal['bindFromHeaders']
    const caracal = fakeCaracal({ bindFromHeaders: bind })

    const done = vi.fn()
    const { reply, calls } = fakeReply()
    const hook = caracalFastifyHook(caracal)
    hook({ headers: { authorization: 'Bearer y' } }, reply, done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(failure))
    expect(calls.send).toHaveLength(0)
  })

  it('preserves isolated ambient context across real Fastify async handlers', async () => {
    const caracal = new Caracal({
      coordinator: { baseUrl: 'http://coordinator' },
      zoneId: 'local-zone',
      applicationId: 'local-app',
      subjectToken: 'root-token',
    })
    const app = Fastify()
    app.addHook(
      'onRequest',
      caracalFastifyHook(caracal, {
        verify: async (token) => {
          await new Promise((resolve) => setImmediate(resolve))
          return { zoneId: 'verified-zone', applicationId: 'verified-app', sessionId: token, hop: 1 }
        },
      }),
    )
    app.get('/context', async () => {
      await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      return { sessionId: caracal.current()?.sessionId }
    })

    const responses = await Promise.all(
      ['session-a', 'session-b', 'session-c'].map((token) =>
        app.inject({ method: 'GET', url: '/context', headers: { authorization: `Bearer ${token}` } }),
      ),
    )

    expect(responses.map((response) => response.json().sessionId)).toEqual(['session-a', 'session-b', 'session-c'])
    expect(caracal.current()).toBeUndefined()
    await app.close()
  })
})
