// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Console info page tests for field-specific operational copy.

import { describe, expect, it } from 'vitest'
import { fieldInfo } from '../../../../apps/console/src/views/info.ts'

describe('fieldInfo', () => {
  it('describes OAuth authorization endpoints as URLs', () => {
    const info = fieldInfo('authorization endpoint', 'text', 'HTTPS endpoint where users approve delegated access', {
      required: true,
      dependency: 'Shown when kind is oauth2_authorization_code.',
    })

    expect(info.example).toBe('https://login.hooli.example/oauth/authorize')
    expect(info.valid).toContain('Absolute HTTPS URL')
    expect(info.after).toContain('provider consent page')
    expect(info.impact).toContain('OAuth browser authorization redirects')
  })

  it('describes OAuth token endpoints as HTTPS token URLs', () => {
    const info = fieldInfo('token endpoint', 'text', 'HTTPS endpoint where provider tokens are issued or refreshed', {
      required: true,
    })

    expect(info.example).toBe('https://login.hooli.example/oauth/token')
    expect(info.valid).toContain('Absolute HTTPS URL')
    expect(info.after).toContain('exchange or refresh provider tokens')
  })

  it('describes API key header as an HTTP header', () => {
    const info = fieldInfo('API key header', 'text', undefined, {
      key: 'api_key_header',
      required: true,
    })

    expect(info.example).toBe('X-API-Key')
    expect(info.meaning).toContain('HTTP request header')
    expect(info.valid).toContain('HTTP header name')
    expect(info.after).toContain('Gateway uses this formatting')
  })

  it('describes OAuth client fields without name-like fallback examples', () => {
    const clientId = fieldInfo('client ID', 'text', undefined, { key: 'client_id', required: true })
    const allowedHosts = fieldInfo('OAuth token endpoint hosts', 'list', undefined, { key: 'oauth_token_hosts', advanced: true })
    const authMethod = fieldInfo('OAuth client authentication', 'select', undefined, {
      key: 'client_credentials_auth_method',
      options: ['client_secret_basic', 'client_secret_post', 'none'],
      advanced: true,
    })

    expect(clientId.example).toBe('hooli-pipernet-client')
    expect(clientId.valid).toContain('Provider-issued client identifier')
    expect(allowedHosts.example).toBe('login.hooli.example')
    expect(allowedHosts.valid).toContain('DNS hostnames')
    expect(authMethod.example).toBe('client_secret_basic')
    expect(authMethod.impact).toContain('token exchange or refresh fail')
  })

  it('describes gateway binding and audit fields with operational examples', () => {
    const provider = fieldInfo('upstream credential provider', 'text', undefined, { key: 'credential_provider_id', picker: true })
    const gatewayApp = fieldInfo('gateway application', 'text', undefined, { key: 'gateway_application_id', picker: true })
    const requestId = fieldInfo('request ID', 'text', undefined, { key: 'request_id' })

    expect(provider.example).toBe('provider://hooli-pipernet')
    expect(provider.after).toContain('provider binding is valid')
    expect(gatewayApp.example).toBe('app://pipernet-agent')
    expect(gatewayApp.impact).toContain('Gateway-originated upstream access')
    expect(requestId.example).toBe('req_01jz8piper9hooli7n4')
    expect(requestId.valid).toContain('Exact request ID')
  })
})
