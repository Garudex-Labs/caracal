// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis client and event publishing for policy invalidation and session revocation.

import { Redis } from 'ioredis'

export type RedisClient = Redis

export function newRedis(url: string): RedisClient {
  return new Redis(url)
}

export async function publishPolicyInvalidation(
  r: RedisClient,
  zoneId: string,
  policySetVersionId: string,
): Promise<void> {
  await r.xadd(
    'caracal.policy.invalidate',
    '*',
    'zone_id', zoneId,
    'policy_set_version_id', policySetVersionId,
  )
}

export async function publishSessionRevocation(
  r: RedisClient,
  zoneId: string,
  sessionId: string,
): Promise<void> {
  await r.xadd(
    'caracal.sessions.revoke',
    '*',
    'zone_id', zoneId,
    'session_id', sessionId,
  )
}
