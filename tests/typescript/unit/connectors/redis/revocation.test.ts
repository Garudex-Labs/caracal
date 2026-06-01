// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis revocation connector tests for key lookup and stream consumption.

import { describe, expect, it } from 'vitest'
import { signStream, STREAM_SIG_FIELD } from '../../../../../packages/core/ts/src/crypto.js'
import {
  DELEGATION_INVALIDATION_STREAM,
  RedisDelegationInvalidationConsumer,
  RedisRevocationConsumer,
  RedisRevocationStore,
  REVOCATION_STREAM,
  type RedisStreamResult,
} from '../../../../../packages/connectors/redis/ts/src/revocation.js'

class FakeRedis {
  readonly values = new Map<string, string>()
  readonly acked: string[] = []
  stream: RedisStreamResult | null = null
  pending: [string, string[]][] = []
  failGet = false

  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error('redis down')
    return this.values.get(key) ?? null
  }

  async set(key: string, value: string, _mode: 'PX', _ttlMs: number): Promise<void> {
    this.values.set(key, value)
  }

  async xgroup(): Promise<void> {}

  async xreadgroup(): Promise<RedisStreamResult | null> {
    return this.stream
  }

  async xautoclaim(): Promise<[string, [string, string[]][]]> {
    const pending = this.pending
    this.pending = []
    return ['0-0', pending]
  }

  async xack(_stream: string, _group: string, id: string): Promise<void> {
    this.acked.push(id)
  }
}

describe('RedisRevocationStore', () => {
  it('checks and records revoked sessions in Redis', async () => {
    const redis = new FakeRedis()
    const store = new RedisRevocationStore(redis)

    expect(await store.isRevoked('sid-1')).toBe(false)
    await store.markRevoked('sid-1')

    expect(await store.isRevoked('sid-1')).toBe(true)
  })

  it('fails closed on Redis lookup errors by default', async () => {
    const redis = new FakeRedis()
    redis.failGet = true
    const store = new RedisRevocationStore(redis)

    expect(await store.isRevoked('sid-1')).toBe(true)
  })

  it('tracks the latest delegation graph epoch', async () => {
    const redis = new FakeRedis()
    const store = new RedisRevocationStore(redis)

    await store.markDelegationEpoch('zone1', 7)
    await store.markDelegationEpoch('zone1', 6)

    expect(await store.currentDelegationEpoch('zone1')).toBe(7)
  })
})

describe('RedisRevocationConsumer', () => {
  it('marks signed stream messages and all authority anchors', async () => {
    const redis = new FakeRedis()
    const store = new RedisRevocationStore(redis)
    const key = Buffer.alloc(32, 7)
    const values = {
      zone_id: 'zone1',
      session_id: 'sid-1',
      root_sid: 'root-1',
      agent_session_id: 'agent-1',
      delegation_edge_id: 'edge-1',
      reason: 'grant_revoked',
    }
    const sig = signStream(key, REVOCATION_STREAM, values)
    redis.stream = [[REVOCATION_STREAM, [['1-0', [
      'zone_id', 'zone1',
      'session_id', 'sid-1',
      'root_sid', 'root-1',
      'agent_session_id', 'agent-1',
      'delegation_edge_id', 'edge-1',
      'reason', 'grant_revoked',
      STREAM_SIG_FIELD, sig,
    ]]]]]

    const consumer = new RedisRevocationConsumer(redis, store, {
      consumer: 'resource-1',
      streamHmacKey: key,
      requireSignature: true,
    })

    expect(await consumer.pollOnce()).toBe(1)
    expect(await store.isRevoked('sid-1')).toBe(true)
    expect(await store.isRevoked('root-1')).toBe(true)
    expect(await store.isRevoked('agent-1')).toBe(true)
    expect(await store.isRevoked('edge-1')).toBe(true)
    expect(redis.acked).toEqual(['1-0'])
  })

  it('acks invalid signatures without marking sessions', async () => {
    const redis = new FakeRedis()
    const store = new RedisRevocationStore(redis)
    redis.stream = [[REVOCATION_STREAM, [['1-1', ['session_id', 'sid-2', STREAM_SIG_FIELD, '00']]]]]

    const consumer = new RedisRevocationConsumer(redis, store, {
      consumer: 'resource-1',
      streamHmacKey: Buffer.alloc(32, 7),
      requireSignature: true,
    })

    expect(await consumer.pollOnce()).toBe(1)
    expect(await store.isRevoked('sid-2')).toBe(false)
    expect(redis.acked).toEqual(['1-1'])
  })

  it('replays pending messages before reading new entries', async () => {
    const redis = new FakeRedis()
    const store = new RedisRevocationStore(redis)
    const key = Buffer.alloc(32, 7)
    const values = { zone_id: 'zone1', session_id: 'sid-pending' }
    const sig = signStream(key, REVOCATION_STREAM, values)
    redis.pending = [['0-1', ['zone_id', 'zone1', 'session_id', 'sid-pending', STREAM_SIG_FIELD, sig]]]
    redis.stream = null

    const consumer = new RedisRevocationConsumer(redis, store, {
      consumer: 'resource-1',
      streamHmacKey: key,
      requireSignature: true,
    })

    expect(await consumer.pollOnce()).toBe(1)
    expect(await store.isRevoked('sid-pending')).toBe(true)
    expect(redis.acked).toEqual(['0-1'])
  })
})

describe('RedisDelegationInvalidationConsumer', () => {
  it('marks signed delegation graph epochs', async () => {
    const redis = new FakeRedis()
    const store = new RedisRevocationStore(redis)
    const key = Buffer.alloc(32, 7)
    const values = {
      event: 'edge_revoke',
      zone_id: 'zone1',
      edge_id: 'edge-1',
      epoch: '9',
    }
    const sig = signStream(key, DELEGATION_INVALIDATION_STREAM, values)
    redis.stream = [[DELEGATION_INVALIDATION_STREAM, [['1-0', [
      'event', 'edge_revoke',
      'zone_id', 'zone1',
      'edge_id', 'edge-1',
      'epoch', '9',
      STREAM_SIG_FIELD, sig,
    ]]]]]

    const consumer = new RedisDelegationInvalidationConsumer(redis, store, {
      consumer: 'resource-1',
      streamHmacKey: key,
      requireSignature: true,
    })

    expect(await consumer.pollOnce()).toBe(1)
    expect(await store.currentDelegationEpoch('zone1')).toBe(9)
    expect(redis.acked).toEqual(['1-0'])
  })
})
