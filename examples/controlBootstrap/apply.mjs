// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reconciles the live zone with the planned agent environment: creates missing objects and patches drifted ones.

import {
  clientFromEnv, SCOPES, AGENT, PROVIDER, RESOURCE, POLICY,
  byIdentifier, byName, providerDrift, resourceDrift, policyDrift,
} from './plan.mjs'

export async function apply(client, log = console.log) {
  const agent = await applyAgent(client)
  const provider = await applyProvider(client)
  const resource = await applyResource(client, provider.id)
  const policy = await applyPolicy(client)
  const changes = [agent, provider, resource, policy]
  for (const change of changes) report(change, log)
  return changes
}

async function applyAgent(client) {
  const live = byName(await client.invoke('app', 'list'), AGENT.name)
  if (live) return { kind: 'app', name: AGENT.name, action: 'unchanged', id: live.id }
  const created = await client.invoke('app', 'create', { name: AGENT.name })
  return { kind: 'app', name: AGENT.name, action: 'created', id: created.id }
}

async function applyProvider(client) {
  const live = byIdentifier(await client.invoke('identity-provider', 'list'), PROVIDER.identifier)
  if (!live) {
    const created = await client.invoke('identity-provider', 'create', {
      name: PROVIDER.name,
      identifier: PROVIDER.identifier,
      kind: PROVIDER.kind,
      config: JSON.stringify(PROVIDER.config),
    })
    return { kind: 'identity-provider', name: PROVIDER.identifier, action: 'created', id: created.id }
  }
  const drift = providerDrift(live)
  if (drift.length === 0) return { kind: 'identity-provider', name: PROVIDER.identifier, action: 'unchanged', id: live.id }
  await client.invoke('identity-provider', 'patch', {
    id: live.id,
    name: PROVIDER.name,
    kind: PROVIDER.kind,
    config: JSON.stringify(PROVIDER.config),
  })
  return { kind: 'identity-provider', name: PROVIDER.identifier, action: 'updated', id: live.id, drift }
}

async function applyResource(client, providerId) {
  const live = byIdentifier(await client.invoke('resource', 'list'), RESOURCE.identifier)
  if (!live) {
    const created = await client.invoke('resource', 'create', {
      name: RESOURCE.name,
      identifier: RESOURCE.identifier,
      scopes: RESOURCE.scopes,
      'upstream-url': RESOURCE.upstreamUrl,
      'credential-provider-id': providerId,
    })
    return { kind: 'resource', name: RESOURCE.identifier, action: 'created', id: created.id }
  }
  const drift = resourceDrift(live, providerId)
  if (drift.length === 0) return { kind: 'resource', name: RESOURCE.identifier, action: 'unchanged', id: live.id }
  await client.invoke('resource', 'patch', {
    id: live.id,
    name: RESOURCE.name,
    scopes: RESOURCE.scopes,
    'upstream-url': RESOURCE.upstreamUrl,
    'credential-provider-id': providerId,
  })
  return { kind: 'resource', name: RESOURCE.identifier, action: 'updated', id: live.id, drift }
}

async function applyPolicy(client) {
  const live = byName(await client.invoke('policy', 'list'), POLICY.name)
  if (!live) {
    const created = await client.invoke('policy', 'create', {
      name: POLICY.name,
      description: POLICY.description,
      content: POLICY.content,
      'schema-version': POLICY.schemaVersion,
    })
    return { kind: 'policy', name: POLICY.name, action: 'created', id: created.id }
  }
  const detail = await client.invoke('policy', 'get', { id: live.id })
  const drift = policyDrift(detail)
  if (drift.length === 0) return { kind: 'policy', name: POLICY.name, action: 'unchanged', id: live.id }
  await client.invoke('policy', 'version', {
    id: live.id,
    content: POLICY.content,
    'schema-version': POLICY.schemaVersion,
  })
  return { kind: 'policy', name: POLICY.name, action: 'updated', id: live.id, drift }
}

function report(change, log) {
  const marker = change.action === 'created' ? '+' : change.action === 'updated' ? '~' : '='
  const detail = change.drift ? ` (${change.drift.join(', ')})` : ''
  log(`${marker} ${change.kind} ${change.name} ${change.action}${detail}`)
}

async function main() {
  const client = clientFromEnv(SCOPES.apply)
  const changes = await apply(client)
  const count = (action) => changes.filter((change) => change.action === action).length
  console.log(`apply complete: ${count('created')} created, ${count('updated')} updated, ${count('unchanged')} unchanged`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
