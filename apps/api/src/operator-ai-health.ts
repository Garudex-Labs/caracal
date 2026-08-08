// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Passive Operator provider-health observations, stored in Redis and exposed without probes.

import type { RedisClient } from './redis.js'
import {
  OPERATOR_AI_ERROR_CLASSES,
  type OperatorAiErrorClass,
  type ProviderConfig,
  type ProviderHealthObserver,
} from './operator-gateway.js'

const HEALTH_KEY_PREFIX = 'api:operator_ai_health:v1:'
const RECORD_HEALTH_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
if ARGV[1] == 'success' then
  redis.call('HSET', KEYS[1], 'last_ok_ms', now_ms)
else
  redis.call('HSET', KEYS[1], 'last_error_ms', now_ms, 'last_error_class', ARGV[2])
end
return now_ms
`

export interface ProviderHealthObservation {
  lastOkAt: string | null
  lastErrorAt: string | null
  lastErrorClass: OperatorAiErrorClass | null
}

export interface OperatorAiHealthStore extends ProviderHealthObserver {
  read(providerIds: string[]): Promise<Map<string, ProviderHealthObservation>>
}

type HealthLogger = {
  warn(bindings: object, message: string): void
}

function healthKey(providerId: string): string {
  return `${HEALTH_KEY_PREFIX}${Buffer.from(providerId).toString('base64url')}`
}

function isoTimestamp(value: string | null): string | null {
  if (value === null) return null
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  const timestamp = new Date(milliseconds)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null
}

function errorClass(value: string | null): OperatorAiErrorClass | null {
  return OPERATOR_AI_ERROR_CLASSES.includes(value as OperatorAiErrorClass) ? (value as OperatorAiErrorClass) : null
}

function reportWriteFailure(logger: HealthLogger | undefined, providerId: string, err: unknown): void {
  logger?.warn({ err, provider_id: providerId }, 'operator AI provider health observation could not be recorded')
}

export function createOperatorAiHealthStore(redis: RedisClient, logger?: HealthLogger): OperatorAiHealthStore {
  const record = (providerId: string, outcome: 'success' | 'failure', errorClass: string): void => {
    try {
      void redis
        .eval(RECORD_HEALTH_LUA, 1, healthKey(providerId), outcome, errorClass)
        .catch((err: unknown) => reportWriteFailure(logger, providerId, err))
    } catch (err) {
      reportWriteFailure(logger, providerId, err)
    }
  }

  return {
    recordSuccess(providerId) {
      record(providerId, 'success', '')
    },

    recordFailure(providerId, errorClass) {
      record(providerId, 'failure', errorClass)
    },

    async read(providerIds) {
      const uniqueIds = [...new Set(providerIds)]
      const rows = await Promise.all(
        uniqueIds.map(async (providerId) => {
          const [lastOkMs, lastErrorMs, lastErrorClass] = await redis.hmget(
            healthKey(providerId),
            'last_ok_ms',
            'last_error_ms',
            'last_error_class',
          )
          const lastErrorAt = isoTimestamp(lastErrorMs)
          return [
            providerId,
            {
              lastOkAt: isoTimestamp(lastOkMs),
              lastErrorAt,
              lastErrorClass: lastErrorAt === null ? null : (errorClass(lastErrorClass) ?? 'unknown_error'),
            },
          ] as const
        }),
      )
      return new Map(rows)
    },
  }
}

function escapePrometheusLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
}

function timestampSeconds(value: string | null): number {
  if (value === null) return 0
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0
}

export function renderOperatorAiHealthMetrics(
  providers: ProviderConfig[],
  observations: ReadonlyMap<string, ProviderHealthObservation>,
): string {
  const uniqueProviders = [...new Map(providers.map((provider) => [provider.id, provider])).values()]
  const success = [
    '# HELP caracal_operator_ai_provider_last_success_timestamp_seconds Unix timestamp of the most recent successful real request to an Operator AI provider, or 0 if none.',
    '# TYPE caracal_operator_ai_provider_last_success_timestamp_seconds gauge',
  ]
  const failure = [
    '# HELP caracal_operator_ai_provider_last_failure_timestamp_seconds Unix timestamp of the most recent failed real request to an Operator AI provider, or 0 if none.',
    '# TYPE caracal_operator_ai_provider_last_failure_timestamp_seconds gauge',
  ]
  for (const provider of uniqueProviders) {
    const observation = observations.get(provider.id)
    const providerLabel = escapePrometheusLabel(provider.id)
    success.push(
      `caracal_operator_ai_provider_last_success_timestamp_seconds{provider="${providerLabel}"} ${timestampSeconds(observation?.lastOkAt ?? null)}`,
    )
    failure.push(
      `caracal_operator_ai_provider_last_failure_timestamp_seconds{provider="${providerLabel}",error_class="${observation?.lastErrorClass ?? 'none'}"} ${timestampSeconds(observation?.lastErrorAt ?? null)}`,
    )
  }
  return [...success, ...failure].join('\n')
}
