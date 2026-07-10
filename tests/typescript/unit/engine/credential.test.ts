// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Engine credential helper tests cover scoped token exchange options.

import { describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../../../packages/engine/src/runtimeConfig.js'

const exchange = vi.hoisted(() => vi.fn())

vi.mock('@caracalai/oauth', () => ({
  OAuthClient: class OAuthClient {
    readonly exchange = exchange
  },
}))

describe('credentialRead', () => {
  it('requires a target resource', async () => {
    const { credentialRead } = await import('../../../../packages/engine/src/credential.js')
    await expect(credentialRead({ cfg: {} as RuntimeConfig, resource: '' })).rejects.toThrow('resource is required')
  })

  it('exchanges application credentials for the requested resource token', async () => {
    exchange.mockResolvedValueOnce({ accessToken: 'resource-token' })
    const { credentialRead } = await import('../../../../packages/engine/src/credential.js')
    const cfg = {
      zone_url: 'https://sts.example.com',
      zone_id: 'z1',
      application_id: 'app-1',
      app_client_secret: 'secret',
    } as RuntimeConfig

    await expect(
      credentialRead({
        cfg,
        resource: 'resource://calendar',
        scopes: ['calendar.read'],
        ttlSeconds: 60,
      }),
    ).resolves.toBe('resource-token')
    expect(exchange).toHaveBeenCalledWith('', 'resource://calendar', {
      clientSecret: 'secret',
      scopes: ['calendar.read'],
      ttlSeconds: 60,
    })
  })

  it('uses the default token TTL when none is provided', async () => {
    exchange.mockResolvedValueOnce({ accessToken: 'default-ttl-token' })
    const { credentialRead } = await import('../../../../packages/engine/src/credential.js')
    const cfg = {
      zone_url: 'https://sts.example.com',
      zone_id: 'z1',
      application_id: 'app-1',
      app_client_secret: 'secret',
    } as RuntimeConfig

    await credentialRead({ cfg, resource: 'resource://files' })

    expect(exchange).toHaveBeenLastCalledWith('', 'resource://files', {
      clientSecret: 'secret',
      scopes: undefined,
      ttlSeconds: 900,
    })
  })
})
