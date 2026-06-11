// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the in-memory replay cache: same JTI is rejected within ttl; expiry frees the slot.

import { describe, it, expect, vi } from 'vitest'
import { MemoryReplay, RedisReplay } from '../../../../apps/control/src/replay.js'

describe('MemoryReplay', () => {
  it('rejects a repeated jti', async () => {
    const r = new MemoryReplay(60_000)
    expect(await r.mark('a', undefined)).toBe(true)
    expect(await r.mark('a', undefined)).toBe(false)
  })

  it('honours exp shorter than ttl', async () => {
    const r = new MemoryReplay(60_000)
    const soon = Math.floor(Date.now() / 1000) + 1
    expect(await r.mark('soon', soon)).toBe(true)
    expect(await r.mark('soon', soon)).toBe(false)
  })

  it('fails closed when the token is already expired', async () => {
    const r = new MemoryReplay(60_000)
    const past = Math.floor(Date.now() / 1000) - 10
    expect(await r.mark('expired', past)).toBe(false)
  })

  it('rejects an empty jti so unsigned replays cannot pass', async () => {
    const r = new MemoryReplay(60_000)
    expect(await r.mark('', undefined)).toBe(false)
    expect(await r.mark('', undefined)).toBe(false)
  })
})

describe('RedisReplay', () => {
  it('marks a fresh jti when SET NX succeeds', async () => {
    const set = vi.fn().mockResolvedValue('OK')
    const r = new RedisReplay({ set } as never, 60_000)
    expect(await r.mark('a', undefined)).toBe(true)
    const args = set.mock.calls[0] as unknown[]
    expect(args[0]).toContain('a')
    expect(args).toContain('PX')
    expect(args).toContain('NX')
  })

  it('rejects a jti that already exists (SET NX returns null)', async () => {
    const set = vi.fn().mockResolvedValue(null)
    const r = new RedisReplay({ set } as never, 60_000)
    expect(await r.mark('a', undefined)).toBe(false)
  })

  it('rejects an empty jti without touching redis', async () => {
    const set = vi.fn()
    const r = new RedisReplay({ set } as never, 60_000)
    expect(await r.mark('', undefined)).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('clamps the ttl to the token exp when it is sooner', async () => {
    const set = vi.fn().mockResolvedValue('OK')
    const r = new RedisReplay({ set } as never, 600_000)
    const soonExp = Math.floor(Date.now() / 1000) + 5
    await r.mark('a', soonExp)
    const ttl = (set.mock.calls[0] as number[])[3]
    expect(ttl).toBeLessThanOrEqual(5000)
    expect(ttl).toBeGreaterThan(0)
  })

  it('fails closed when the token exp is already past', async () => {
    const set = vi.fn().mockResolvedValue('OK')
    const r = new RedisReplay({ set } as never, 60_000)
    const pastExp = Math.floor(Date.now() / 1000) - 100
    expect(await r.mark('a', pastExp)).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('fails closed when the max ttl is non-positive', async () => {
    const set = vi.fn()
    const r = new RedisReplay({ set } as never, 0)
    expect(await r.mark('a', undefined)).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('fails closed when redis is unreachable', async () => {
    const set = vi.fn().mockRejectedValue(new Error('redis down'))
    const r = new RedisReplay({ set } as never, 60_000)
    expect(await r.mark('a', undefined)).toBe(false)
  })

  it('pings the underlying client', async () => {
    const ping = vi.fn().mockResolvedValue('PONG')
    const r = new RedisReplay({ ping } as never, 60_000)
    await expect(r.ping()).resolves.toBeUndefined()
    expect(ping).toHaveBeenCalledOnce()
  })
})
