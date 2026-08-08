// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for passive Redis-backed Operator provider-health observations and metrics.

import { describe, expect, it, vi } from 'vitest'
import type { RedisClient } from '../../../../apps/api/src/redis.js'
import type { ProviderConfig } from '../../../../apps/api/src/operator-gateway.js'
import {
  createOperatorAiHealthStore,
  renderOperatorAiHealthMetrics,
  type ProviderHealthObservation,
} from '../../../../apps/api/src/operator-ai-health.js'

function provider(id: string): ProviderConfig {
  return { id, baseUrl: 'https://api.example.com/v1', model: 'gpt-x', timeoutMs: 1000, contextWindow: 0 }
}

describe('Operator AI health Redis store', () => {
  it('preserves the most recent failure when a later real request succeeds', async () => {
    const hashes = new Map<string, Map<string, string>>()
    let now = 1_700_000_000_000
    const redis = {
      eval: vi.fn(async (_script: string, _keys: number, key: string, outcome: string, errorClass: string) => {
        const hash = hashes.get(key) ?? new Map<string, string>()
        now += 1000
        if (outcome === 'success') hash.set('last_ok_ms', String(now))
        else {
          hash.set('last_error_ms', String(now))
          hash.set('last_error_class', errorClass)
        }
        hashes.set(key, hash)
        return now
      }),
      hmget: vi.fn(async (key: string, ...fields: string[]) => {
        const hash = hashes.get(key)
        return fields.map((field) => hash?.get(field) ?? null)
      }),
    } as unknown as RedisClient
    const store = createOperatorAiHealthStore(redis)

    store.recordFailure('primary', 'rate_limited')
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(1))
    store.recordSuccess('primary')
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(2))

    expect(await store.read(['primary'])).toEqual(
      new Map([
        [
          'primary',
          {
            lastOkAt: '2023-11-14T22:13:22.000Z',
            lastErrorAt: '2023-11-14T22:13:21.000Z',
            lastErrorClass: 'rate_limited',
          },
        ],
      ]),
    )
  })

  it('deduplicates reads and returns nulls for providers with no observation', async () => {
    const redis = { hmget: vi.fn(async () => [null, null, null]), eval: vi.fn() } as unknown as RedisClient
    const store = createOperatorAiHealthStore(redis)

    const observations = await store.read(['primary', 'primary'])

    expect(redis.hmget).toHaveBeenCalledTimes(1)
    expect(observations.get('primary')).toEqual({ lastOkAt: null, lastErrorAt: null, lastErrorClass: null })
  })

  it('does not surface malformed timestamps or unbounded Redis error classes', async () => {
    const redis = {
      hmget: vi.fn(async () => ['1e100', '1700000000000', 'provider-controlled-value']),
      eval: vi.fn(),
    } as unknown as RedisClient
    const store = createOperatorAiHealthStore(redis)

    expect((await store.read(['primary'])).get('primary')).toEqual({
      lastOkAt: null,
      lastErrorAt: '2023-11-14T22:13:20.000Z',
      lastErrorClass: 'unknown_error',
    })
  })

  it('logs Redis write failures without rejecting or retaining provider error details', async () => {
    const redisError = new Error('redis unavailable')
    const redis = { eval: vi.fn().mockRejectedValue(redisError), hmget: vi.fn() } as unknown as RedisClient
    const logger = { warn: vi.fn() }
    const store = createOperatorAiHealthStore(redis, logger)

    expect(() => store.recordFailure('primary', 'auth_failed')).not.toThrow()
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1))
    expect(logger.warn).toHaveBeenCalledWith(
      { err: redisError, provider_id: 'primary' },
      'operator AI provider health observation could not be recorded',
    )
    expect(JSON.stringify(redis.eval.mock.calls)).not.toContain('api.example.com')
  })

  it('contains synchronous Redis write failures at the store boundary', () => {
    const redisError = new Error('redis unavailable')
    const redis = {
      eval: vi.fn(() => {
        throw redisError
      }),
      hmget: vi.fn(),
    } as unknown as RedisClient
    const logger = { warn: vi.fn() }
    const store = createOperatorAiHealthStore(redis, logger)

    expect(() => store.recordSuccess('primary')).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(
      { err: redisError, provider_id: 'primary' },
      'operator AI provider health observation could not be recorded',
    )
  })
})

describe('Operator AI health metrics', () => {
  it('renders last-success and last-failure gauges with bounded labels', () => {
    const observations = new Map<string, ProviderHealthObservation>([
      [
        'primary',
        {
          lastOkAt: '2026-08-08T12:00:00.000Z',
          lastErrorAt: '2026-08-08T11:00:00.000Z',
          lastErrorClass: 'timeout',
        },
      ],
    ])

    const metrics = renderOperatorAiHealthMetrics([provider('primary'), provider('never-seen')], observations)

    expect(metrics).toContain('caracal_operator_ai_provider_last_success_timestamp_seconds{provider="primary"} 1786190400')
    expect(metrics).toContain(
      'caracal_operator_ai_provider_last_failure_timestamp_seconds{provider="primary",error_class="timeout"} 1786186800',
    )
    expect(metrics).toContain('caracal_operator_ai_provider_last_success_timestamp_seconds{provider="never-seen"} 0')
    expect(metrics).toContain('caracal_operator_ai_provider_last_failure_timestamp_seconds{provider="never-seen",error_class="none"} 0')
    expect(metrics).not.toContain('gpt-x')
    expect(metrics).not.toContain('api.example.com')
  })

  it('escapes provider label values and emits duplicate provider ids only once', () => {
    const unsafeId = 'provider"\\\nnext'
    const metrics = renderOperatorAiHealthMetrics([provider(unsafeId), provider(unsafeId)], new Map())

    expect(metrics).toContain('provider="provider\\"\\\\\\nnext"')
    expect(metrics.match(/last_success_timestamp_seconds\{provider=/g)).toHaveLength(1)
    expect(metrics.match(/last_failure_timestamp_seconds\{provider=/g)).toHaveLength(1)
  })
})
