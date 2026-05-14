/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Build-time generator for the /llms-full.txt complete content file.
 */

import { getCollection } from 'astro:content'

const site = 'https://docs.caracal.run'

// Dependency order: concepts requiring nothing first, then their dependents.
const pageOrder = [
  'start/overview',
  'start/concepts-primer',
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
  'concepts/authority-enforcement',
  'architecture/system',
  'architecture/services',
  'architecture/runtime',
  'architecture/storage',
  'architecture/zones',
  'architecture/threat-model',
  'start/installation',
  'start/quickstart',
  'configuration/env',
  'configuration/database',
  'configuration/redis',
  'configuration/logging',
  'configuration/mcp',
  'cli/overview',
  'cli/init',
  'cli/run',
  'cli/stack',
  'cli/audit',
  'cli/agent',
  'sdk/typescript',
  'sdk/python',
  'sdk/go',
  'ai/workflows',
  'ai/mcp',
  'ai/coordinator',
  'security/threat-model',
  'security/hardening',
  'security/disclosure',
  'reference/api',
  'reference/errors',
  'reference/glossary',
  'contributing/setup',
  'contributing/workflow',
  'contributing/style',
]

export async function GET() {
  const docs = await getCollection('docs')
  const byId = new Map(docs.map((d) => [d.id, d]))

  const header = [
    '# Caracal',
    '',
    '> Pre-execution authority enforcement for AI agents. Policies, mandates, and audit for production-grade autonomous systems.',
    '',
    'Caracal is an open-source system built by Garudex Labs. It issues short-lived signed mandates that bind AI agents to policy before any code runs.',
    '',
    '---',
    '',
  ]

  const pages: string[] = []

  // Ordered pages first
  const seen = new Set<string>()
  for (const id of pageOrder) {
    const doc = byId.get(id)
    if (!doc) continue
    seen.add(id)
    pages.push(formatPage(doc, site))
  }

  // Any remaining pages not in the explicit order
  for (const doc of docs) {
    if (seen.has(doc.id)) continue
    if (doc.id === 'index') continue
    pages.push(formatPage(doc, site))
  }

  return new Response([...header, ...pages].join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function formatPage(doc: Awaited<ReturnType<typeof getCollection<'docs'>>>[number], base: string) {
  const d = doc.data as Record<string, unknown>
  const lines = [
    '---',
    `# ${doc.data.title}`,
    `# URL: ${base}/${doc.id}/`,
    `# Type: ${(d.pageType as string | undefined) ?? 'page'}`,
    `# Concepts: ${((d.concepts as string[] | undefined) ?? []).join(', ')}`,
    `# Requires: ${((d.requires as string[] | undefined) ?? []).join(', ')}`,
    '---',
    '',
    doc.body ?? '',
    '',
  ]
  return lines.join('\n')
}
