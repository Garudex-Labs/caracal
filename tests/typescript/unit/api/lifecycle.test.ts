// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the shared ordered ShutdownRegistry teardown.

import { describe, it, expect, vi } from 'vitest'
import { ShutdownRegistry } from '../../../../packages/serverCore/ts/src/lifecycle.js'

function makeRegistry(timeoutMs = 1000) {
  const exit = vi.fn()
  const log = vi.fn()
  const r = new ShutdownRegistry({ timeoutMs, log, exit })
  return { r, exit, log }
}

describe('ShutdownRegistry', () => {
  it('runs registered steps in reverse order', async () => {
    const { r, exit } = makeRegistry()
    const calls: string[] = []
    r.register('a', () => {
      calls.push('a')
    })
    r.register('b', () => {
      calls.push('b')
    })
    r.register('c', () => {
      calls.push('c')
    })
    await r.fire('test')
    expect(calls).toEqual(['c', 'b', 'a'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('continues past failing steps but exits non-zero', async () => {
    const { r, exit } = makeRegistry()
    const calls: string[] = []
    r.register('a', () => {
      calls.push('a')
    })
    r.register('b', () => {
      throw new Error('fail')
    })
    r.register('c', () => {
      calls.push('c')
    })
    await r.fire('test')
    expect(calls).toEqual(['c', 'a'])
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('preserves caller failure code when teardown succeeds', async () => {
    const { r, exit } = makeRegistry()
    r.register('a', () => {})
    await r.fire('startup-failed', 1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('is idempotent: a second fire is a no-op', async () => {
    const { r, exit } = makeRegistry()
    const fn = vi.fn()
    r.register('a', fn)
    await r.fire('first')
    await r.fire('second')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('flips draining true once fire begins', async () => {
    const { r } = makeRegistry()
    expect(r.draining).toBe(false)
    r.register('a', () => {
      expect(r.draining).toBe(true)
    })
    await r.fire('test')
    expect(r.draining).toBe(true)
  })
})
