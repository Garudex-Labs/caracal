// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Removes the agent environment in reverse dependency order: policy, resource, provider, then the agent application.

import { clientFromEnv, SCOPES, AGENT, PROVIDER, RESOURCE, POLICY, byIdentifier, byName } from './plan.mjs'

export async function teardown(client, log = console.log) {
  const removed = []
  const policy = byName(await client.invoke('policy', 'list'), POLICY.name)
  if (policy) {
    await client.invoke('policy', 'delete', { id: policy.id })
    removed.push(`policy:${policy.id}`)
    log(`- policy ${POLICY.name} deleted`)
  }
  const resource = byIdentifier(await client.invoke('resource', 'list'), RESOURCE.identifier)
  if (resource) {
    await client.invoke('resource', 'delete', { id: resource.id })
    removed.push(`resource:${resource.id}`)
    log(`- resource ${RESOURCE.identifier} deleted`)
  }
  const provider = byIdentifier(await client.invoke('identity-provider', 'list'), PROVIDER.identifier)
  if (provider) {
    await client.invoke('identity-provider', 'delete', { id: provider.id })
    removed.push(`provider:${provider.id}`)
    log(`- identity-provider ${PROVIDER.identifier} deleted`)
  }
  const agent = byName(await client.invoke('app', 'list'), AGENT.name)
  if (agent) {
    await client.invoke('app', 'delete', { id: agent.id })
    removed.push(`app:${agent.id}`)
    log(`- app ${AGENT.name} deleted`)
  }
  return removed
}

async function main() {
  const client = clientFromEnv(SCOPES.teardown)
  const removed = await teardown(client)
  console.log(`teardown complete (${removed.length} object(s) removed)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
