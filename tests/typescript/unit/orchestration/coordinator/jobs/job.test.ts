// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interval job tests for bounded shutdown behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIntervalJob } from '../../../../../../apps/coordinator/src/jobs/job.js'

describe('makeIntervalJob', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports an error when an in-flight tick does not stop before the shutdown timeout', async () => {
    const onError = vi.fn()
    const job = makeIntervalJob(() => new Promise(() => {}), 100, onError)

    await vi.advanceTimersByTimeAsync(100)
    const stopped = job.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    await stopped

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'background job did not stop within 5000ms',
      }),
    )
  })
})
