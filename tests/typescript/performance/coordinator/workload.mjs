// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Real HTTP load: actual JWTs, PostgreSQL transactions, Redis and durable audit/outbox jobs.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AdminClient, authorGrantsDocument } from '../../../../packages/admin/ts/dist/index.js'

const require = createRequire(resolve('apps/coordinator/package.json'))
const { Pool } = require('pg')
const { insertAdminAuditRecord } = await import('../../../../packages/adminAudit/ts/dist/index.js')
export const coordinatorUrl = process.env.CARACAL_COORDINATOR_URL ?? 'http://127.0.0.1:4000'
export const stsUrl = process.env.STS_URL ?? 'http://127.0.0.1:8080'
export const admin = new AdminClient({ apiUrl: process.env.CARACAL_API_URL ?? 'http://127.0.0.1:3000', adminToken: process.env.CARACAL_ADMIN_TOKEN })
export const db = new Pool({ connectionString: process.env.PERF_DATABASE_URL ?? process.env.DATABASE_URL })
export async function call(path, token, method = 'GET', body, key, expected = 200, signal) {
  const response = await fetch(`${coordinatorUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ?? AbortSignal.timeout(30_000),
  })
  const result = response.status === 204 ? null : await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`)
  return { result, response }
}
export async function fixture(seedRows = 0) {
  for (const url of [coordinatorUrl, stsUrl, process.env.CARACAL_API_URL ?? 'http://127.0.0.1:3000']) {
    let healthy = false
    for (let attempt = 0; attempt < 200; attempt++) {
      try { healthy = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok } catch { /* Startup is not instantaneous. */ }
      if (healthy) break
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.ok(healthy, `${url} did not become healthy`)
  }
  const zone = await admin.zones.create({ name: 'Coordinator performance', slug: `coordinator-perf-${Date.now()}-${Math.random().toString(16).slice(2)}` })
  const app = await admin.applications.create(zone.id, { name: 'Coordinator worker', registration_method: 'managed' })
  const provider = await admin.providers.create(zone.id, { name: 'No credential', identifier: 'provider://documents', kind: 'none' })
  const resource = await admin.resources.create(zone.id, { name: 'Document reader', identifier: `resource://documents-${zone.id}`, scopes: ['documents:read'], upstream_url: 'http://documents.example', credential_provider_id: provider.id })
  const policy = await admin.policies.create(zone.id, { name: 'Document grant', content: authorGrantsDocument([{ applicationId: app.id, resourceIdentifier: resource.identifier, scopes: ['documents:read'] }]) })
  const policySet = await admin.policySets.create(zone.id, 'Coordinator performance')
  const version = await admin.policySets.addVersion(zone.id, policySet.id, [{ policy_version_id: policy.version_id }])
  await admin.policySets.activate(zone.id, policySet.id, version.version_id)
  for (let tries = 0; tries < 120; tries++) {
    if ((await admin.policySets.activationStatus(zone.id, policySet.id, version.version_id)).propagation_status === 'loaded') break
    assert.ok(tries < 119, 'STS policy propagation timed out')
    await new Promise((done) => setTimeout(done, 100))
  }
  const minted = await fetch(`${stsUrl}/oauth/2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', zone_id: zone.id, application_id: app.id, client_secret: app.client_secret, scope: 'agent:lifecycle', resource: resource.identifier, ttl_seconds: '3600' }),
  })
  const tokenResult = await minted.json()
  assert.equal(minted.status, 200, JSON.stringify(tokenResult))
  const token = tokenResult.access_token
  const prefix = `/zones/${zone.id}`
  const sessionBody = { application_id: app.id, ttl_seconds: 3600, metadata: { task: 'read and summarize document', input_bytes: 4096 } }
  const root = (await call(`${prefix}/agents`, token, 'POST', sessionBody, 'root', 201)).result.agent_session_id
  const target = (await call(`${prefix}/agents`, token, 'POST', sessionBody, 'target', 201)).result.agent_session_id
  const service = (await call(`${prefix}/agent-services`, token, 'POST', { application_id: app.id, endpoint_url: 'http://worker.example/execute', capabilities: ['summarize'] }, undefined, 201)).result.id
  // Seed genuine, hash-linked operational history through the existing persistence helper.
  // Each benchmark gets the same history size, rather than benefiting from an empty DB.
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('caracal.zone_id', $1, true)", [zone.id])
    for (let i = 0; i < seedRows; i++) {
      await insertAdminAuditRecord(client, {
        requestId: `history-${i}`, actorId: app.id, actorName: app.id, actorScope: 'agent:lifecycle',
        action: 'POST /historical-invocation', method: 'POST', path: '/historical-invocation', zoneId: zone.id,
        entityType: 'invocations', entityId: null, statusCode: 201,
      }, Buffer.from(process.env.AUDIT_HMAC_KEY, 'hex'))
    }
    await client.query('COMMIT')
  } catch (err) { await client.query('ROLLBACK'); throw err } finally { client.release() }
  await db.query('ANALYZE admin_audit_events')
  return { zone, app, prefix, token, root, target, service, resource, sessionBody }
}
export function invocationBody(f, key, extra = {}) {
  return { service_id: f.service, source_session_id: f.root, target_session_id: f.target, idempotency_key: key, method: 'summarize',
    params: { document: 'document.txt', options: { language: 'en', max_words: 100 } }, timeout_ms: 30_000, ...extra }
}
export function delegationBody(f) {
  return { source_session_id: f.root, target_session_id: f.target, issuer_application_id: f.app.id, receiver_application_id: f.app.id,
    resource_id: f.resource.id, scopes: ['documents:read'], ttl_seconds: 300 }
}
const quantile = (samples, p) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)]
async function profile(path) {
  const response = await fetch(`http://127.0.0.1:${process.env.PERF_PROFILE_PORT ?? 14001}${path}`, { method: 'POST' })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
async function benchmark(kind, concurrency, count, label, seedRows) {
  const f = await fixture(seedRows)
  const replayBody = invocationBody(f, 'replay')
  await call(`${f.prefix}/invocations`, f.token, 'POST', replayBody, undefined, 201)
  const times = []
  let next = 0, requests = 0
  const run = async (i) => {
    const req = async (...args) => {
      const start = performance.now()
      const value = await call(...args)
      times.push(performance.now() - start)
      requests++
      return value.result
    }
    if (kind === 'read') await req(`${f.prefix}/agents/${f.root}`, f.token)
    else if (kind === 'replay') await req(`${f.prefix}/invocations`, f.token, 'POST', replayBody, undefined, 201)
    else if (kind === 'session') {
      const session = await req(`${f.prefix}/agents`, f.token, 'POST', f.sessionBody, `session-${i}`, 201)
      await req(`${f.prefix}/agents/${session.agent_session_id}`, f.token, 'DELETE', undefined, undefined, 204)
    } else if (kind === 'invocation') {
      const invocation = await req(`${f.prefix}/invocations`, f.token, 'POST', invocationBody(f, `invoke-${i}`), undefined, 201)
      await req(`${f.prefix}/invocations/${invocation.id}/start`, f.token, 'PATCH')
      await req(`${f.prefix}/invocations/${invocation.id}/complete`, f.token, 'PATCH', { status: 'succeeded' })
    } else if (kind === 'delegation') {
      const edge = await req(`${f.prefix}/delegations`, f.token, 'POST', delegationBody(f), `delegation-${i}`, 201)
      assert.ok(edge.delegation_edge_id)
    } else throw new Error(`unknown workload: ${kind}`)
  }
  // Warm the exact path, connection pool, JWT/JWKS caches, and JIT before resetting measurement.
  const warmupOperations = Number(process.env.PERF_WARMUP_OPERATIONS ?? 128)
  let warmNext = 0
  await Promise.all(Array.from({ length: concurrency }, async () => { while (warmNext < warmupOperations) await run(`warm-${warmNext++}`) }))
  times.length = 0; requests = 0
  await profile('/start')
  const start = performance.now()
  await Promise.all(Array.from({ length: concurrency }, async () => { while (next < count) await run(next++) }))
  const elapsedMs = performance.now() - start
  const telemetry = await profile(`/stop?label=${label}`)
  times.sort((a, b) => a - b)
  const result = { label, kind, concurrency, operations: count, requests, seedRows, warmupOperations, clientElapsedMs: elapsedMs,
    requestsPerSecond: requests / (elapsedMs / 1000), p50Ms: quantile(times, .5), p95Ms: quantile(times, .95), p99Ms: quantile(times, .99),
    meanMs: times.reduce((a, b) => a + b, 0) / times.length, ...telemetry }
  // All events must leave the real transactional outbox, not just pass route assertions.
  for (let tries = 0; tries < 400; tries++) {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM caracal_outbox WHERE producer = 'coordinator' AND payload_json->>'zone_id' = $1 AND status <> 'published'", [f.zone.id])
    if (!rows[0].n) break
    assert.ok(tries < 399, 'outbox did not drain')
    await new Promise((done) => setTimeout(done, 50))
  }
  // Removal of this disposable zone includes all fixture state and audit history.
  await db.query("DELETE FROM caracal_outbox WHERE payload_json->>'zone_id' = $1", [f.zone.id])
  await db.query('DELETE FROM admin_audit_events WHERE zone_id = $1', [f.zone.id])
  await admin.zones.delete(f.zone.id)
  await db.query('DELETE FROM admin_audit_events WHERE zone_id = $1', [f.zone.id])
  await db.query('VACUUM ANALYZE admin_audit_events')
  return result
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const label = process.env.PERF_LABEL ?? 'baseline'
  const kinds = (process.env.PERF_WORKLOADS ?? 'read,replay,session,invocation,delegation').split(',')
  const levels = (process.env.PERF_CONCURRENCY ?? '1,8,32').split(',').map(Number)
  const count = Number(process.env.PERF_OPERATIONS ?? 512)
  const seedRows = Number(process.env.PERF_HISTORY_ROWS ?? 2000)
  const results = []
  try {
    for (const kind of kinds) for (const concurrency of levels) {
      const result = await benchmark(kind, concurrency, count, `${label}-${kind}-${concurrency}`, seedRows)
      results.push(result)
      console.log(JSON.stringify({ kind, concurrency, rps: result.requestsPerSecond, p50: result.p50Ms, p95: result.p95Ms, p99: result.p99Ms }))
      const out = resolve(process.env.PERF_OUTPUT_DIR ?? '/tmp/caracal-coordinator-perf/profiles')
      await mkdir(out, { recursive: true })
      await writeFile(`${out}/${label}.json`, JSON.stringify({ node: process.version, results }, null, 2))
    }
  } finally { await db.end() }
}
