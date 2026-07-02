// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the plan credential vault's pure derivations: which fields a step collects and what non-secret config a plan may carry.

import { describe, it, expect } from 'vitest'
import { credentialFieldsFor, planProviderConfigError } from '../../../../apps/api/src/operator-plan-secrets.js'

describe('credentialFieldsFor', () => {
  it('needs nothing for a capability that is not connectProvider', () => {
    expect(credentialFieldsFor('defineResource', { name: 'PiperNet' })).toEqual([])
  })

  it('needs nothing for a credential-free provider kind', () => {
    expect(credentialFieldsFor('connectProvider', { kind: 'caracal_mandate' })).toEqual([])
    expect(credentialFieldsFor('connectProvider', { kind: 'none' })).toEqual([])
  })

  it('needs nothing when the kind is missing or unknown', () => {
    expect(credentialFieldsFor('connectProvider', {})).toEqual([])
    expect(credentialFieldsFor('connectProvider', { kind: 'saml' })).toEqual([])
  })

  it('collects the key for an api_key provider', () => {
    expect(credentialFieldsFor('connectProvider', { kind: 'api_key' })).toEqual(['api_key'])
  })

  it('collects the token for a bearer_token provider', () => {
    expect(credentialFieldsFor('connectProvider', { kind: 'bearer_token' })).toEqual(['bearer_token'])
  })

  it('collects id and secret for an authorization-code client', () => {
    expect(credentialFieldsFor('connectProvider', { kind: 'oauth2_authorization_code' })).toEqual([
      'client_id',
      'client_secret',
    ])
  })

  it('collects only the id for a public authorization-code client', () => {
    expect(
      credentialFieldsFor('connectProvider', {
        kind: 'oauth2_authorization_code',
        config: { client_auth_method: 'none' },
      }),
    ).toEqual(['client_id'])
  })

  it('collects id and private key under private_key_jwt client credentials', () => {
    expect(
      credentialFieldsFor('connectProvider', {
        kind: 'oauth2_client_credentials',
        config: { client_auth_method: 'private_key_jwt' },
      }),
    ).toEqual(['client_id', 'private_key'])
  })

  it('collects id and secret for default client credentials', () => {
    expect(credentialFieldsFor('connectProvider', { kind: 'oauth2_client_credentials' })).toEqual([
      'client_id',
      'client_secret',
    ])
  })
})

describe('planProviderConfigError', () => {
  it('accepts an absent or empty config', () => {
    expect(planProviderConfigError('oauth2_client_credentials', undefined)).toBeNull()
    expect(planProviderConfigError('oauth2_client_credentials', {})).toBeNull()
  })

  it('accepts public settings for the kind', () => {
    expect(
      planProviderConfigError('oauth2_client_credentials', {
        token_endpoint: 'https://login.hooli.example/oauth/token',
        scopes: ['read'],
      }),
    ).toBeNull()
  })

  it('rejects a credential field in plan config', () => {
    expect(
      planProviderConfigError('oauth2_client_credentials', { client_secret: 'hunter2' }),
    ).toMatch(/must not carry client_secret/)
    expect(planProviderConfigError('oauth2_client_credentials', { client_id: 'son-of-anton' })).toMatch(
      /must not carry client_id/,
    )
    expect(planProviderConfigError('api_key', { api_key: 'abc' })).toMatch(/must not carry api_key/)
  })

  it('rejects a key outside the kind public contract', () => {
    expect(planProviderConfigError('api_key', { token_endpoint: 'https://api.pipernet.example' })).toMatch(
      /not a public api_key provider setting/,
    )
  })

  it('rejects config on an invalid kind', () => {
    expect(planProviderConfigError('saml', { token_endpoint: 'https://x.example' })).toMatch(
      /valid provider kind/,
    )
  })
})
