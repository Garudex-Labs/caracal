// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Cross-replica invalidation for the Operator model-provider runtime registry.

import type { RedisClient } from './redis.js'

const REGISTRY_VERSION_KEY = 'api:operator_ai_registry:version:v1'

// A successful lifecycle change is visible to every healthy API replica within this interval.
// This is intentionally much shorter than the credential-rotation cycle and is fixed so a
// deployment cannot accidentally configure an unbounded stale-provider window.
export const OPERATOR_AI_REGISTRY_REFRESH_INTERVAL_MS = 5_000

export type OperatorAiRegistrySyncErrorClass = 'publish_failed' | 'version_read_failed' | 'refresh_failed'

export interface OperatorAiRegistrySyncStatus {
  state: 'unknown' | 'healthy' | 'error'
  refresh_interval_ms: number
  local_version: string | null
  observed_version: string | null
  publish_pending: boolean
  last_success_at: string | null
  last_refresh_at: string | null
  last_error_at: string | null
  last_error_class: OperatorAiRegistrySyncErrorClass | null
}

export interface OperatorAiRegistrySync {
  start(): Promise<void>
  stop(): void
  // Marks a successfully reconciled metadata mutation for the other replicas. A failed publish
  // remains pending and is retried by the poll loop; lifecycle routes do not falsely roll back a
  // mutation that already committed in PostgreSQL and the control plane.
  publish(): Promise<void>
  // Exposed for deterministic operations/tests; the production timer invokes the same path.
  poll(): Promise<void>
  status(): OperatorAiRegistrySyncStatus
}

interface RegistryVersionStore {
  get(key: string): Promise<string | null>
  incr(key: string): Promise<number>
}

interface RegistrySyncLogger {
  warn(bindings: object, message: string): void
}

export interface OperatorAiRegistrySyncOptions {
  redis: Pick<RedisClient, 'get' | 'incr'> | RegistryVersionStore
  refresh: () => Promise<void>
  logger?: RegistrySyncLogger
  intervalMs?: number
  now?: () => Date
}

export function createOperatorAiRegistrySync(options: OperatorAiRegistrySyncOptions): OperatorAiRegistrySync {
  const intervalMs = options.intervalMs ?? OPERATOR_AI_REGISTRY_REFRESH_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let queue = Promise.resolve()
  let syncState: OperatorAiRegistrySyncStatus['state'] = 'unknown'
  let localVersion: string | null = null
  let observedVersion: string | null = null
  let publishPending = false
  let lastSuccessAt: string | null = null
  let lastRefreshAt: string | null = null
  let lastErrorAt: string | null = null
  let lastErrorClass: OperatorAiRegistrySyncErrorClass | null = null

  const recordSuccess = (): void => {
    syncState = 'healthy'
    lastSuccessAt = now().toISOString()
  }

  const recordError = (errorClass: OperatorAiRegistrySyncErrorClass, err: unknown): void => {
    syncState = 'error'
    lastErrorAt = now().toISOString()
    lastErrorClass = errorClass
    options.logger?.warn({ err, error_class: errorClass, publish_pending: publishPending }, 'operator AI registry propagation failed')
  }

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = queue.then(operation, operation)
    queue = result.catch(() => {})
    return result
  }

  const publishPendingVersion = async (): Promise<boolean> => {
    try {
      const version = String(await options.redis.incr(REGISTRY_VERSION_KEY))
      localVersion = version
      observedVersion = version
      publishPending = false
      recordSuccess()
      return true
    } catch (err) {
      recordError('publish_failed', err)
      return false
    }
  }

  const poll = (): Promise<void> =>
    enqueue(async () => {
      if (publishPending && !(await publishPendingVersion())) return

      let remoteVersion: string | null
      try {
        remoteVersion = await options.redis.get(REGISTRY_VERSION_KEY)
        observedVersion = remoteVersion
      } catch (err) {
        recordError('version_read_failed', err)
        return
      }

      if (remoteVersion !== localVersion) {
        try {
          await options.refresh()
          localVersion = remoteVersion
          lastRefreshAt = now().toISOString()
        } catch (err) {
          recordError('refresh_failed', err)
          return
        }
      }
      recordSuccess()
    })

  const schedulePoll = (): void => {
    timer = setTimeout(async () => {
      timer = undefined
      await poll()
      if (started) schedulePoll()
    }, intervalMs)
    timer.unref()
  }

  return {
    async start() {
      if (started) return
      started = true
      await poll()
      if (started) schedulePoll()
    },

    stop() {
      started = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },

    publish() {
      publishPending = true
      return enqueue(async () => {
        await publishPendingVersion()
      })
    },

    poll,

    status() {
      return {
        state: syncState,
        refresh_interval_ms: intervalMs,
        local_version: localVersion,
        observed_version: observedVersion,
        publish_pending: publishPending,
        last_success_at: lastSuccessAt,
        last_refresh_at: lastRefreshAt,
        last_error_at: lastErrorAt,
        last_error_class: lastErrorClass,
      }
    },
  }
}
