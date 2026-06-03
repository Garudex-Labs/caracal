// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Non-interactive bootstrap that provisions the demo provider, resource, and policy through the Control API.

import { clientFromEnv, PROVIDER, RESOURCE, POLICY, findByIdentifier, findByName } from './provisionPlan.mjs'

export async function bootstrap(client, log = console.log) {
  const provider = await ensureProvider(client, log)
  const resource = await ensureResource(client, provider, log)
  const policy = await ensurePolicy(client, log)
  return { provider, resource, policy }
}

async function ensureProvider(client, log) {
  const existing = findByIdentifier(await client.invoke('identity-provider', 'list'), PROVIDER.identifier)
  if (existing) {
    log(`provider exists: ${existing.id}`)
    return existing
  }
  const created = await client.invoke('identity-provider', 'create', {
    name: PROVIDER.name,
    identifier: PROVIDER.identifier,
    kind: PROVIDER.kind,
    config: JSON.stringify(PROVIDER.config),
  })
  log(`provider created: ${created.id}`)
  return created
}

async function ensureResource(client, provider, log) {
  const existing = findByIdentifier(await client.invoke('resource', 'list'), RESOURCE.identifier)
  if (existing) {
    log(`resource exists: ${existing.id}`)
    return existing
  }
  const created = await client.invoke('resource', 'create', {
    name: RESOURCE.name,
    identifier: RESOURCE.identifier,
    scopes: RESOURCE.scopes,
    'upstream-url': RESOURCE.upstreamUrl,
    'credential-provider-id': provider.id,
  })
  log(`resource created: ${created.id}`)
  return created
}

async function ensurePolicy(client, log) {
  const existing = findByName(await client.invoke('policy', 'list'), POLICY.name)
  if (existing) {
    log(`policy exists: ${existing.id}`)
    return existing
  }
  const created = await client.invoke('policy', 'create', {
    name: POLICY.name,
    description: POLICY.description,
    content: POLICY.content,
    'schema-version': POLICY.schemaVersion,
  })
  log(`policy created: ${created.id}`)
  return created
}

async function main() {
  const client = clientFromEnv()
  const result = await bootstrap(client)
  console.log('bootstrap complete')
  console.log(JSON.stringify({
    provider: result.provider.id,
    resource: result.resource.id,
    policy: result.policy.id,
  }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
