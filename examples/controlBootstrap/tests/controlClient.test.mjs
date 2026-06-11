// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Offline tests for the Control API client and the apply, verify, and teardown pipeline using a fake zone.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createControlClient, ControlError } from '../controlClient.mjs'
import { apply } from '../apply.mjs'
import { verify } from '../verify.mjs'
import { teardown } from '../teardown.mjs'
import { AGENT, PROVIDER, RESOURCE, POLICY, SCOPES, sha256Hex } from '../plan.mjs'

const BASE_CONFIG = {
  stsUrl: 'http://sts.example',
  controlUrl: 'http://control.example',
  audience: 'caracal-control',
  clientId: 'app_pipernet_pipeline',
  clientSecret: 'secret-value',
  scopes: SCOPES.verify,
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
    assert.equal(form.get('application_id'), 'app_pipernet_pipeline')
    assert.equal(form.get('client_secret'), 'secret-value')
    assert.equal(form.has('zone_id'), false)
    assert.equal(form.get('resource'), 'caracal-control')
    assert.equal(form.get('scope'), SCOPES.verify.join(' '))
  })

  it('mints a fresh token for each invoke', async () => {
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
    assert.equal(tokenCalls, 2)
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
    this.apps = []
    this.providers = []
    this.resources = []
    this.policies = []
    this.seq = 0
  }

  id(prefix) {
    this.seq += 1
    return `${prefix}_${this.seq}`
  }

  client() {
    return { invoke: (command, subcommand, flags) => this.invoke(command, subcommand, flags ?? {}) }
  }

  invoke(command, subcommand, flags) {
    if (command === 'policy') return this.policy(subcommand, flags)
    const store = this.store(command)
    if (subcommand === 'list') return store.map((item) => ({ ...item }))
    if (subcommand === 'create') {
      const record = { id: this.id(command), ...this.fields(command, flags) }
      store.push(record)
      return { ...record }
    }
    if (subcommand === 'patch') {
      const record = store.find((item) => item.id === flags.id)
      assert.ok(record, `${command} ${flags.id} not found`)
      Object.assign(record, this.fields(command, flags))
      return { ...record }
    }
    if (subcommand === 'delete') {
      const index = store.findIndex((item) => item.id === flags.id)
      if (index >= 0) store.splice(index, 1)
      return undefined
    }
    throw new Error(`unexpected ${command} ${subcommand}`)
  }

  policy(subcommand, flags) {
    if (subcommand === 'list') return this.policies.map(({ versions, ...policy }) => ({ ...policy }))
    if (subcommand === 'get') {
      const record = this.policies.find((item) => item.id === flags.id)
      assert.ok(record, `policy ${flags.id} not found`)
      return { ...record, versions: record.versions.map((version) => ({ ...version })) }
    }
    if (subcommand === 'create') {
      const record = {
        id: this.id('policy'),
        name: flags.name,
        description: flags.description,
        versions: [{ version: 1, content_sha256: sha256Hex(flags.content) }],
      }
      this.policies.push(record)
      return { id: record.id, name: record.name }
    }
    if (subcommand === 'version') {
      const record = this.policies.find((item) => item.id === flags.id)
      assert.ok(record, `policy ${flags.id} not found`)
      record.versions.push({ version: record.versions.length + 1, content_sha256: sha256Hex(flags.content) })
      return { policy_id: record.id, version: record.versions.length }
    }
    if (subcommand === 'delete') {
      const index = this.policies.findIndex((item) => item.id === flags.id)
      if (index >= 0) this.policies.splice(index, 1)
      return undefined
    }
    throw new Error(`unexpected policy ${subcommand}`)
  }

  fields(command, flags) {
    if (command === 'app') return { name: flags.name }
    if (command === 'identity-provider') {
      return { name: flags.name, identifier: flags.identifier, kind: flags.kind }
    }
    return {
      name: flags.name,
      identifier: flags.identifier,
      scopes: flags.scopes,
      upstream_url: flags['upstream-url'],
      credential_provider_id: flags['credential-provider-id'],
    }
  }

  store(command) {
    if (command === 'app') return this.apps
    if (command === 'identity-provider') return this.providers
    if (command === 'resource') return this.resources
    throw new Error(`unexpected command ${command}`)
  }
}

describe('apply', () => {
  it('creates the agent, provider, resource, and policy and links the resource to the provider', async () => {
    const zone = new FakeZone()
    const changes = await apply(zone.client(), () => {})
    assert.deepEqual(changes.map((change) => change.action), ['created', 'created', 'created', 'created'])
    assert.equal(zone.apps[0].name, AGENT.name)
    assert.equal(zone.providers[0].identifier, PROVIDER.identifier)
    assert.equal(zone.resources[0].identifier, RESOURCE.identifier)
    assert.equal(zone.resources[0].credential_provider_id, zone.providers[0].id)
    assert.equal(zone.policies[0].name, POLICY.name)
  })

  it('is idempotent: a second apply changes nothing', async () => {
    const zone = new FakeZone()
    await apply(zone.client(), () => {})
    const changes = await apply(zone.client(), () => {})
    assert.deepEqual(changes.map((change) => change.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged'])
    assert.equal(zone.apps.length, 1)
    assert.equal(zone.providers.length, 1)
    assert.equal(zone.resources.length, 1)
    assert.equal(zone.policies.length, 1)
  })

  it('converges drift: patches the resource and adds a policy version', async () => {
    const zone = new FakeZone()
    await apply(zone.client(), () => {})
    zone.resources[0].scopes = ['pipernet.read']
    zone.resources[0].upstream_url = 'https://stale.pipernet.example'
    zone.policies[0].versions = [{ version: 1, content_sha256: sha256Hex('package caracal.authz\n\ndefault allow := true\n') }]

    const changes = await apply(zone.client(), () => {})
    const byKind = Object.fromEntries(changes.map((change) => [change.kind, change]))
    assert.equal(byKind.resource.action, 'updated')
    assert.deepEqual(byKind.resource.drift, ['scopes', 'upstream_url'])
    assert.equal(byKind.policy.action, 'updated')
    assert.deepEqual(zone.resources[0].scopes, RESOURCE.scopes)
    assert.equal(zone.resources[0].upstream_url, RESOURCE.upstreamUrl)
    assert.equal(zone.policies[0].versions.length, 2)
    assert.equal(zone.policies[0].versions[1].content_sha256, sha256Hex(POLICY.content))
  })
})

describe('verify', () => {
  it('passes when the environment matches the plan', async () => {
    const zone = new FakeZone()
    await apply(zone.client(), () => {})
    const findings = await verify(zone.client(), () => {})
    assert.deepEqual(findings.map((item) => item.status), ['ok', 'ok', 'ok', 'ok'])
  })

  it('reports missing and drifted objects', async () => {
    const zone = new FakeZone()
    await apply(zone.client(), () => {})
    zone.apps.length = 0
    zone.resources[0].scopes = []

    const findings = await verify(zone.client(), () => {})
    const byKind = Object.fromEntries(findings.map((item) => [item.kind, item]))
    assert.equal(byKind.app.status, 'missing')
    assert.equal(byKind.resource.status, 'drifted')
    assert.deepEqual(byKind.resource.drift, ['scopes'])
    assert.equal(byKind.policy.status, 'ok')
  })
})

describe('teardown', () => {
  it('removes everything apply created', async () => {
    const zone = new FakeZone()
    await apply(zone.client(), () => {})
    const removed = await teardown(zone.client(), () => {})
    assert.equal(removed.length, 4)
    assert.equal(zone.apps.length, 0)
    assert.equal(zone.providers.length, 0)
    assert.equal(zone.resources.length, 0)
    assert.equal(zone.policies.length, 0)
  })
})
