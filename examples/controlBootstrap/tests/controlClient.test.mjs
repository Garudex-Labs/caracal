// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Offline tests for the Control API client and bootstrap/teardown flows using a deterministic mock fetch.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createControlClient, ControlError } from '../controlClient.mjs'
import { bootstrap } from '../bootstrap.mjs'
import { teardown } from '../teardown.mjs'
import { PROVIDER, RESOURCE, POLICY } from '../provisionPlan.mjs'

const BASE_CONFIG = {
  stsUrl: 'http://sts.example',
  controlUrl: 'http://control.example',
  audience: 'caracal-control',
  zoneId: 'zone_pied_piper_production',
  clientId: 'app_pipernet_bootstrap',
  clientSecret: 'secret-value',
  scopes: ['control:resource:write', 'control:policy:write'],
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function tokenResponder() {
  return jsonResponse(200, { access_token: 'jwt-token', token_type: 'Bearer', expires_in: 300 })
}

describe('control client token exchange', () => {
  it('sends the client-credentials form the STS control path expects', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return tokenResponder()
    }
    const client = createControlClient(BASE_CONFIG, { fetch: fetchImpl })
    const token = await client.token()
    assert.equal(token, 'jwt-token')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://sts.example/oauth/2/token')
    assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded')
    const form = new URLSearchParams(calls[0].init.body)
    assert.equal(form.get('grant_type'), 'client_credentials')
    assert.equal(form.get('application_id'), 'app_pipernet_bootstrap')
    assert.equal(form.get('client_secret'), 'secret-value')
    assert.equal(form.get('zone_id'), 'zone_pied_piper_production')
    assert.equal(form.get('resource'), 'caracal-control')
    assert.equal(form.get('scope'), 'control:resource:write control:policy:write')
  })

  it('caches the token across invokes until it expires', async () => {
    let tokenCalls = 0
    const fetchImpl = async (url) => {
      if (url.endsWith('/oauth/2/token')) {
        tokenCalls += 1
        return tokenResponder()
      }
      return jsonResponse(200, { ok: true, result: [] })
    }
    const client = createControlClient(BASE_CONFIG, { fetch: fetchImpl })
    await client.invoke('resource', 'list')
    await client.invoke('policy', 'list')
    assert.equal(tokenCalls, 1)
  })

  it('maps non-2xx responses to ControlError with the status', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/oauth/2/token')) return tokenResponder()
      return jsonResponse(403, { error: 'denied' })
    }
    const client = createControlClient(BASE_CONFIG, { fetch: fetchImpl })
    await assert.rejects(
      () => client.invoke('resource', 'create', { name: 'x' }),
      (err) => err instanceof ControlError && err.status === 403,
    )
  })

  it('requires scopes', () => {
    assert.throws(() => createControlClient({ ...BASE_CONFIG, scopes: [] }, { fetch: tokenResponder }))
  })
})

class FakeZone {
  constructor() {
    this.providers = []
    this.resources = []
    this.policies = []
    this.seq = 0
  }

  id(prefix) {
    this.seq += 1
    return `${prefix}_${this.seq}`
  }

  invoke(command, subcommand, flags) {
    const store = this.store(command)
    if (subcommand === 'list') return [...store]
    if (subcommand === 'create') {
      const record = { id: this.id(command), ...flags }
      store.push(record)
      return record
    }
    if (subcommand === 'delete') {
      const index = store.findIndex((item) => item.id === flags.id)
      if (index >= 0) store.splice(index, 1)
      return undefined
    }
    throw new Error(`unexpected ${command} ${subcommand}`)
  }

  store(command) {
    if (command === 'identity-provider') return this.providers
    if (command === 'resource') return this.resources
    if (command === 'policy') return this.policies
    throw new Error(`unexpected command ${command}`)
  }
}

describe('bootstrap and teardown flow', () => {
  it('creates provider, resource, and policy and links the resource to the provider', async () => {
    const zone = new FakeZone()
    const client = { invoke: (c, s, f) => zone.invoke(c, s, f) }
    const result = await bootstrap(client, () => {})
    assert.equal(zone.providers.length, 1)
    assert.equal(zone.resources.length, 1)
    assert.equal(zone.policies.length, 1)
    assert.equal(zone.providers[0].identifier, PROVIDER.identifier)
    assert.equal(zone.resources[0].identifier, RESOURCE.identifier)
    assert.equal(zone.policies[0].name, POLICY.name)
    assert.equal(zone.resources[0]['credential-provider-id'], result.provider.id)
  })

  it('is idempotent: a second bootstrap creates nothing new', async () => {
    const zone = new FakeZone()
    const client = { invoke: (c, s, f) => zone.invoke(c, s, f) }
    await bootstrap(client, () => {})
    await bootstrap(client, () => {})
    assert.equal(zone.providers.length, 1)
    assert.equal(zone.resources.length, 1)
    assert.equal(zone.policies.length, 1)
  })

  it('teardown removes everything bootstrap created', async () => {
    const zone = new FakeZone()
    const client = { invoke: (c, s, f) => zone.invoke(c, s, f) }
    await bootstrap(client, () => {})
    const removed = await teardown(client, () => {})
    assert.equal(removed.length, 3)
    assert.equal(zone.providers.length, 0)
    assert.equal(zone.resources.length, 0)
    assert.equal(zone.policies.length, 0)
  })
})
