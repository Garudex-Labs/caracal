// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for Gateway benchmark statistics.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { percentile, summarize } from '../../../shared/test-utils/gatewayWeekOneStats.mjs'

test('nearest-rank percentiles preserve tail observations and input order', () => {
  const values = [1000, 2, 3, 1]
  assert.equal(percentile(values, 50), 2)
  assert.equal(percentile(values, 95), 1000)
  assert.equal(percentile([], 99), null)
  assert.deepEqual(values, [1000, 2, 3, 1])
})

test('throughput counts successful actions while failures remain visible', () => {
  const result = summarize(
    [
      { ok: true, status: 200, durationMs: 20 },
      { ok: false, status: 429, durationMs: 1 },
      { ok: false, errorCode: 'timeout', durationMs: 5000 },
    ],
    2000,
  )
  assert.equal(result.successfulRequestsPerSecond, 0.5)
  assert.equal(result.p95Ms, 20)
  assert.equal(result.failed, 2)
  assert.equal(result.statuses['429'], 1)
  assert.equal(result.statuses.timeout, 1)
  assert.equal(summarize([], 1000).p50Ms, null)
})
