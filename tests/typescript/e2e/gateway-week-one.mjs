// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Executes real SDK -> STS -> Gateway -> controlled upstream flows and records evidence.
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, totalmem, platform, release } from 'node:os'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { AdminClient, authorGrantsDocument } from '../../../packages/admin/ts/dist/index.js'
import { Authority, Caracal } from '../../../packages/sdk/ts/dist/index.js'
import { summarize } from '../../shared/test-utils/gatewayWeekOneStats.mjs'

const exec = promisify(execFile)
const args = new Set(process.argv.slice(2))
const mode = process.env.CARACAL_WEEK1_MODE ?? 'correctness'
const output = resolve(process.env.CARACAL_WEEK1_OUTPUT ?? '.tmp/task1/live')
const apiUrl = process.env.CARACAL_API_URL ?? 'http://127.0.0.1:3000'
const stsUrl = process.env.CARACAL_STS_URL ?? 'http://127.0.0.1:8080'
const coordinatorUrl = process.env.CARACAL_COORDINATOR_URL ?? 'http://127.0.0.1:4000'
const gatewayUrl = process.env.CARACAL_GATEWAY_URL ?? 'http://127.0.0.1:8081'
const upstreamUrl = process.env.CARACAL_E2E_UPSTREAM_URL ?? 'http://task1-upstream:18080'
const controlUrl = process.env.CARACAL_WEEK1_UPSTREAM_CONTROL ?? 'http://127.0.0.1:18080/__control'
const tokenFile = process.env.CARACAL_ADMIN_TOKEN_FILE
const coordinatorTokenFile = process.env.CARACAL_COORDINATOR_TOKEN_FILE
const metricsTokenFile = process.env.CARACAL_METRICS_TOKEN_FILE
const identities = Number(process.env.CARACAL_WEEK1_IDENTITIES ?? 16)
const timeoutMs = 15_000
const timing = new AsyncLocalStorage()
const runId = `week1-${Date.now()}-${process.pid}`
const readScope = 'reports:read'
const writeScope = 'reports:write'
const results = { runId, mode, correctness: [], benchmarks: [], cleanup: [], startedAt: new Date().toISOString() }
const clients = []
const resources = []
const applications = []
const created = {}
const keepAlive = setInterval(() => {}, 1000)
const providerKey = randomBytes(24).toString('hex')
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

if (!tokenFile) throw new Error('CARACAL_ADMIN_TOKEN_FILE is required')
if (!['correctness', 'benchmark', 'all'].includes(mode)) throw new Error('invalid CARACAL_WEEK1_MODE')
if (!Number.isInteger(identities) || identities < 2 || identities > 32) throw new Error('identities must be between 2 and 32')
await mkdir(output, { recursive: true })
const admin = new AdminClient({
  apiUrl,
  coordinatorUrl,
  retries: 0,
  adminToken: (await readFile(tokenFile, 'utf8')).trim(),
  coordinatorToken: coordinatorTokenFile ? (await readFile(coordinatorTokenFile, 'utf8')).trim() : undefined,
})
const safeError = (error) => ({
  name: error?.name ?? 'Error',
  code: error?.code ?? error?.httpStatus ?? error?.status ?? 'unknown',
  httpStatus: error?.httpStatus,
  message:
    error instanceof assert.AssertionError || /^(timed out waiting|scenario deadline|benchmark stopped)/.test(error?.message ?? '')
      ? error.message
      : undefined,
})
async function persist() {
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2))
}
async function control(config) {
  const response = await fetch(controlUrl, {
    method: config ? 'POST' : 'GET',
    body: config ? JSON.stringify(config) : undefined,
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.status, 200, 'controlled upstream must be available')
  return response.json()
}
async function waitFor(label, fn, milliseconds = 40_000, pollMs = 300) {
  const deadline = performance.now() + milliseconds
  let last
  while (performance.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = safeError(error)
    }
    await sleep(pollMs)
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.code})` : ''}`)
}
async function check(name, fn) {
  const filter = process.env.CARACAL_WEEK1_TEST
  if (filter && !name.includes(filter)) {
    results.excludedScenarios ??= []
    results.excludedScenarios.push(name)
    return
  }
  const start = performance.now()
  let deadline
  try {
    const details = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('scenario deadline exceeded')), 120_000)
      }),
    ])
    results.correctness.push({ name, passed: true, durationMs: performance.now() - start, details })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.correctness.push({
      name,
      passed: false,
      durationMs: performance.now() - start,
      error: safeError(error),
      details: error?.weekOneDetails,
    })
    console.log(`FAIL ${name}: ${error?.code ?? error?.name}`)
  }
  clearTimeout(deadline)
  await persist()
}
async function boundedFetch(url, init = {}) {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs), redirect: 'manual' })
  return response
}
async function observedFetch(input, init) {
  const record = timing.getStore()
  const url = new URL(input instanceof Request ? input.url : input)
  const started = performance.now()
  const response = await boundedFetch(input, init)
  if (record) {
    const ms = performance.now() - started
    if (url.origin === new URL(stsUrl).origin) record.mintMs = (record.mintMs ?? 0) + ms
    if (url.origin === new URL(gatewayUrl).origin) record.gatewayMs = (record.gatewayMs ?? 0) + ms
  }
  return response
}
function clientFor(application, resource) {
  const client = Caracal.fromClientSecret({
    apiUrl,
    stsUrl,
    coordinatorUrl,
    gatewayUrl,
    zoneId: created.zone.id,
    applicationId: application.id,
    clientSecret: application.client_secret,
    resources: [{ resourceId: resource.identifier, upstreamPrefix: upstreamUrl }],
    fetchImpl: observedFetch,
  })
  client.config.logger = (message, error) => {
    results.sdkWarnings ??= []
    results.sdkWarnings.push({ message, error: safeError(error) })
  }
  return client
}
async function session(fn, index = 0, afterChild) {
  const client = clientFor(applications[index], resources[index])
  const options = {
    labels: [applications[index].id],
    authority: Authority.narrow([readScope], { resourceId: resources[index].identifier, ttlSeconds: 600 }),
  }
  let bodyEvidence
  try {
    return await client.session(async (parent) => {
      await client.session(async (ctx) => {
        bodyEvidence = await fn(client, resources[index], ctx, parent)
      }, options)
      if (afterChild) {
        const followUp = await client.session((ctx) => afterChild(client, resources[index], ctx, parent), options)
        return { ...bodyEvidence, ...followUp }
      }
      return bodyEvidence
    })
  } catch (error) {
    if (bodyEvidence !== undefined) error.weekOneDetails = { bodyCompleted: true, bodyEvidence, sdkCleanupFailed: true }
    throw error
  } finally {
    await client.close()
  }
}
async function mint(client, resource, ctx, ttlSeconds = 300) {
  // The public SDK exchanger performs the real STS endpoint call. Disable its
  // token cache explicitly: single-use test mandates must not be reused accidentally.
  return client.config.exchanger.mintMandate(resource.identifier, [readScope], {
    sessionId: ctx.sessionId,
    delegationId: ctx.delegationId,
    ttlSeconds,
    cache: false,
  })
}
async function raw(token, resource, path = '/ok', init = {}) {
  const requestId = `${runId}-${randomUUID()}`
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-Caracal-Resource', resource.identifier)
  headers.set('X-Request-Id', requestId)
  const response = await boundedFetch(`${gatewayUrl}${path}`, { ...init, headers })
  const body = await response.text()
  let data
  try {
    data = JSON.parse(body)
  } catch {
    /* Non-JSON upstream bodies are valid. */
  }
  return { status: response.status, requestId, data, bytes: body.length }
}
async function deny(call, statuses = [400, 401, 403]) {
  assert.ok(statuses.includes(call.status), `expected denial; got HTTP ${call.status}`)
  const state = await control()
  assert.equal(state.requests[call.requestId] ?? 0, 0, 'denied request must not reach upstream')
  return { status: call.status, upstreamExecutions: 0 }
}
async function awaitAudit(requestId) {
  return waitFor('correlated decision and action audit', async () => {
    const events = await admin.audit.list(created.zone.id, { request_id: requestId, limit: 100 })
    return events.some((item) => item.event_type === 'gateway_resource_request' && item.decision === 'allow') &&
      events.some((item) => item.event_type === 'token_exchange' && item.decision === 'allow')
      ? events
      : false
  })
}
async function activate(content) {
  const version = await admin.policies.addVersion(created.zone.id, created.policy.id, content)
  const setVersion = await admin.policySets.addVersion(created.zone.id, created.policySet.id, [{ policy_version_id: version.version_id }])
  await activatePolicySetVersion(setVersion.version_id)
}
async function activatePolicySetVersion(versionId) {
  await admin.policySets.activate(created.zone.id, created.policySet.id, versionId)
  await waitFor(
    'policy activation',
    async () => (await admin.policySets.activationStatus(created.zone.id, created.policySet.id, versionId)).propagation_status === 'loaded',
  )
}
const grants = () =>
  applications.map((application, index) => ({
    applicationId: application.id,
    resourceIdentifier: resources[index].identifier,
    scopes: [readScope],
  }))

async function setup() {
  for (const [name, url] of Object.entries({ api: apiUrl, sts: stsUrl, coordinator: coordinatorUrl, gateway: gatewayUrl })) {
    const response = await boundedFetch(`${url}/ready`)
    assert.equal(response.status, 200, `${name} must be ready`)
  }
  await control({ expectedKey: providerKey, reset: true })
  created.zone = await admin.zones.create({ name: 'Gateway Week One', slug: runId })
  created.provider = await admin.providers.create(created.zone.id, {
    name: 'Controlled Week One Provider',
    identifier: 'provider://week-one',
    kind: 'api_key',
    config_json: { header_name: 'X-Week1-Key', api_key: providerKey },
  })
  const operations = ['/ok', '/error', '/drop', '/redirect', '/slow', '/stream', '/quiet-stream'].map((path) => ({
    method: 'GET',
    path,
    scope: readScope,
  }))
  operations.push({ method: 'POST', path: '/ok', scope: writeScope })
  operations.push({ method: 'POST', path: '/upload', scope: readScope })
  for (let index = 0; index < identities; index++) {
    const application = await admin.applications.create(created.zone.id, { name: `Week One ${index}`, registration_method: 'managed' })
    applications.push(application)
    const resource = await admin.resources.create(created.zone.id, {
      name: `Week One Reports ${index}`,
      identifier: `resource://week-one-${index}`,
      upstream_url: upstreamUrl,
      scopes: [readScope, writeScope],
      credential_provider_id: created.provider.id,
      operation_enforcement: 'enforced',
      operations,
    })
    resources.push(resource)
    clients.push(clientFor(application, resource))
  }
  created.policy = await admin.policies.create(created.zone.id, { name: 'Week One Grants', content: authorGrantsDocument(grants()) })
  created.policySet = await admin.policySets.create(created.zone.id, 'Week One Policy Set')
  const version = await admin.policySets.addVersion(created.zone.id, created.policySet.id, [
    { policy_version_id: created.policy.version_id },
  ])
  created.initialPolicySetVersion = version.version_id
  await activatePolicySetVersion(created.initialPolicySetVersion)
  results.fixture = {
    zoneId: created.zone.id,
    identities,
    resources: resources.map((resource) => resource.identifier),
    upstreamUrl,
    providerKind: 'api_key',
  }
}

async function correctness() {
  await check('allowed request injects provider credential and produces audit evidence', () =>
    session(async (client, resource) => {
      const response = await client.fetch(resource.identifier, '/ok', { scopes: [readScope], timeoutMs })
      const body = await response.json()
      assert.equal(response.status, 200)
      assert.equal(body.credentialInjected, true)
      assert.equal(body.headersSanitized, true)
      const requestId = response.headers.get('x-request-id')
      assert.ok(requestId)
      const events = await awaitAudit(requestId)
      return { status: 200, providerCredentialInjected: true, auditEventTypes: [...new Set(events.map((event) => event.event_type))] }
    }),
  )
  await check('missing bearer denied before upstream', () => raw('', resources[0]).then(deny))
  await check('malformed bearer denied before upstream', () => raw('invalid', resources[0]).then(deny))
  await check('forged signature denied before upstream', () =>
    session(async (client, resource, ctx) => {
      const mandate = await mint(client, resource, ctx)
      const parts = mandate.token.split('.')
      const signature = Buffer.from(parts[2], 'base64url')
      signature[0] ^= 1
      parts[2] = signature.toString('base64url')
      return deny(await raw(parts.join('.'), resource))
    }),
  )
  await check('single-use mandate replay denied without duplicate execution', () =>
    session(async (client, resource, ctx) => {
      const mandate = await mint(client, resource, ctx)
      const first = await raw(mandate.token, resource)
      assert.equal(first.status, 200)
      const second = await raw(mandate.token, resource)
      await deny(second)
      return { firstStatus: first.status, replayStatus: second.status, upstreamExecutions: 1 }
    }),
  )
  await check('wrong resource denied before upstream', () =>
    session(async (client, resource, ctx) => deny(await raw((await mint(client, resource, ctx)).token, resources[1]))),
  )
  await check('unmapped operation denied before upstream', () =>
    session(async (client, resource, ctx) => deny(await raw((await mint(client, resource, ctx)).token, resource, '/forbidden'))),
  )
  await check('double-encoded path traversal denied before upstream', () =>
    session(async (client, resource, ctx) => deny(await raw((await mint(client, resource, ctx)).token, resource, '/%252e%252e/ok'))),
  )
  await check('read mandate cannot execute write operation', () =>
    session(async (client, resource, ctx) =>
      deny(await raw((await mint(client, resource, ctx)).token, resource, '/ok', { method: 'POST', body: '{}' })),
    ),
  )
  await check('scope escalation rejected by real STS', () =>
    session(async (client, resource) => {
      let denied = false
      try {
        await client.mintMandate(resource.identifier, [writeScope])
      } catch (error) {
        assert.ok(
          ['access_denied', 'invalid_scope', 'insufficient_scope'].includes(error?.code),
          'scope test must receive an authorization denial, not a transport failure',
        )
        denied = true
      }
      assert.equal(denied, true, 'ungranted write scope must not mint')
      return { denied: true }
    }),
  )
  await check('valid near-expiry and expired mandates denied', () =>
    session(async (client, resource, ctx) => {
      const mandate = await mint(client, resource, ctx, 2)
      const claims = JSON.parse(Buffer.from(mandate.token.split('.')[1], 'base64url').toString())
      assert.ok(claims.exp * 1000 - Date.now() < 35_000, 'STS must issue a genuinely short-lived token for this test')
      const near = await raw(mandate.token, resource)
      await deny(near)
      await sleep(Math.max(0, claims.exp * 1000 - Date.now()) + 200)
      const expired = await raw(mandate.token, resource)
      await deny(expired)
      return { nearExpiryStatus: near.status, expiredStatus: expired.status }
    }),
  )
  await check('cross-zone application authentication rejected', async () => {
    const other = await admin.zones.create({ name: 'Week One Other Zone', slug: `${runId}-other` })
    try {
      const form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        zone_id: created.zone.id,
        application_id: applications[0].id,
        client_secret: applications[0].client_secret,
        resource: resources[0].identifier,
        scope: 'agent:lifecycle',
      })
      const positive = await boundedFetch(`${stsUrl}/oauth/2/token`, { method: 'POST', body: form })
      await positive.arrayBuffer()
      assert.equal(positive.status, 200, 'same-zone lifecycle exchange must succeed before testing another zone')
      form.set('zone_id', other.id)
      const response = await boundedFetch(`${stsUrl}/oauth/2/token`, { method: 'POST', body: form })
      await response.arrayBuffer()
      assert.ok([401, 403].includes(response.status), 'other zone must reject this application credential')
      return { positiveStatus: positive.status, status: response.status }
    } finally {
      await admin.zones.delete(other.id)
    }
  })
  await check('upstream 503 preserved without retry', () =>
    session(async (client, resource) => {
      const response = await client.fetch(resource.identifier, '/error', { scopes: [readScope], timeoutMs })
      await response.arrayBuffer()
      const requestId = response.headers.get('x-request-id')
      assert.equal(response.status, 503)
      assert.equal((await control()).requests[requestId], 1)
      return { status: response.status, upstreamExecutions: 1 }
    }),
  )
  await check('upstream connection failure returns gateway error', () =>
    session(async (client, resource) => {
      const response = await client.fetch(resource.identifier, '/drop', { scopes: [readScope], timeoutMs })
      await response.arrayBuffer()
      assert.ok([502, 504].includes(response.status))
      assert.equal((await control()).requests[response.headers.get('x-request-id')], 1)
      return { status: response.status }
    }),
  )
  await check('upstream header timeout is bounded by Gateway', () =>
    session(async (client, resource, ctx) => {
      const start = performance.now()
      const response = await raw((await mint(client, resource, ctx)).token, resource, '/slow?ms=35000', {
        signal: AbortSignal.timeout(40_000),
      })
      assert.equal(response.status, 504)
      return { status: response.status, elapsedMs: performance.now() - start }
    }),
  )
  await check('request body limit prevents a complete oversized upstream body', () =>
    session(async (client, resource, ctx) => {
      const response = await raw((await mint(client, resource, ctx)).token, resource, '/upload', {
        method: 'POST',
        body: Buffer.alloc(11 * 1024 * 1024),
      })
      const body = (await control()).bodies[response.requestId]
      const evidence = { status: response.status, upstreamBody: body ?? null, sentBytes: 11 * 1024 * 1024 }
      assert.ok(response.status >= 400, 'oversized request must not complete successfully')
      assert.ok(!body?.complete && (body?.bytes ?? 0) <= 10 * 1024 * 1024, 'upstream must not receive the complete oversized body')
      return evidence
    }),
  )
  await check('unsafe unspecified upstream address rejected', () =>
    session(async (client, resource, ctx) => {
      const mandate = await mint(client, resource, ctx)
      try {
        try {
          await admin.resources.patch(created.zone.id, resource.id, { upstream_url: 'http://0.0.0.0:9' })
        } catch (error) {
          assert.ok([400, 422].includes(error?.status), 'configuration rejection must be a validation error')
          return { rejectedAt: 'configuration', status: error.status }
        }
        const response = await raw(mandate.token, resource)
        return { ...(await deny(response, [400, 401, 403, 502])), rejectedAt: 'governed request' }
      } finally {
        await admin.resources.patch(created.zone.id, resource.id, { upstream_url: upstreamUrl })
      }
    }),
  )
  await check('upstream redirect is returned without following', () =>
    session(async (client, resource) => {
      const before = (await control()).completed
      const response = await client.fetch(resource.identifier, '/redirect', { scopes: [readScope], timeoutMs })
      await response.arrayBuffer()
      assert.equal(response.status, 302)
      assert.equal((await control()).completed - before, 1)
      return { status: 302, upstreamExecutions: 1 }
    }),
  )
  await check('client cancellation aborts a slow governed request', () =>
    session(async (client, resource, ctx) => {
      const mandate = await mint(client, resource, ctx)
      let cancelled = false
      try {
        await raw(mandate.token, resource, '/slow?ms=3000', { signal: AbortSignal.timeout(300) })
      } catch {
        cancelled = true
      }
      assert.equal(cancelled, true)
      await waitFor('upstream cancellation', async () => (await control()).active === 0, 5000)
      return { cancelled: true, upstreamActiveAfterCancellation: 0 }
    }),
  )
  await check('suspended Session revokes a previously minted mandate', () =>
    session(async (client, resource, ctx) => {
      const mandate = await mint(client, resource, ctx)
      const start = performance.now()
      await admin.sessions.suspend(created.zone.id, ctx.sessionId)
      await sleep(1500)
      const result = await deny(await raw(mandate.token, resource))
      return { ...result, observedAfterMs: performance.now() - start }
    }),
  )
  await check('Delegation revocation denies mandate and SDK cleanup completes', () =>
    session(
      async (client, resource, ctx, parent) => {
        const [parentSession, childSession] = await Promise.all(
          [parent.sessionId, ctx.sessionId].map((sessionId) => admin.sessions.get(created.zone.id, sessionId)),
        )
        assert.ok(parentSession.authority_record_id, 'parent must have an authority record')
        assert.equal(parentSession.authority_record_id, childSession.authority_record_id, 'test requires shared authority')
        const mandate = await mint(client, resource, ctx)
        await admin.delegations.revoke(created.zone.id, ctx.delegationId)
        await sleep(1500)
        return deny(await raw(mandate.token, resource))
      },
      0,
      async (client, resource, ctx) => {
        const mandate = await mint(client, resource, ctx)
        const sibling = await raw(mandate.token, resource)
        assert.equal(sibling.status, 200, 'the parent must still be able to delegate to another child')
        return { siblingStatus: sibling.status }
      },
    ),
  )
  await check('active event stream terminates after Session revocation', () =>
    session(async (client, resource, ctx) => {
      const response = await client.fetch(resource.identifier, '/stream', { scopes: [readScope], timeoutMs: 90_000 })
      assert.equal(response.status, 200)
      const reader = response.body.getReader()
      assert.equal((await reader.read()).done, false)
      const start = performance.now()
      await admin.sessions.suspend(created.zone.id, ctx.sessionId)
      const deadline = performance.now() + 75_000
      let ended = false
      let pendingRead
      while (performance.now() < deadline) {
        pendingRead ??= reader.read()
        const part = await Promise.race([pendingRead, sleep(1500).then(() => ({ timeout: true }))])
        if (part.timeout) continue
        pendingRead = undefined
        if (part.done) {
          ended = true
          break
        }
      }
      if (!ended) await reader.cancel()
      const evidence = { ended, observedAfterMs: performance.now() - start, sessionId: ctx.sessionId }
      if (!ended || evidence.observedAfterMs > 10_000) {
        const error = new Error('stream did not terminate within the 10 second investigation threshold')
        error.weekOneDetails = evidence
        throw error
      }
      return evidence
    }),
  )
  await check('quiet event stream closes on suspension and resumed Session can call again', () =>
    session(async (client, resource, ctx) => {
      const response = await client.fetch(resource.identifier, '/quiet-stream', { scopes: [readScope], timeoutMs: 20_000 })
      assert.equal(response.status, 200)
      const reader = response.body.getReader()
      try {
        assert.equal((await reader.read()).done, false)
        const start = performance.now()
        await admin.sessions.suspend(created.zone.id, ctx.sessionId)
        let timer
        try {
          const part = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('quiet stream did not close within 10 seconds')), 10_000)
            }),
          ])
          assert.equal(part.done, true)
        } finally {
          clearTimeout(timer)
        }
        const closedAfterMs = performance.now() - start
        await admin.sessions.resume(created.zone.id, ctx.sessionId)
        const mandate = await mint(client, resource, ctx)
        const resumed = await raw(mandate.token, resource)
        assert.equal(resumed.status, 200)
        return { closedAfterMs, resumedStatus: resumed.status }
      } finally {
        await reader.cancel()
      }
    }),
  )
  await check('activated policy denial blocks an already minted mandate', () =>
    session(async (client, resource, ctx) => {
      const mandate = await mint(client, resource, ctx)
      try {
        await activate(authorGrantsDocument(grants().filter((grant) => grant.resourceIdentifier !== resource.identifier)))
        return await deny(await raw(mandate.token, resource))
      } finally {
        await activatePolicySetVersion(created.initialPolicySetVersion)
      }
    }),
  )
  await check('concurrent applications remain isolated', async () => {
    const transports = clients
      .slice(0, Math.min(identities, 8))
      .map((client, index) => client.applicationTransport(resources[index].identifier, { scopes: [readScope], timeoutMs }))
    // Provision each application's Session and Delegation before sending concurrent requests.
    for (const transport of transports) {
      const response = await transport(`${gatewayUrl}/ok`)
      assert.equal(response.status, 200)
      await response.arrayBuffer()
    }
    const responses = await Promise.all(
      transports.map((transport, index) =>
        transport(`${gatewayUrl}/ok`, { headers: { 'X-Caracal-Resource': resources[index].identifier } }),
      ),
    )
    const bodies = await Promise.all(responses.map((response) => response.json()))
    assert.ok(responses.every((response) => response.status === 200))
    assert.ok(bodies.every((body) => body.credentialInjected && body.headersSanitized))
    return { successfulConcurrentApplications: responses.length }
  })
}

async function metrics() {
  if (!metricsTokenFile) return { unavailable: 'CARACAL_METRICS_TOKEN_FILE not provided' }
  const bearer = (await readFile(metricsTokenFile, 'utf8')).trim()
  const snapshots = {}
  for (const [name, url] of Object.entries({
    gateway: gatewayUrl,
    sts: stsUrl,
    audit: process.env.CARACAL_AUDIT_URL ?? 'http://127.0.0.1:9090',
  })) {
    const response = await boundedFetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${bearer}` } })
    snapshots[name] = response.ok ? await response.text() : `HTTP ${response.status}`
  }
  return snapshots
}
async function withResourceSampling(fn) {
  const project = process.env.CARACAL_WEEK1_COMPOSE_PROJECT
  if (!project) throw new Error('benchmark resource sampling requires CARACAL_WEEK1_COMPOSE_PROJECT')
  const names = ['sts', 'gateway', 'postgres', 'redis', 'audit', 'api', 'coordinator'].map((service) => `${project}-${service}-1`)
  const statArgs = ['stats', '--no-stream', '--format', '{{json .}}', ...names]
  const resourceSamples = []
  let observerRedis
  if (process.env.CARACAL_WEEK1_REDIS_URL_FILE) {
    const Redis = createRequire(new URL('../../../apps/coordinator/package.json', import.meta.url))('ioredis')
    const redisUrl = new URL((await readFile(process.env.CARACAL_WEEK1_REDIS_URL_FILE, 'utf8')).trim())
    redisUrl.hostname = process.env.CARACAL_WEEK1_REDIS_HOST ?? '127.0.0.1'
    if (process.env.CARACAL_WEEK1_REDIS_PORT) redisUrl.port = process.env.CARACAL_WEEK1_REDIS_PORT
    observerRedis = new Redis(redisUrl.href, { retryStrategy: null, commandTimeout: 5000, maxRetriesPerRequest: 0 })
    observerRedis.on('error', () => {})
  }
  let sampling = true
  const task = (async () => {
    while (sampling) {
      try {
        const { stdout } = await exec('docker', statArgs, { timeout: 20_000 })
        const containers = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        let auditGroup
        if (observerRedis) {
          const groups = await observerRedis.xinfo('GROUPS', 'caracal.audit.events')
          auditGroup = groups
            .map((fields) =>
              Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]])),
            )
            .find((group) => group.name === 'audit-ingestor')
        }
        resourceSamples.push({ timestamp: new Date().toISOString(), containers, auditGroup })
        const redisMemoryPercent = parseFloat(containers.find((container) => container.Name === `${project}-redis-1`)?.MemPerc ?? '0')
        if (redisMemoryPercent > 85)
          results.stopReason = 'benchmark stopped because Redis exceeded 85 percent of its container memory limit'
      } catch (error) {
        resourceSamples.push({ timestamp: new Date().toISOString(), error: safeError(error) })
      }
      if (sampling) await sleep(3000)
    }
  })()
  const databaseSnapshot = async () => {
    const query =
      'SELECT row_to_json(s) FROM (SELECT datname, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, deadlocks, temp_bytes FROM pg_stat_database WHERE datname=current_database()) s'
    try {
      const { stdout } = await exec(
        'docker',
        ['exec', `${project}-postgres-1`, 'psql', '-X', '-U', 'caracal', '-d', 'caracal', '-At', '-c', query],
        { timeout: 10_000 },
      )
      return JSON.parse(stdout.trim())
    } catch (error) {
      return { unavailable: safeError(error) }
    }
  }
  try {
    results.databaseBefore = await databaseSnapshot()
    await fn()
  } finally {
    sampling = false
    await task
    observerRedis?.disconnect()
    results.databaseAfter = await databaseSnapshot()
    await writeFile(resolve(output, 'resource-samples.json'), JSON.stringify(resourceSamples, null, 2))
  }
}
async function benchmark() {
  const concurrencyLevels = (process.env.CARACAL_WEEK1_CONCURRENCY ?? '1,4,8,16').split(',').map(Number)
  const repeats = Number(process.env.CARACAL_WEEK1_REPEATS ?? 3)
  const durationSeconds = Number(process.env.CARACAL_WEEK1_SECONDS ?? 120)
  const warmupSeconds = Number(process.env.CARACAL_WEEK1_WARMUP_SECONDS ?? 30)
  const soakSeconds = Number(process.env.CARACAL_WEEK1_SOAK_SECONDS ?? 600)
  const soakConcurrency = Number(process.env.CARACAL_WEEK1_SOAK_CONCURRENCY ?? 8)
  const rates = process.env.CARACAL_WEEK1_RATES?.split(',').map(Number)
  const soakRate = Number(process.env.CARACAL_WEEK1_SOAK_RATE ?? rates?.at(-1) ?? 0)
  if (
    ![repeats, durationSeconds, warmupSeconds, soakSeconds, soakConcurrency, ...concurrencyLevels].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new Error('benchmark parameters must be positive')
  if (rates && (rates.length !== concurrencyLevels.length || ![...rates, soakRate].every((rate) => Number.isInteger(rate) && rate > 0)))
    throw new Error('provide one positive integer rate per concurrency level and a positive soak rate')
  const transports = clients.map((client, index) =>
    client.applicationTransport(resources[index].identifier, { scopes: [readScope], timeoutMs }),
  )
  const directSamples = []
  const directStart = performance.now()
  for (let index = 0; index < 500; index++) {
    const start = performance.now()
    const response = await boundedFetch(`${new URL(controlUrl).origin}/ok`, {
      headers: { 'X-Week1-Key': providerKey, 'X-Request-Id': `${runId}-direct-${index}` },
    })
    await response.arrayBuffer()
    directSamples.push({ status: response.status, ok: response.status === 200, durationMs: performance.now() - start })
  }
  results.directUpstreamLatencyControl = {
    ...summarize(directSamples, performance.now() - directStart),
    description:
      '500 sequential requests to the same controlled upstream, without governance; latency control only, not an equivalent capacity comparison',
  }
  await writeFile(resolve(output, 'direct-upstream-samples.json'), JSON.stringify(directSamples))
  async function action(index, prefix) {
    const sample = { requestId: `${prefix}-${randomUUID()}` }
    const start = performance.now()
    await timing.run(sample, async () => {
      try {
        const response = await transports[index](`${gatewayUrl}/ok`, {
          headers: { 'X-Caracal-Resource': resources[index].identifier, 'X-Request-Id': sample.requestId },
        })
        sample.status = response.status
        const body = await response.json()
        sample.ok = response.status === 200 && body.credentialInjected === true
      } catch (error) {
        sample.ok = false
        sample.errorCode = error?.code ?? error?.name ?? 'error'
      }
    })
    sample.durationMs = performance.now() - start
    return sample
  }
  results.benchmarkConfiguration = {
    concurrencyLevels,
    repeats,
    durationSeconds,
    warmupSeconds,
    soakSeconds,
    soakConcurrency,
    identities,
    model: rates ? 'fixed arrival rate with an in-flight limit' : 'closed loop',
    rates,
    soakRate: rates ? soakRate : undefined,
    timingBoundary: 'SDK mandate mint plus Gateway response body; session/delegation provisioning excluded after initial warm-up',
  }
  const cold = []
  for (let index = 0; index < identities; index++) cold.push(await action(index, `${runId}-provision`))
  results.provisioning = summarize(
    cold,
    cold.reduce((sum, sample) => sum + sample.durationMs, 0),
  )
  assert.ok(
    cold.every((sample) => sample.ok),
    'all application transports must work before load testing',
  )
  async function runLoad(concurrency, seconds, label, collect = true, rate = 0) {
    const samples = []
    const before = await control()
    const metricsBefore = await metrics()
    const start = performance.now()
    const deadline = start + seconds * 1000
    let sequence = 0
    let missed = 0
    if (rate) {
      const active = new Set()
      const interval = 1000 / rate
      const slots = Math.floor(rate * seconds)
      for (; sequence < slots && !results.stopReason; sequence++) {
        const due = start + sequence * interval
        if (due > performance.now()) await sleep(due - performance.now())
        if (active.size >= concurrency || performance.now() - due >= interval) {
          missed++
          continue
        }
        const pending = action(sequence % identities, `${runId}-${label}`)
          .then((sample) => {
            if (collect) samples.push(sample)
          })
          .finally(() => active.delete(pending))
        active.add(pending)
      }
      await Promise.all(active)
    } else {
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (performance.now() < deadline && !results.stopReason) {
            const sample = await action(sequence++ % identities, `${runId}-${label}`)
            if (collect) samples.push(sample)
          }
        }),
      )
    }
    const elapsed = performance.now() - start
    if (!collect) return
    const state = await control()
    const metricsAfter = await metrics()
    const summary = {
      label,
      concurrency,
      ...summarize(samples, elapsed),
      targetRequestsPerSecond: rate || undefined,
      scheduledRequests: rate ? sequence : undefined,
      missedSchedules: rate ? missed : undefined,
      upstreamExecutions: state.completed - before.completed,
      metricsBefore,
      metricsAfter,
    }
    await writeFile(resolve(output, `${label}-samples.json`), JSON.stringify(samples))
    results.benchmarks.push(summary)
    await persist()
    console.log(
      `BENCH ${label}: ${summary.successfulRequestsPerSecond.toFixed(2)} governed req/s; p95=${summary.p95Ms?.toFixed(2)}ms; errors=${summary.failed}`,
    )
    const successful = samples.filter((sample) => sample.ok)
    const auditSamples = [...new Set([successful[0]?.requestId, successful.at(-1)?.requestId].filter(Boolean))]
    summary.auditSamplesVerified = []
    summary.auditSamplesPending = []
    for (const requestId of auditSamples) {
      const events = await admin.audit.list(created.zone.id, { request_id: requestId, limit: 100 })
      if (
        events.some((event) => event.event_type === 'gateway_resource_request' && event.decision === 'allow') &&
        events.some((event) => event.event_type === 'token_exchange' && event.decision === 'allow')
      )
        summary.auditSamplesVerified.push(requestId)
      else summary.auditSamplesPending.push(requestId)
    }
    summary.auditReconciliation =
      'first and last successful request sampled at run completion; pending evidence is recorded, and full-run reconciliation is collected separately after drain'
    await persist()
    if (results.stopReason) throw new Error(results.stopReason)
  }
  await runLoad(1, warmupSeconds, 'warmup', false, rates ? Math.min(rates[0], 10) : 0)
  for (const [index, concurrency] of concurrencyLevels.entries()) {
    for (let repeat = 1; repeat <= repeats; repeat++)
      await runLoad(concurrency, durationSeconds, `c${concurrency}-r${repeat}`, true, rates?.[index])
  }
  await runLoad(soakConcurrency, soakSeconds, 'soak', true, rates ? soakRate : 0)
}

async function dependencyFailures() {
  const project = process.env.CARACAL_WEEK1_COMPOSE_PROJECT
  if (!project || !coordinatorTokenFile) throw new Error('fault tests require an explicit owned Compose project and Coordinator token file')
  const identifiers = {}
  for (const service of ['sts', 'redis', 'postgres', 'audit']) {
    const { stdout } = await exec('docker', [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--format',
      '{{.ID}}',
    ])
    const ids = stdout.trim().split(/\s+/).filter(Boolean)
    assert.equal(ids.length, 1, `exactly one owned ${service} container is required`)
    identifiers[service] = ids[0]
  }
  for (const service of ['sts', 'redis', 'postgres']) {
    await check(`${service} outage fails closed and recovers`, () =>
      session(async (client, resource, ctx) => {
        const mandate = await mint(client, resource, ctx)
        let stopped = false
        let failure
        let recoveryStart
        let readinessOnRestart
        try {
          await exec('docker', ['stop', '--time', '2', identifiers[service]])
          stopped = true
          const requestId = `${runId}-outage-${randomUUID()}`
          try {
            const response = await boundedFetch(`${gatewayUrl}/ok`, {
              headers: { Authorization: `Bearer ${mandate.token}`, 'X-Caracal-Resource': resource.identifier, 'X-Request-Id': requestId },
            })
            await response.arrayBuffer()
            assert.ok(response.status >= 400, 'outage must not authorize a request')
            failure = { status: response.status }
          } catch (error) {
            if (error instanceof assert.AssertionError) throw error
            failure = { error: safeError(error) }
          }
          assert.equal((await control()).requests[requestId] ?? 0, 0, 'dependency failure must prevent upstream execution')
        } finally {
          if (stopped) await exec('docker', ['start', identifiers[service]])
          recoveryStart = performance.now()
          readinessOnRestart = {}
          for (const [name, url] of Object.entries({ gateway: gatewayUrl, sts: stsUrl, api: apiUrl, coordinator: coordinatorUrl })) {
            try {
              readinessOnRestart[name] = (await boundedFetch(`${url}/ready`, { signal: AbortSignal.timeout(3000) })).status
            } catch {
              readinessOnRestart[name] = 'unreachable'
            }
          }
          await waitFor(
            `${service} dependency readiness`,
            async () => {
              const checks = await Promise.all(
                [gatewayUrl, stsUrl, apiUrl, coordinatorUrl].map(async (url) => {
                  try {
                    return (await boundedFetch(`${url}/ready`, { signal: AbortSignal.timeout(3000) })).status === 200
                  } catch {
                    return false
                  }
                }),
              )
              return checks.every(Boolean)
            },
            90_000,
            1500,
          )
        }
        await waitFor(
          'real governed traffic recovery',
          async () => {
            const response = await client.fetch(resource.identifier, '/ok', { scopes: [readScope], timeoutMs })
            await response.arrayBuffer()
            return response.status === 200
          },
          90_000,
          1500,
        )
        return {
          outage: failure,
          upstreamExecutionsDuringOutage: 0,
          recoveredStatus: 200,
          readinessOnRestart,
          recoveryMs: performance.now() - recoveryStart,
        }
      }),
    )
  }
  await check('Audit consumer outage buffers evidence and recovers', () =>
    session(async (client, resource) => {
      let stopped = false
      let requestId
      try {
        await exec('docker', ['stop', '--time', '2', identifiers.audit])
        stopped = true
        const response = await client.fetch(resource.identifier, '/ok', { scopes: [readScope], timeoutMs })
        await response.arrayBuffer()
        assert.equal(response.status, 200)
        requestId = response.headers.get('x-request-id')
      } finally {
        if (stopped) await exec('docker', ['start', identifiers.audit])
      }
      await awaitAudit(requestId)
      return { governedRequestDuringOutage: 200, auditEvidenceRecovered: true }
    }),
  )
}

async function cleanup() {
  const attempt = async (name, fn) => {
    try {
      await fn()
      results.cleanup.push({ name, ok: true })
    } catch (error) {
      results.cleanup.push({ name, ok: false, error: safeError(error) })
    }
  }
  for (const client of clients) await attempt('close client Sessions', () => client.close())
  if (created.policySet) await attempt('policy set', () => admin.policySets.delete(created.zone.id, created.policySet.id))
  if (created.policy) await attempt('policy', () => admin.policies.delete(created.zone.id, created.policy.id))
  for (const resource of resources) await attempt('resource', () => admin.resources.delete(created.zone.id, resource.id))
  if (created.provider) await attempt('provider', () => admin.providers.delete(created.zone.id, created.provider.id))
  for (const application of applications) await attempt('application', () => admin.applications.delete(created.zone.id, application.id))
  if (created.zone) await attempt('zone', () => admin.zones.delete(created.zone.id))
}

try {
  results.environment = {
    node: process.version,
    os: platform(),
    release: release(),
    logicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
    commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    sourceStatus: (await exec('git', ['status', '--short'])).stdout.trim(),
  }
  await setup()
  if (mode !== 'benchmark') await correctness()
  if (args.has('--faults')) await dependencyFailures()
  if (mode !== 'correctness') await withResourceSampling(benchmark)
} catch (error) {
  results.fatal = safeError(error)
  console.log(`FATAL ${error?.code ?? error?.name}`)
} finally {
  await cleanup()
  results.finishedAt = new Date().toISOString()
  await persist()
  clearInterval(keepAlive)
}
if (results.fatal || results.correctness.some((item) => !item.passed) || results.cleanup.some((item) => !item.ok)) process.exitCode = 1
