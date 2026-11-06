// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
// Live regression suite. Fault injection is opt-in and restricted to the disposable benchmark DB.
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fixture, call, db, admin, invocationBody, delegationBody, coordinatorUrl } from './workload.mjs'
import { startIdempotency, completeIdempotency, keyDigest, requestDigest } from '../../../../apps/coordinator/dist/idempotency.js'
import { cfg } from '../../../../apps/coordinator/dist/config.js'
import { insertAdminAuditRecord } from '../../../../packages/adminAudit/ts/dist/index.js'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const results = []
let f
async function check(name, run) { await run(); results.push(name); console.log(`PASS ${name}`) }
async function until(run, message, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  do { if (await run()) return; await sleep(50) } while (Date.now() < end)
  throw new Error(message)
}
async function statuses(path, method, body, count = 16) {
  return Promise.all(Array.from({ length: count }, async () => {
    const response = await fetch(`${coordinatorUrl}${path}`, { method, headers: { authorization: `Bearer ${f.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, result: await response.json() }
  }))
}
async function createInvocation(key, extra) { return (await call(`${f.prefix}/invocations`, f.token, 'POST', invocationBody(f, key, extra), undefined, 201)).result }
function auditHash(row) {
  const hash = createHash('sha256')
  for (const key of ['id', 'request_id', 'actor_id', 'actor_name', 'actor_scope', 'action', 'method', 'path', 'zone_id', 'entity_type', 'entity_id', 'status_code', 'payload_json', 'occurred_at']) {
    const value = key === 'occurred_at' ? row[key].toISOString() : key === 'payload_json' ? row[key] ? JSON.stringify(row[key]) : '' : row[key] ?? ''
    hash.update(String(value)).update('\x1f')
  }
  return hash.digest('hex')
}
try {
  f = await fixture()
  await check('32 concurrent Session starts replay exactly one durable mutation', async () => {
    const responses = await Promise.all(Array.from({ length: 32 }, () => call(`${f.prefix}/agents`, f.token, 'POST', f.sessionBody, 'duplicate-session', 201)))
    const ids = new Set(responses.map((r) => r.result.agent_session_id))
    assert.equal(ids.size, 1)
    assert.equal(responses.filter((r) => r.response.headers.get('idempotency-replayed') === 'true').length, 31)
    const id = responses[0].result.agent_session_id
    const { rows } = await db.query("SELECT count(*)::int AS n FROM caracal_outbox WHERE producer='coordinator' AND dedupe_key=$1", [`spawn:${id}`])
    assert.equal(rows[0].n, 1)
    await call(`${f.prefix}/agents`, f.token, 'POST', { ...f.sessionBody, labels: ['changed'] }, 'duplicate-session', 409)
    await call(`${f.prefix}/agents/${id}`, f.token, 'DELETE', undefined, undefined, 204)
    const replay = await call(`${f.prefix}/agents`, f.token, 'POST', f.sessionBody, 'duplicate-session', 409)
    assert.equal(replay.result.error, 'idempotency_result_inactive')
  })
  await check('concurrent invocation creation, start and completion stay single-writer', async () => {
    const body = invocationBody(f, 'duplicate-invocation')
    const responses = await Promise.all(Array.from({ length: 32 }, () => call(`${f.prefix}/invocations`, f.token, 'POST', body, undefined, 201)))
    assert.equal(new Set(responses.map((r) => r.result.id)).size, 1)
    const id = responses[0].result.id
    const started = await statuses(`${f.prefix}/invocations/${id}/start`, 'PATCH')
    assert.equal(started.filter((r) => r.status === 200).length, 1)
    assert.ok(started.every((r) => r.status === 200 || r.status === 409))
    const completed = await statuses(`${f.prefix}/invocations/${id}/complete`, 'PATCH', { status: 'succeeded' })
    assert.equal(completed.filter((r) => r.status === 200).length, 1)
    assert.ok(completed.every((r) => r.status === 200 || r.status === 409))
    assert.equal((await call(`${f.prefix}/invocations/${id}`, f.token)).result.attempts, 1)
  })
  await check('retry, cancellation and deadline enforcement preserve state transitions', async () => {
    const inv = await createInvocation('retry')
    await call(`${f.prefix}/invocations/${inv.id}/start`, f.token, 'PATCH')
    await call(`${f.prefix}/invocations/${inv.id}/complete`, f.token, 'PATCH', { status: 'failed', error: { message: 'dependency unavailable' } })
    assert.equal((await call(`${f.prefix}/invocations/${inv.id}/start`, f.token, 'PATCH')).result.attempts, 2)
    assert.equal((await call(`${f.prefix}/invocations/${inv.id}/cancel`, f.token, 'PATCH', { reason: 'caller canceled' })).result.status, 'cancel_requested')
    // Existing semantics allow a worker's completion after a cancellation request.
    await call(`${f.prefix}/invocations/${inv.id}/complete`, f.token, 'PATCH', { status: 'succeeded' })
    const pending = await createInvocation('cancel-pending')
    assert.equal((await call(`${f.prefix}/invocations/${pending.id}/cancel`, f.token, 'PATCH', {})).result.status, 'canceled')
    await call(`${f.prefix}/invocations/${pending.id}/start`, f.token, 'PATCH', undefined, undefined, 409)
    const timed = await createInvocation('deadline', { timeout_ms: 10, retry_policy: { max_attempts: 1, backoff_ms: 0 } })
    await call(`${f.prefix}/invocations/${timed.id}/start`, f.token, 'PATCH')
    await until(async () => (await call(`${f.prefix}/invocations/${timed.id}`, f.token)).result.status === 'timed_out', 'deadline job did not run')
  })
  await check('expiry, HMAC rotation overlap, limits and rollback use the real receipt table', async () => {
    const keys = [Buffer.alloc(32, 9), Buffer.alloc(32, 8)]
    const client = await db.connect()
    const input = { operation: 'session.start.v2', zoneId: f.zone.id, scopeId: `rotation-${f.app.id}`, key: 'rotation', request: { value: 1 }, hmacKeys: [keys[1]], maxReceiptsPerScope: 1 }
    const finish = async (start, id) => completeIdempotency(client, { operation: input.operation, zoneId: input.zoneId, scopeId: input.scopeId, keyDigest: start.keyDigest, requestDigest: start.requestDigest, resourceType: 'session', resourceId: id, responseStatus: 201, response: { id }, retentionSeconds: 3600 })
    try {
      await client.query('BEGIN')
      await finish(await startIdempotency(client, input), 'old')
      await client.query('COMMIT')
      await client.query('BEGIN')
      assert.equal((await startIdempotency(client, { ...input, hmacKeys: keys })).outcome, 'replayed')
      assert.equal((await startIdempotency(client, { ...input, key: 'limit' })).outcome, 'limit')
      assert.equal((await startIdempotency(client, { ...input, request: { value: 2 } })).outcome, 'conflict')
      await client.query('COMMIT')
      // A live old-key receipt and an expired new-key receipt may coexist during rotation.
      await client.query('BEGIN')
      await completeIdempotency(client, { operation: input.operation, zoneId: input.zoneId, scopeId: input.scopeId, keyDigest: keyDigest(input.key, keys[0]), requestDigest: requestDigest(input.request), resourceType: 'session', resourceId: 'expired-new-key', responseStatus: 201, response: { id: 'expired-new-key' }, retentionSeconds: 3600 })
      await client.query("UPDATE coordinator_idempotency_receipts SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 second' WHERE operation=$1 AND zone_id=$2 AND scope_id=$3 AND key_digest=$4", [input.operation, f.zone.id, input.scopeId, keyDigest(input.key, keys[0])])
      await client.query('COMMIT')
      await client.query('BEGIN')
      assert.equal((await startIdempotency(client, { ...input, hmacKeys: keys })).outcome, 'replayed')
      assert.equal((await client.query('SELECT count(*)::int AS n FROM coordinator_idempotency_receipts WHERE operation=$1 AND zone_id=$2 AND scope_id=$3', [input.operation, f.zone.id, input.scopeId])).rows[0].n, 1)
      await client.query('COMMIT')
      await client.query("UPDATE coordinator_idempotency_receipts SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 second' WHERE operation=$1 AND zone_id=$2 AND scope_id=$3", [input.operation, f.zone.id, input.scopeId])
      await client.query('BEGIN')
      assert.equal((await startIdempotency(client, { ...input, hmacKeys: keys })).outcome, 'new')
      await client.query('ROLLBACK')
      assert.equal((await client.query('SELECT count(*)::int AS n FROM coordinator_idempotency_receipts WHERE operation=$1 AND zone_id=$2 AND scope_id=$3', [input.operation, f.zone.id, input.scopeId])).rows[0].n, 1)
      await client.query('BEGIN')
      const start = await startIdempotency(client, { ...input, hmacKeys: keys })
      assert.equal(start.outcome, 'new')
      await finish(start, 'new')
      await client.query('COMMIT')
      const receipt = (await client.query('SELECT key_digest, request_digest FROM coordinator_idempotency_receipts WHERE operation=$1 AND zone_id=$2 AND scope_id=$3', [input.operation, f.zone.id, input.scopeId])).rows[0]
      assert.ok(receipt.key_digest.equals(keyDigest(input.key, keys[0])))
      assert.ok(receipt.request_digest.equals(requestDigest(input.request)))
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  await check('post-lock snapshot sees a commit made while a rotated-key duplicate waits', async () => {
    const first = await db.connect(), second = await db.connect()
    const key = Buffer.alloc(32, 8), nextKey = Buffer.alloc(32, 9)
    const input = { operation: 'delegation.create.v2', zoneId: f.zone.id, scopeId: `snapshot-${f.app.id}`, key: 'same-key', request: {}, hmacKeys: [key], maxReceiptsPerScope: 10 }
    try {
      await first.query('BEGIN'); await second.query('BEGIN')
      const start = await startIdempotency(first, input)
      await completeIdempotency(first, { operation: input.operation, zoneId: input.zoneId, scopeId: input.scopeId, keyDigest: start.keyDigest, requestDigest: start.requestDigest, resourceType: 'session', resourceId: f.root, responseStatus: 201, response: { id: f.root }, retentionSeconds: 3600 })
      const waiting = startIdempotency(second, { ...input, hmacKeys: [nextKey, key] })
      await until(async () => (await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory'", [second.processID])).rows[0].n === 1, 'duplicate did not wait on advisory lock')
      await first.query('COMMIT')
      assert.equal((await waiting).outcome, 'replayed')
      await second.query('COMMIT')
    } finally { await first.query('ROLLBACK'); await second.query('ROLLBACK'); first.release(); second.release() }
  })
  await check('service lease takeover fences old heartbeats and suspension/resumption preserves generation', async () => {
    const body = { application_id: f.app.id, lifecycle: 'service' }
    const service = (await call(`${f.prefix}/agents`, f.token, 'POST', body, 'service-session', 201)).result
    const id = service.agent_session_id
    const lease = (await call(`${f.prefix}/agents/${id}/lease`, f.token, 'POST')).result
    assert.ok(lease.lease_generation > service.lease_generation)
    const stale = await call(`${f.prefix}/agents/${id}/heartbeat`, f.token, 'POST', { lease_generation: service.lease_generation }, undefined, 409)
    assert.equal(stale.result.error, 'session_lease_fenced')
    await call(`${f.prefix}/agents/${id}/heartbeat`, f.token, 'POST', { lease_generation: lease.lease_generation })
    await call(`${f.prefix}/agents/${id}/suspend`, f.token, 'PATCH')
    await call(`${f.prefix}/agents/${id}/resume`, f.token, 'PATCH')
    await call(`${f.prefix}/agents/${id}`, f.token, 'DELETE', { lease_generation: lease.lease_generation }, undefined, 204)
  })
  await check('JWT tampering and cross-zone access remain denied', async () => {
    const pieces = f.token.split('.')
    pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1)
    await call(`${f.prefix}/agents/${f.root}`, pieces.join('.'), 'GET', undefined, undefined, 401)
    await call(`/zones/not-the-token-zone/agents`, f.token, 'GET', undefined, undefined, 403)
  })
  if (process.env.PERF_ALLOW_FAULTS === '1') {
    assert.equal(new URL(process.env.PERF_DATABASE_URL).port, process.env.PERF_PG_PORT ?? '45432', 'fault injection requires the disposable DB')
    await check('database timeout rolls back; a client disconnect preserves durable replay semantics', async () => {
      const blocker = await db.connect()
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE agent_invocations IN ACCESS EXCLUSIVE MODE')
        const failed = await call(`${f.prefix}/invocations`, f.token, 'POST', invocationBody(f, 'sql-timeout'), undefined, 500)
        assert.equal(failed.result.error, 'internal_error')
        assert.equal((await db.query("SELECT count(*)::int AS n FROM coordinator_idempotency_receipts WHERE zone_id=$1 AND operation='invocation.create.v2' AND key_digest=$2", [f.zone.id, keyDigest('sql-timeout', cfg.idempotencyHmacKeys[0])])).rows[0].n, 0)
        const abort = new AbortController()
        const canceled = call(`${f.prefix}/invocations`, f.token, 'POST', invocationBody(f, 'disconnected'), undefined, 201, abort.signal)
        await sleep(100); abort.abort()
        await assert.rejects(canceled)
        await blocker.query('COMMIT')
        await createInvocation('sql-timeout')
        const repeated = await Promise.all(Array.from({ length: 8 }, () => createInvocation('disconnected')))
        assert.equal(new Set(repeated.map((row) => row.id)).size, 1)
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
    })
    await check('audit failure reports partial execution, then a retry replays without a second mutation', async () => {
      const blocker = await db.connect()
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE admin_audit_events IN ACCESS EXCLUSIVE MODE')
        const body = invocationBody(f, 'partial-audit')
        const failed = await call(`${f.prefix}/invocations`, f.token, 'POST', body, undefined, 500)
        assert.equal(failed.result.error, 'audit_unavailable')
        await blocker.query('COMMIT')
        const replayed = await call(`${f.prefix}/invocations`, f.token, 'POST', body, undefined, 201)
        assert.equal(replayed.response.headers.get('idempotency-replayed'), 'true')
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
    })
    await check('Redis failure fails closed and recovery drains the existing outbox', async () => {
      const coordinatorRequire = createRequire(resolve('apps/coordinator/package.json'))
      const Redis = coordinatorRequire('ioredis')
      const redis = new Redis(process.env.REDIS_URL)
      try {
        await redis.call('ACL', 'SETUSER', 'default', '-time')
        await call(`${f.prefix}/agents/${f.root}`, f.token, 'GET', undefined, undefined, 500)
      } finally { await redis.call('ACL', 'SETUSER', 'default', '+time'); await redis.quit() }
      await call(`${f.prefix}/agents/${f.root}`, f.token)
    })
  }
  await check('concurrent delegation creation stays idempotent and revoke still cascades', async () => {
    const body = delegationBody(f)
    const edges = await Promise.all(Array.from({ length: 16 }, () => call(`${f.prefix}/delegations`, f.token, 'POST', body, 'duplicate-delegation', 201)))
    assert.equal(new Set(edges.map((e) => e.result.delegation_edge_id)).size, 1)
    const id = edges[0].result.delegation_edge_id
    await call(`${f.prefix}/delegations/${id}/revoke`, f.token, 'PATCH')
    assert.equal((await db.query('SELECT status FROM sessions WHERE id=$1', [f.target])).rows[0].status, 'terminated')
    const reminted = await fetch(`${process.env.STS_URL}/oauth/2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', zone_id: f.zone.id, application_id: f.app.id, client_secret: f.app.client_secret, resource: f.resource.identifier, scope: 'agent:lifecycle' }),
    })
    assert.equal(reminted.status, 200)
    f.token = (await reminted.json()).access_token
    const replay = await call(`${f.prefix}/delegations`, f.token, 'POST', body, 'duplicate-delegation', 409)
    assert.equal(replay.result.error, 'idempotency_result_inactive')
  })
  await check('real concurrent responses produce an unbroken, correctly signed audit chain', async () => {
    const { rows } = await db.query('SELECT * FROM admin_audit_events WHERE zone_id=$1 ORDER BY chain_seq', [f.zone.id])
    let previous = '', seq = 0
    for (const row of rows) {
      assert.equal(Number(row.chain_seq), ++seq)
      assert.equal(row.prev_content_sha256 ?? '', previous)
      // Coordinator records have no payload_json. API fixture setup also uses this
      // chain but its JSONB payload key order is not a lossless hash input.
      if (row.path.startsWith(`${f.prefix}/agents`) || row.path.startsWith(`${f.prefix}/delegations`) || row.path.startsWith(`${f.prefix}/invocations`)) {
        assert.equal(row.content_sha256, auditHash(row))
      }
      assert.equal(row.chain_hmac, createHmac('sha256', Buffer.from(process.env.AUDIT_HMAC_KEY, 'hex')).update(row.content_sha256).update('|').update(previous).digest('hex'))
      previous = row.content_sha256
    }
  })
  await check('legacy/null sequence and global audit head compatibility uses real SQL', async () => {
    const client = await db.connect()
    const zoneId = `${f.zone.id}:legacy`
    const rec = { requestId: 'legacy', actorId: null, actorName: null, actorScope: null, action: 'test', method: 'POST', path: '/test', zoneId, entityType: null, entityId: null, statusCode: 200 }
    try {
      await client.query('BEGIN')
      await client.query("INSERT INTO admin_audit_events(id,request_id,action,method,path,zone_id,status_code,chain_seq,content_sha256) VALUES($1,'legacy','test','POST','/test',$2,200,NULL,'legacy-head')", [`legacy-${f.zone.id}`, zoneId])
      await insertAdminAuditRecord(client, rec)
      await insertAdminAuditRecord(client, { ...rec, requestId: 'modern' })
      const rows = (await client.query('SELECT chain_seq,prev_content_sha256 FROM admin_audit_events WHERE zone_id=$1 AND chain_seq>0 ORDER BY chain_seq', [zoneId])).rows
      assert.deepEqual(rows.map((r) => [Number(r.chain_seq), r.prev_content_sha256]), [[1, 'legacy-head'], [2, (await client.query('SELECT content_sha256 FROM admin_audit_events WHERE zone_id=$1 AND chain_seq=1', [zoneId])).rows[0].content_sha256]])
      await insertAdminAuditRecord(client, { ...rec, zoneId: null })
      await client.query('ROLLBACK')
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  await until(async () => !(await db.query("SELECT 1 FROM caracal_outbox WHERE producer='coordinator' AND payload_json->>'zone_id'=$1 AND status<>'published' LIMIT 1", [f.zone.id])).rows.length, 'real outbox publication did not converge')
  console.log(JSON.stringify({ ok: true, checks: results, faults: process.env.PERF_ALLOW_FAULTS === '1' }))
} finally {
  if (f) { await admin.zones.delete(f.zone.id); await db.query('DELETE FROM admin_audit_events WHERE zone_id=$1', [f.zone.id]) }
  await db.end()
}
