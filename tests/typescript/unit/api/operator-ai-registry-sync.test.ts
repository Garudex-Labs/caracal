// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Cross-replica Operator provider-registry convergence and failure observability.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOperatorAiRegistrySync } from '../../../../apps/api/src/operator-ai-registry-sync.js'

interface ProviderSnapshot {
  slug: string
  label: string
  models: string[]
  enabled: boolean
}

function clone(records: ProviderSnapshot[]): ProviderSnapshot[] {
  return records.map((record) => ({ ...record, models: [...record.models] }))
}

function sharedVersionStore() {
  let version: number | null = null
  let getFailure: Error | null = null
  let incrFailure: Error | null = null
  return {
    store: {
      async get() {
        if (getFailure) throw getFailure
        return version === null ? null : String(version)
      },
      async incr() {
        if (incrFailure) throw incrFailure
        version = (version ?? 0) + 1
        return version
      },
    },
    failGet(error: Error | null) {
      getFailure = error
    },
    failIncr(error: Error | null) {
      incrFailure = error
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('operator AI registry replica synchronization', () => {
  it('converges two independent registries after create, update, disable, enable, and delete', async () => {
    vi.useFakeTimers()
    const shared = sharedVersionStore()
    let persisted: ProviderSnapshot[] = []
    let replicaA: ProviderSnapshot[] = []
    let replicaB: ProviderSnapshot[] = []
    const syncA = createOperatorAiRegistrySync({
      redis: shared.store,
      refresh: async () => {
        replicaA = clone(persisted)
      },
    })
    const syncB = createOperatorAiRegistrySync({
      redis: shared.store,
      refresh: async () => {
        replicaB = clone(persisted)
      },
    })
    await syncA.start()
    await syncB.start()

    const mutateOnA = async (records: ProviderSnapshot[]): Promise<void> => {
      persisted = clone(records)
      replicaA = clone(records)
      await syncA.publish()
      await vi.advanceTimersByTimeAsync(4_999)
      expect(replicaB).not.toEqual(replicaA)
      await vi.advanceTimersByTimeAsync(1)
      expect(replicaB).toEqual(replicaA)
    }

    await mutateOnA([{ slug: 'openai', label: 'OpenAI', models: ['gpt-5.5'], enabled: true }])
    await mutateOnA([{ slug: 'openai', label: 'Primary', models: ['gpt-5.4', 'gpt-5.5'], enabled: true }])
    await mutateOnA([{ slug: 'openai', label: 'Primary', models: ['gpt-5.4', 'gpt-5.5'], enabled: false }])
    await mutateOnA([{ slug: 'openai', label: 'Primary', models: ['gpt-5.4', 'gpt-5.5'], enabled: true }])
    await mutateOnA([])

    expect(syncA.status()).toMatchObject({ state: 'healthy', local_version: '5', publish_pending: false })
    expect(syncB.status()).toMatchObject({ state: 'healthy', local_version: '5', observed_version: '5' })
    syncA.stop()
    syncB.stop()
  })

  it('reports a failed publish, keeps it pending, and retries it to convergence', async () => {
    const shared = sharedVersionStore()
    const warn = vi.fn()
    let refreshed = 0
    const writer = createOperatorAiRegistrySync({ redis: shared.store, refresh: async () => {}, logger: { warn } })
    const reader = createOperatorAiRegistrySync({
      redis: shared.store,
      refresh: async () => {
        refreshed += 1
      },
    })
    await writer.poll()
    await reader.poll()
    shared.failIncr(new Error('redis unavailable'))

    await writer.publish()

    expect(writer.status()).toMatchObject({ state: 'error', publish_pending: true, last_error_class: 'publish_failed' })
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_class: 'publish_failed', publish_pending: true }),
      'operator AI registry propagation failed',
    )
    shared.failIncr(null)
    await writer.poll()
    await reader.poll()
    expect(writer.status()).toMatchObject({ state: 'healthy', publish_pending: false, local_version: '1' })
    expect(reader.status()).toMatchObject({ state: 'healthy', local_version: '1' })
    expect(refreshed).toBe(1)
  })

  it('does not acknowledge a failed refresh and retries the same epoch', async () => {
    const shared = sharedVersionStore()
    let failRefresh = true
    let refreshed = 0
    const writer = createOperatorAiRegistrySync({ redis: shared.store, refresh: async () => {} })
    const reader = createOperatorAiRegistrySync({
      redis: shared.store,
      refresh: async () => {
        if (failRefresh) throw new Error('database unavailable')
        refreshed += 1
      },
    })
    await writer.publish()

    await reader.poll()
    expect(reader.status()).toMatchObject({
      state: 'error',
      local_version: null,
      observed_version: '1',
      last_error_class: 'refresh_failed',
    })
    failRefresh = false
    await reader.poll()
    expect(reader.status()).toMatchObject({ state: 'healthy', local_version: '1', observed_version: '1' })
    expect(refreshed).toBe(1)
  })

  it('surfaces version-store read failures without changing the acknowledged version', async () => {
    const shared = sharedVersionStore()
    const warn = vi.fn()
    const sync = createOperatorAiRegistrySync({ redis: shared.store, refresh: async () => {}, logger: { warn } })
    shared.failGet(new Error('redis unavailable'))

    await sync.poll()

    expect(sync.status()).toMatchObject({ state: 'error', local_version: null, last_error_class: 'version_read_failed' })
    expect(warn).toHaveBeenCalledOnce()
  })
})
