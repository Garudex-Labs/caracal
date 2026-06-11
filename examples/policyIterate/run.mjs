/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI entry that wires the Caracal Admin API into the policy iteration loop for a denied request.
*/

import { readFile } from 'node:fs/promises'
import { iterate } from './iterate.mjs'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`missing required env: ${name}`)
    process.exit(2)
  }
  return value
}

function adminTransport(apiUrl, adminToken, zoneId) {
  const base = apiUrl.replace(/\/$/, '')
  const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }
  const zone = encodeURIComponent(zoneId)
  return {
    async explain(requestId) {
      const res = await fetch(`${base}/v1/zones/${zone}/audit/by-request/${encodeURIComponent(requestId)}/explain`, { headers })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`explain failed: ${res.status}`)
      return res.json()
    },
    async simulate(policySetId, versionId, input) {
      const res = await fetch(`${base}/v1/zones/${zone}/policy-sets/${encodeURIComponent(policySetId)}/simulate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ version_id: versionId, input }),
      })
      if (!res.ok) throw new Error(`simulate failed: ${res.status}`)
      return res.json()
    },
    async activate(policySetId, versionId) {
      const res = await fetch(`${base}/v1/zones/${zone}/policy-sets/${encodeURIComponent(policySetId)}/activate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ version_id: versionId }),
      })
      if (!res.ok) throw new Error(`activate failed: ${res.status}`)
      return res.json()
    },
    async activationStatus(policySetId, versionId, outboxId) {
      const query = new URLSearchParams({ version_id: versionId })
      if (outboxId) query.set('outbox_id', outboxId)
      const res = await fetch(`${base}/v1/zones/${zone}/policy-sets/${encodeURIComponent(policySetId)}/activation-status?${query}`, { headers })
      if (!res.ok) throw new Error(`activation status failed: ${res.status}`)
      return res.json()
    },
  }
}

async function loadRegressionCases(path) {
  if (!path) return []
  const cases = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(cases)) throw new Error('regression file must be a JSON array of { name, expect, input } cases')
  for (const c of cases) {
    if (!c.name || !c.input || (c.expect !== 'allow' && c.expect !== 'deny')) {
      throw new Error(`invalid regression case: ${JSON.stringify(c)} — each case needs name, input, and expect of "allow" or "deny"`)
    }
  }
  return cases
}

async function main() {
  const apiUrl = requireEnv('CARACAL_API_URL')
  const adminToken = requireEnv('CARACAL_ADMIN_TOKEN')
  const zoneId = requireEnv('CARACAL_ZONE_ID')
  const requestId = requireEnv('DENIED_REQUEST_ID')
  const policySetId = requireEnv('POLICY_SET_ID')
  const candidateVersionId = requireEnv('CANDIDATE_VERSION_ID')
  const regressionCases = await loadRegressionCases(process.env.REGRESSION_FILE)
  const activate = process.env.ACTIVATE === 'true'

  const report = await iterate({
    transport: adminTransport(apiUrl, adminToken, zoneId),
    requestId,
    policySetId,
    candidateVersionId,
    regressionCases,
    activate,
    log: (phase, message) => console.error(`[${phase}] ${message}`),
  })

  console.log(JSON.stringify(report, null, 2))
  if (!report.reproduced) process.exit(1)
  if (!report.verdict.safeToActivate) process.exit(1)
  if (activate && !report.activation?.loaded) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(2)
})
