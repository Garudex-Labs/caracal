/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Build-time generator for the /llms.txt AI discovery file.
 */

import { getCollection } from 'astro:content'

const site = 'https://docs.caracal.run'

const sections: Record<string, string[]> = {
  'Getting Started': ['start/overview', 'start/concepts-primer', 'start/installation', 'start/quickstart'],
  'Core Concepts': [
    'concepts/authority-enforcement',
    'concepts/principal',
    'concepts/policy',
    'concepts/mandate',
    'concepts/intent',
    'concepts/caveat',
    'concepts/delegation',
    'concepts/workspace',
    'concepts/ledger',
    'concepts/zone',
    'concepts/resource-binding',
  ],
  'Architecture': [
    'architecture/system',
    'architecture/services',
    'architecture/runtime',
    'architecture/storage',
    'architecture/zones',
    'architecture/threat-model',
  ],
  'Configuration': [
    'configuration/env',
    'configuration/database',
    'configuration/redis',
    'configuration/logging',
    'configuration/mcp',
  ],
  'CLI Reference': ['cli/overview', 'cli/init', 'cli/run', 'cli/stack', 'cli/audit', 'cli/agent'],
  'SDKs': ['sdk/typescript', 'sdk/python', 'sdk/go'],
  'AI Agents': ['ai/workflows', 'ai/mcp', 'ai/coordinator'],
  'Security': ['security/threat-model', 'security/hardening', 'security/disclosure'],
  'Reference': ['reference/api', 'reference/errors', 'reference/glossary'],
  'Optional': ['contributing/setup', 'contributing/workflow', 'contributing/style'],
}

export async function GET() {
  const docs = await getCollection('docs')
  const byId = new Map(docs.map((d) => [d.id, d]))

  const lines: string[] = [
    '# Caracal',
    '',
    '> Pre-execution authority enforcement for AI agents. Policies, mandates, and audit for production-grade autonomous systems.',
    '',
    'Caracal is an open-source system built by Garudex Labs. It issues short-lived signed mandates that bind AI agents to policy before any code runs. The core primitives are: Principal (identity), Mandate (authority token), Policy (OPA rules), Delegation (authority transfer), Caveat (mandate constraint), Intent (declared action), Workspace (policy boundary), and Ledger (audit record).',
    '',
    'The runtime splits into three services: STS (token issuer, port 8082), Gateway (reverse proxy, port 8081), and Coordinator (agent sessions, port 8080). All services are written in Go. SDKs exist for TypeScript, Python, and Go.',
    '',
  ]

  for (const [sectionTitle, ids] of Object.entries(sections)) {
    const entries: string[] = []
    for (const id of ids) {
      const doc = byId.get(id)
      if (!doc) continue
      entries.push(`- [${doc.data.title}](${site}/${id}/): ${doc.data.description}`)
    }
    if (entries.length === 0) continue
    lines.push(`## ${sectionTitle}`)
    lines.push(...entries)
    lines.push('')
  }

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
