// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fail-closed ownership guard for an acquired Operator plan-execution lock.

import type { RedisClient } from './redis.js'

const RENEW_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end"

export type ExecutionLeaseLossReason = 'ownership_lost' | 'renewal_failed'

export interface ExecutionLeaseGuard {
  readonly signal: AbortSignal
  confirmOwned(): Promise<boolean>
  lossReason(): ExecutionLeaseLossReason
  stop(): void
}

export interface ExecutionLeaseGuardOptions {
  renewIntervalMs?: number
  onLoss?: (reason: ExecutionLeaseLossReason, error?: unknown) => void
}

// Starts periodic renewal for a lock the caller has already acquired. The same atomic
// compare-and-expire operation is exposed for an immediate pre-mutation ownership check.
// Concurrent timer and dispatch checks share one Redis operation, avoiding overlapping
// renewals while still failing closed on either a mismatch or an error.
export function createExecutionLeaseGuard(
  redis: RedisClient,
  key: string,
  owner: string,
  ttlSeconds: number,
  options: ExecutionLeaseGuardOptions = {},
): ExecutionLeaseGuard {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('Execution lease TTL must be a positive integer')
  const renewIntervalMs = options.renewIntervalMs ?? (ttlSeconds * 1000) / 3
  if (!Number.isFinite(renewIntervalMs) || renewIntervalMs <= 0 || renewIntervalMs >= ttlSeconds * 1000) {
    throw new Error('Execution lease renewal interval must be positive and below its TTL')
  }

  const controller = new AbortController()
  let reason: ExecutionLeaseLossReason = 'ownership_lost'
  let stopped = false
  let inFlight: Promise<boolean> | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const lose = (nextReason: ExecutionLeaseLossReason, error?: unknown): false => {
    if (stopped || controller.signal.aborted) return false
    reason = nextReason
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    controller.abort(nextReason)
    options.onLoss?.(nextReason, error)
    return false
  }

  const renew = async (): Promise<boolean> => {
    if (stopped || controller.signal.aborted) return false
    try {
      const renewed = await redis.eval(RENEW_SCRIPT, 1, key, owner, ttlSeconds)
      if (stopped) return false
      return Number(renewed) === 1 || lose('ownership_lost')
    } catch (error) {
      return lose('renewal_failed', error)
    }
  }

  const confirmOwned = (): Promise<boolean> => {
    if (stopped || controller.signal.aborted) return Promise.resolve(false)
    if (inFlight) return inFlight
    inFlight = renew().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  timer = setInterval(() => void confirmOwned(), renewIntervalMs)
  timer.unref()

  return {
    signal: controller.signal,
    confirmOwned,
    lossReason: () => reason,
    stop(): void {
      if (stopped) return
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
