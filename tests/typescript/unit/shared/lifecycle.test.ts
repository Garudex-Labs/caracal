// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the shared graceful shutdown registry.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShutdownRegistry } from '../../../../packages/core/ts/src/lifecycle.js'

type LogCall = { level: string; msg: string; meta?: Record<string, unknown> }

function makeRegistry(timeoutMs = 1000) {
  const logs: LogCall[] = []
  const exits: number[] = []
  const reg = new ShutdownRegistry({
    timeoutMs,
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    exit: (code) => exits.push(code),
  })
  return { reg, logs, exits }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ShutdownRegistry', () => {
  it('runs entries in reverse registration order and exits 0', async () => {
    const { reg, exits } = makeRegistry()
    const order: string[] = []
    reg.register('a', () => {
      order.push('a')
    })
    reg.register('b', async () => {
      order.push('b')
    })
    await reg.fire('SIGTERM')
    expect(order).toEqual(['b', 'a'])
    expect(exits).toEqual([0])
  })

  it('exposes the draining flag and ignores a second fire', async () => {
    const { reg, exits } = makeRegistry()
    let ran = 0
    reg.register('once', () => {
      ran++
    })
    expect(reg.draining).toBe(false)
    const first = reg.fire('SIGINT')
    expect(reg.draining).toBe(true)
    await first
    await reg.fire('SIGINT')
    expect(ran).toBe(1)
    expect(exits).toEqual([0])
  })

  it('exits with code 1 when a step throws', async () => {
    const { reg, exits, logs } = makeRegistry()
    reg.register('boom', () => {
      throw new Error('fail')
    })
    await reg.fire('manual')
    expect(exits).toEqual([1])
    expect(logs.some((l) => l.level === 'error' && l.msg === 'shutdown step failed')).toBe(true)
  })

  it('skips remaining steps once the deadline passes', async () => {
    vi.useFakeTimers()
    const { reg, exits, logs } = makeRegistry(50)
    reg.register('first', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    })
    reg.register('slow', async () => {
      vi.advanceTimersByTime(100)
    })
    const p = reg.fire('manual')
    await vi.runAllTimersAsync()
    await p
    expect(logs.some((l) => l.msg === 'shutdown deadline exceeded; skipping remaining')).toBe(true)
    expect(exits.at(-1)).toBe(1)
  })

  it('install is idempotent', () => {
    const { reg } = makeRegistry()
    reg.install([])
    reg.install([])
    expect(reg.draining).toBe(false)
  })

  it('wires signal handlers that fire the registry', async () => {
    const { reg, exits } = makeRegistry()
    let ran = false
    reg.register('cleanup', () => { ran = true })
    reg.install(['SIGUSR2'])
    process.emit('SIGUSR2')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(ran).toBe(true)
    expect(exits).toEqual([0])
    process.removeAllListeners('SIGUSR2')
  })
})
