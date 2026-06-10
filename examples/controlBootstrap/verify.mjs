// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Read-only drift check that compares the live zone to the plan and fails when the agent environment has drifted.

import {
  clientFromEnv, SCOPES, AGENT, PROVIDER, RESOURCE, POLICY,
  byIdentifier, byName, providerDrift, resourceDrift, policyDrift,
} from './plan.mjs'

export async function verify(client, log = console.log) {
  const findings = []
  const agent = byName(await client.invoke('app', 'list'), AGENT.name)
  findings.push(finding('app', AGENT.name, agent, []))

  const provider = byIdentifier(await client.invoke('identity-provider', 'list'), PROVIDER.identifier)
  findings.push(finding('identity-provider', PROVIDER.identifier, provider, provider ? providerDrift(provider) : []))

  const resource = byIdentifier(await client.invoke('resource', 'list'), RESOURCE.identifier)
  findings.push(finding('resource', RESOURCE.identifier, resource, resource && provider ? resourceDrift(resource, provider.id) : []))

  const policy = byName(await client.invoke('policy', 'list'), POLICY.name)
  const policyDetail = policy ? await client.invoke('policy', 'get', { id: policy.id }) : undefined
  findings.push(finding('policy', POLICY.name, policy, policyDetail ? policyDrift(policyDetail) : []))

  for (const item of findings) report(item, log)
  return findings
}

function finding(kind, name, live, drift) {
  if (!live) return { kind, name, status: 'missing' }
  if (drift.length > 0) return { kind, name, status: 'drifted', drift }
  return { kind, name, status: 'ok' }
}

function report(item, log) {
  const detail = item.drift ? ` (${item.drift.join(', ')})` : ''
  log(`${item.status === 'ok' ? '=' : '!'} ${item.kind} ${item.name} ${item.status}${detail}`)
}

async function main() {
  const client = clientFromEnv(SCOPES.verify)
  const findings = await verify(client)
  const broken = findings.filter((item) => item.status !== 'ok')
  if (broken.length > 0) {
    console.error(`verify failed: ${broken.length} object(s) missing or drifted`)
    process.exitCode = 1
    return
  }
  console.log('verify passed: environment matches the plan')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
