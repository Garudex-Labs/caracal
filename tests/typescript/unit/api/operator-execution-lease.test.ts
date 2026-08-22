// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for fail-closed Operator plan-execution lease renewal.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExecutionLeaseGuard } from '../../../../apps/api/src/operator-execution-lease.js'
import type { RedisClient } from '../../../../apps/api/src/redis.js'

function redisWithEval(evalFn: ReturnType<typeof vi.fn>): RedisClient {
  return { eval: evalFn } as unknown as RedisClient
}

afterEach(() => vi.useRealTimers())

describe('Operator execution lease guard', () => {
  it('aborts periodic work when Redis reports that ownership was lost', async () => {
    vi.useFakeTimers()
    const onLoss = vi.fn()
    const evalFn = vi.fn().mockResolvedValue(0)
    const lease = createExecutionLeaseGuard(redisWithEval(evalFn), 'operator:exec:z:c:1', 'owner-a', 1, {
      renewIntervalMs: 100,
      onLoss,
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(lease.signal.aborted).toBe(true)
    expect(lease.lossReason()).toBe('ownership_lost')
    expect(onLoss).toHaveBeenCalledWith('ownership_lost', undefined)
    await vi.advanceTimersByTimeAsync(500)
    expect(evalFn).toHaveBeenCalledTimes(1)
  })

  it('treats a renewal exception as uncertain ownership and aborts', async () => {
    vi.useFakeTimers()
    const error = new Error('redis unavailable')
    const onLoss = vi.fn()
    const evalFn = vi.fn().mockRejectedValue(error)
    const lease = createExecutionLeaseGuard(redisWithEval(evalFn), 'operator:exec:z:c:1', 'owner-a', 1, {
      renewIntervalMs: 100,
      onLoss,
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(lease.signal.aborted).toBe(true)
    expect(lease.lossReason()).toBe('renewal_failed')
    expect(onLoss).toHaveBeenCalledWith('renewal_failed', error)
  })

  it('prevents a former holder from confirming after a competing owner takes the lock', async () => {
    let currentOwner = 'owner-a'
    const evalFn = vi.fn(async (_script: string, _keys: number, _key: string, owner: string) => (owner === currentOwner ? 1 : 0))
    const redis = redisWithEval(evalFn)
    const former = createExecutionLeaseGuard(redis, 'operator:exec:z:c:1', 'owner-a', 60, { renewIntervalMs: 10_000 })
    const competitor = createExecutionLeaseGuard(redis, 'operator:exec:z:c:1', 'owner-b', 60, { renewIntervalMs: 10_000 })

    await expect(former.confirmOwned()).resolves.toBe(true)
    currentOwner = 'owner-b'
    await expect(competitor.confirmOwned()).resolves.toBe(true)
    await expect(former.confirmOwned()).resolves.toBe(false)

    expect(former.signal.aborted).toBe(true)
    expect(competitor.signal.aborted).toBe(false)
    former.stop()
    competitor.stop()
  })

  it('shares concurrent ownership confirmations and stops its timer idempotently', async () => {
    vi.useFakeTimers()
    let resolveCheck: ((value: number) => void) | undefined
    const evalFn = vi.fn(() => new Promise<number>((resolve) => (resolveCheck = resolve)))
    const lease = createExecutionLeaseGuard(redisWithEval(evalFn), 'operator:exec:z:c:1', 'owner-a', 1, { renewIntervalMs: 100 })

    const first = lease.confirmOwned()
    const second = lease.confirmOwned()
    expect(evalFn).toHaveBeenCalledTimes(1)
    resolveCheck?.(1)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    lease.stop()
    lease.stop()
    await expect(lease.confirmOwned()).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(evalFn).toHaveBeenCalledTimes(1)
  })
})
