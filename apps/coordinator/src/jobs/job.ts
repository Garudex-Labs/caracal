// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared interval-job infrastructure for coordinator background workers.

import { newTraceContext, runWithTrace, withTimeout } from '@caracalai/core'

export interface JobLogger {
  error: (obj: object, msg?: string) => void
}

export interface JobHandle {
  stop: () => Promise<void>
}

const JOB_STOP_TIMEOUT_MS = 5_000

export function makeIntervalJob(
  run: () => Promise<unknown>,
  intervalMs: number,
  onError: (err: unknown) => void,
): JobHandle {
  let running = false
  let stopped = false
  let pending: Promise<unknown> = Promise.resolve()

  const tick = (): void => {
    if (stopped || running) return
    running = true
    pending = runWithTrace(newTraceContext(), run)
      .catch(onError)
      .finally(() => {
        running = false
      })
  }

  const timer = setInterval(tick, intervalMs)
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await withTimeout(
        pending,
        JOB_STOP_TIMEOUT_MS,
        `background job did not stop within ${JOB_STOP_TIMEOUT_MS}ms`,
      ).catch(onError)
    },
  }
}
