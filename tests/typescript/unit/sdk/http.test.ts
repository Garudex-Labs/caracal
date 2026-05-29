// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for SDK HTTP context middleware and Fastify hook delegation.

import { describe, it, expect, vi } from 'vitest'
import { caracalContextMiddleware, caracalFastifyHook } from '../../../../packages/sdk/ts/src/http.js'
import type { Caracal } from '../../../../packages/sdk/ts/src/client.js'

function fakeCaracal(impl: Caracal['bindFromHeaders']): Caracal {
  return { bindFromHeaders: impl } as unknown as Caracal
}

describe('caracalContextMiddleware', () => {
  it('binds headers and calls next on success', async () => {
    const bind = vi.fn(async (_headers, cb: () => Promise<void>) => {
      await cb()
    }) as unknown as Caracal['bindFromHeaders']
    const caracal = fakeCaracal(bind)

    const next = vi.fn()
    const mw = caracalContextMiddleware(caracal)
    mw({ headers: { authorization: 'Bearer x' } }, {}, next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1))
    expect(next).toHaveBeenCalledWith()
    expect(bind).toHaveBeenCalledTimes(1)
  })

  it('forwards binding errors to next', async () => {
    const failure = new Error('verify failed')
    const bind = vi.fn(async () => {
      throw failure
    }) as unknown as Caracal['bindFromHeaders']
    const caracal = fakeCaracal(bind)

    const next = vi.fn()
    const mw = caracalContextMiddleware(caracal)
    mw({ headers: {} }, {}, next)
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(failure))
  })
})

describe('caracalFastifyHook', () => {
  it('awaits header binding for the request', async () => {
    const bind = vi.fn(async () => undefined) as unknown as Caracal['bindFromHeaders']
    const caracal = fakeCaracal(bind)

    const hook = caracalFastifyHook(caracal)
    await hook({ headers: { authorization: 'Bearer y' } })
    expect(bind).toHaveBeenCalledTimes(1)
  })

  it('propagates binding rejection', async () => {
    const failure = new Error('bind failed')
    const bind = vi.fn(async () => {
      throw failure
    }) as unknown as Caracal['bindFromHeaders']
    const caracal = fakeCaracal(bind)

    const hook = caracalFastifyHook(caracal)
    await expect(hook({ headers: {} })).rejects.toThrow('bind failed')
  })
})
