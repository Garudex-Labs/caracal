// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Real-stack protected-resource contract covering SDK, Coordinator, STS, Gateway, upstream, and Audit.

import { readFile } from 'node:fs/promises'
import { AdminClient, authorGrantsDocument } from '../../../packages/admin/ts/dist/index.js'
import { Authority, Caracal } from '../../../packages/sdk/ts/dist/index.js'

const apiUrl = process.env.CARACAL_API_URL ?? 'http://127.0.0.1:3000'
const coordinatorUrl = process.env.CARACAL_COORDINATOR_URL ?? 'http://127.0.0.1:4000'
const stsUrl = process.env.CARACAL_STS_URL ?? 'http://127.0.0.1:8080'
const gatewayUrl = process.env.CARACAL_GATEWAY_URL ?? 'http://127.0.0.1:8081'
const upstreamUrl = process.env.CARACAL_E2E_UPSTREAM_URL
const adminTokenFile = process.env.CARACAL_ADMIN_TOKEN_FILE

if (!upstreamUrl) throw new Error('CARACAL_E2E_UPSTREAM_URL is required')
if (!adminTokenFile) throw new Error('CARACAL_ADMIN_TOKEN_FILE is required')

const resourceId = 'resource://pipernet'
const scope = 'pipernet:read'
const suffix = `${Date.now()}-${process.pid}`
const adminToken = (await readFile(adminTokenFile, 'utf8')).trim()
const admin = new AdminClient({ apiUrl, adminToken })
const state = {}

async function waitForPolicy() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await admin.policySets.activationStatus(state.zone.id, state.policySet.id, state.policyVersion.version_id)
    if (status.propagation_status === 'loaded') return
    if (status.propagation_status === 'failed') throw new Error(`policy activation failed: ${JSON.stringify(status)}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('policy activation timed out')
}

async function waitForAudit(requestId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const events = await admin.audit.list(state.zone.id, { request_id: requestId, limit: 20 })
    if (
      events.some((event) => event.event_type === 'gateway_resource_request' && event.decision === 'allow') &&
      events.some((event) => event.event_type === 'token_exchange' && event.decision === 'allow')
    ) {
      return events
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`audit events did not converge for request ${requestId}`)
}

async function cleanup() {
  try {
    await state.caracal?.close()
  } catch {}
  try {
    if (state.policySet) await admin.policySets.delete(state.zone.id, state.policySet.id)
  } catch {}
  try {
    if (state.policy) await admin.policies.delete(state.zone.id, state.policy.id)
  } catch {}
  try {
    if (state.resource) await admin.resources.delete(state.zone.id, state.resource.id)
  } catch {}
  try {
    if (state.provider) await admin.providers.delete(state.zone.id, state.provider.id)
  } catch {}
  try {
    if (state.application) await admin.applications.delete(state.zone.id, state.application.id)
  } catch {}
  try {
    if (state.zone) await admin.zones.delete(state.zone.id)
  } catch {}
}

try {
  state.zone = await admin.zones.create({ name: 'Pied Piper Protected E2E', slug: `pied-piper-protected-${suffix}` })
  state.application = await admin.applications.create(state.zone.id, {
    name: 'Anton Protected E2E',
    registration_method: 'managed',
  })
  state.provider = await admin.providers.create(state.zone.id, {
    name: 'Hooli PiperNet No Credential',
    identifier: 'provider://hooli-pipernet-none',
    kind: 'none',
  })
  state.resource = await admin.resources.create(state.zone.id, {
    name: 'PiperNet',
    identifier: resourceId,
    upstream_url: upstreamUrl,
    credential_provider_id: state.provider.id,
    scopes: [scope],
    operation_enforcement: 'enforced',
    operations: [{ method: 'GET', path: '/', scope }],
  })
  const content = authorGrantsDocument([{ applicationId: state.application.id, resourceIdentifier: resourceId, scopes: [scope] }])
  state.policy = await admin.policies.create(state.zone.id, { name: 'PiperNet Read Grant', content })
  state.policySet = await admin.policySets.create(state.zone.id, 'PiperNet Protected E2E')
  state.policyVersion = await admin.policySets.addVersion(state.zone.id, state.policySet.id, [
    { policy_version_id: state.policy.version_id },
  ])
  await admin.policySets.activate(state.zone.id, state.policySet.id, state.policyVersion.version_id)
  await waitForPolicy()

  state.caracal = Caracal.fromClientSecret({
    coordinatorUrl,
    stsUrl,
    zoneId: state.zone.id,
    applicationId: state.application.id,
    clientSecret: state.application.client_secret,
    gatewayUrl,
    resources: [{ resourceId, upstreamPrefix: upstreamUrl }],
  })

  let response
  await state.caracal.session(async () => {
    await state.caracal.session(
      async () => {
        response = await state.caracal.fetch(resourceId, '/', {
          scopes: [scope],
          timeoutMs: 15_000,
          headers: { 'X-Request-Id': `protected-e2e-${suffix}` },
        })
      },
      {
        labels: [state.application.id],
        authority: Authority.narrow([scope], { resourceId, ttlSeconds: 300 }),
      },
    )
  })

  if (!response?.ok) throw new Error(`protected request failed with status ${response?.status}`)
  const requestId = response.headers.get('x-request-id')
  if (!requestId) throw new Error('Gateway response missing X-Request-Id')
  const events = await waitForAudit(requestId)

  console.log(
    JSON.stringify({
      ok: true,
      requestId,
      events: events.map((event) => ({ eventType: event.event_type, decision: event.decision })),
    }),
  )
} finally {
  await cleanup()
}
