// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for client-side provider configuration validation parity.

import { describe, expect, it } from 'vitest'

import {
  crossFieldIssues,
  normalizeHostList,
  parseParams,
  RESERVED_TOKEN_PARAMS,
  serializeParams,
  stripIdentifierPrefix,
  validateFieldFormat,
  validateIdentifier,
} from '../../../../apps/web/src/components/console/providerValidation.ts'

describe('validateIdentifier', () => {
  it('accepts an empty slug (auto-generated) and a valid slug', () => {
    expect(validateIdentifier('')).toBeUndefined()
    expect(validateIdentifier('hooli-oidc')).toBeUndefined()
  })
  it('rejects values that are not a lowercase slug', () => {
    expect(validateIdentifier('provider://hooli-oidc')).toBeDefined()
    expect(validateIdentifier('Hooli_OIDC')).toBeDefined()
    expect(validateIdentifier('-hooli')).toBeDefined()
  })
})

describe('stripIdentifierPrefix', () => {
  it('removes the locked namespace from pasted full identifiers', () => {
    expect(stripIdentifierPrefix('provider://hooli-oidc')).toBe('hooli-oidc')
    expect(stripIdentifierPrefix('hooli-oidc')).toBe('hooli-oidc')
  })
})

describe('validateFieldFormat', () => {
  it('requires HTTPS for OAuth endpoints', () => {
    expect(validateFieldFormat('token_endpoint', 'https://login.hooli.example/oauth/token')).toBeUndefined()
    expect(validateFieldFormat('token_endpoint', 'http://login.hooli.example/oauth/token')).toBeDefined()
    expect(validateFieldFormat('authorization_endpoint', 'not-a-url')).toBeDefined()
  })
  it('accepts an absolute redirect URI', () => {
    expect(validateFieldFormat('redirect_uri', 'https://caracal.piedpiper.example/cb')).toBeUndefined()
    expect(validateFieldFormat('redirect_uri', '/relative/cb')).toBeDefined()
  })
  it('validates header and scheme tokens', () => {
    expect(validateFieldFormat('header_name', 'X-API-Key')).toBeUndefined()
    expect(validateFieldFormat('header_name', 'bad header')).toBeDefined()
    expect(validateFieldFormat('auth_scheme', 'Bearer')).toBeUndefined()
    expect(validateFieldFormat('auth_scheme', '1Bearer')).toBeDefined()
  })
  it('validates the allowed_token_hosts list', () => {
    expect(validateFieldFormat('allowed_token_hosts', 'github.com, api.github.com')).toBeUndefined()
    expect(validateFieldFormat('allowed_token_hosts', 'github.com, bad host')).toBeDefined()
  })
  it('treats blank values as valid (optional fields)', () => {
    expect(validateFieldFormat('token_endpoint', '')).toBeUndefined()
  })
})

describe('normalizeHostList', () => {
  it('reduces pasted URLs to their bare hostnames', () => {
    expect(normalizeHostList('https://caracalaus.services.ai.azure.com/openai/v1')).toBe(
      'caracalaus.services.ai.azure.com',
    )
    expect(normalizeHostList('https://api.github.com:443/v3?x=1#top')).toBe('api.github.com')
    expect(normalizeHostList('https://user:pass@api.github.com/v3')).toBe('api.github.com')
    expect(normalizeHostList('api.github.com/v3')).toBe('api.github.com')
  })
  it('normalizes each entry of a comma-separated list independently', () => {
    expect(normalizeHostList('https://a.example.com/x, b.example.com')).toBe(
      'a.example.com, b.example.com',
    )
  })
  it('leaves plain hostnames and in-progress typing untouched', () => {
    expect(normalizeHostList('api.github.com')).toBe('api.github.com')
    expect(normalizeHostList('api.github.com, ')).toBe('api.github.com, ')
    expect(normalizeHostList('')).toBe('')
  })
})

describe('parseParams / serializeParams', () => {
  it('parses key=value pairs into a record', () => {
    const result = parseParams('access_type=offline, prompt=consent', new Set())
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ access_type: 'offline', prompt: 'consent' })
  })
  it('rejects reserved parameter names', () => {
    expect(parseParams('grant_type=foo', RESERVED_TOKEN_PARAMS).error).toBeDefined()
  })
  it('rejects malformed entries', () => {
    expect(parseParams('justakey', new Set()).error).toBeDefined()
    expect(parseParams('key=', new Set()).error).toBeDefined()
  })
  it('round-trips through serializeParams', () => {
    const record = { a: '1', b: '2' }
    expect(parseParams(serializeParams(record), new Set()).value).toEqual(record)
  })
})

describe('crossFieldIssues', () => {
  it('forbids private_key_jwt for authorization code providers', () => {
    const issues = crossFieldIssues('oauth2_authorization_code', {
      client_auth_method: 'private_key_jwt',
    })
    expect(issues.some((i) => i.key === 'client_auth_method')).toBe(true)
  })
  it('rejects a client secret alongside private_key_jwt', () => {
    const issues = crossFieldIssues('oauth2_client_credentials', {
      client_auth_method: 'private_key_jwt',
      client_secret: 'shhh',
    })
    expect(issues.some((i) => i.key === 'client_secret')).toBe(true)
  })
  it('requires private_key_jwt when a private key or key id is set', () => {
    expect(
      crossFieldIssues('oauth2_client_credentials', {
        client_auth_method: 'client_secret_basic',
        private_key: '-----BEGIN-----',
      }).some((i) => i.key === 'private_key'),
    ).toBe(true)
    expect(
      crossFieldIssues('oauth2_client_credentials', {
        client_auth_method: 'client_secret_basic',
        key_id: 'kid1',
      }).some((i) => i.key === 'key_id'),
    ).toBe(true)
  })
  it('forbids auth_scheme for query-location API keys', () => {
    const issues = crossFieldIssues('api_key', { auth_location: 'query', auth_scheme: 'ApiKey' })
    expect(issues.some((i) => i.key === 'auth_scheme')).toBe(true)
  })
  it('flags control characters in single-line secrets and leaves PEM keys alone', () => {
    expect(crossFieldIssues('bearer_token', { bearer_token: 'line-one\nline-two' }).some((i) => i.key === 'bearer_token')).toBe(true)
    expect(
      crossFieldIssues('oauth2_client_credentials', {
        grant_type: 'jwt_bearer',
        private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      }),
    ).toEqual([])
  })
  it('flags a credential pasted with the composed authorization scheme attached', () => {
    expect(crossFieldIssues('bearer_token', { bearer_token: 'Bearer hoolibox-token' }).some((i) => i.key === 'bearer_token')).toBe(true)
    expect(
      crossFieldIssues('api_key', {
        header_name: 'Authorization',
        auth_scheme: 'Bearer',
        api_key: 'bearer sk-hooli',
      }).some((i) => i.key === 'api_key'),
    ).toBe(true)
    expect(crossFieldIssues('api_key', { header_name: 'X-Custom-Auth', api_key: 'Bearer raw-value' })).toEqual([])
  })
  it('reports no issues for a valid client-credentials config', () => {
    expect(
      crossFieldIssues('oauth2_client_credentials', {
        client_auth_method: 'client_secret_basic',
        client_secret: 'shhh',
      }),
    ).toEqual([])
  })
  it('forbids combining private_key_jwt with the jwt_bearer grant', () => {
    const issues = crossFieldIssues('oauth2_client_credentials', {
      grant_type: 'jwt_bearer',
      client_auth_method: 'private_key_jwt',
    })
    expect(issues.some((i) => i.key === 'client_auth_method')).toBe(true)
  })
  it('accepts a private key and key id under the jwt_bearer grant without a method change', () => {
    expect(
      crossFieldIssues('oauth2_client_credentials', {
        grant_type: 'jwt_bearer',
        private_key: '-----BEGIN-----',
        key_id: 'kid1',
      }),
    ).toEqual([])
  })
  it('ties the client certificate to the private_key_jwt method', () => {
    const issues = crossFieldIssues('oauth2_client_credentials', {
      client_auth_method: 'client_secret_basic',
      client_secret: 'shhh',
      certificate: '-----BEGIN CERTIFICATE-----',
    })
    expect(issues.some((i) => i.key === 'certificate')).toBe(true)
  })
})

describe('validateFieldFormat certificate', () => {
  it('requires PEM certificate framing', () => {
    expect(validateFieldFormat('certificate', '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----')).toBeUndefined()
    expect(validateFieldFormat('certificate', 'not a certificate')).toBeDefined()
    expect(validateFieldFormat('certificate', '')).toBeUndefined()
  })
})
