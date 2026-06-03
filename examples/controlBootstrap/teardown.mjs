// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Non-interactive teardown that removes the demo policy, resource, and provider provisioned by bootstrap.

import { clientFromEnv, PROVIDER, RESOURCE, POLICY, findByIdentifier, findByName } from './provisionPlan.mjs'

export async function teardown(client, log = console.log) {
  const removed = []
  const policy = findByName(await client.invoke('policy', 'list'), POLICY.name)
  if (policy) {
    await client.invoke('policy', 'delete', { id: policy.id })
    removed.push(`policy:${policy.id}`)
    log(`policy deleted: ${policy.id}`)
  }
  const resource = findByIdentifier(await client.invoke('resource', 'list'), RESOURCE.identifier)
  if (resource) {
    await client.invoke('resource', 'delete', { id: resource.id })
    removed.push(`resource:${resource.id}`)
    log(`resource deleted: ${resource.id}`)
  }
  const provider = findByIdentifier(await client.invoke('identity-provider', 'list'), PROVIDER.identifier)
  if (provider) {
    await client.invoke('identity-provider', 'delete', { id: provider.id })
    removed.push(`provider:${provider.id}`)
    log(`provider deleted: ${provider.id}`)
  }
  return removed
}

async function main() {
  const client = clientFromEnv()
  const removed = await teardown(client)
  console.log(`teardown complete (${removed.length} object(s) removed)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
