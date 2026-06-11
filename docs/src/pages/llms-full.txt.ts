/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Build-time generator for the /llms-full.txt complete content file.
 */

import { getCollection } from 'astro:content'

const site = 'https://docs.caracal.run'

// Reader order: onboarding first, then tutorials, guides, concepts, and reference material.
const pageOrder = [
  'get-started',
  'get-started/install-caracal',
  'get-started/first-protected-call',
  'get-started/add-sdk-to-your-app',
  'get-started/first-run-troubleshooting',
  'tutorials',
  'tutorials/protect-an-api',
  'tutorials/connect-an-agent',
  'tutorials/inspect-a-run',
  'tutorials/choose-production-path',
  'guides',
  'guides/modeling-recipes',
  'guides/serve-customers',
  'guides/resources-providers',
  'guides/provider-recipes',
  'guides/author-policy',
  'guides/activate-policy-set',
  'guides/authorize-access',
  'guides/sdk-typescript',
  'guides/sdk-python',
  'guides/sdk-go',
  'guides/runtime-run',
  'guides/protect-gateway-http',
  'guides/protect-express',
  'guides/protect-fastmcp',
  'guides/protect-nethttp',
  'guides/protect-mcp',
  'guides/audit-stream',
  'guides/delegation',
  'guides/step-up',
  'guides/enterprise-runtime-patterns',
  'concepts',
  'concepts/model-overview',
  'concepts/authority-model',
  'concepts/zone',
  'concepts/principal',
  'concepts/resource-grant',
  'concepts/policy',
  'concepts/step-up',
  'concepts/mandate',
  'concepts/delegation',
  'concepts/constraint',
  'concepts/sessions-revocation',
  'concepts/audit-ledger',
  'operations',
  'operations/docker-compose',
  'operations/kubernetes-helm',
  'operations/cloud-native-profiles',
  'operations/cloud-reference-deployments',
  'operations/enterprise-install-kit',
  'operations/env-vars',
  'operations/tls-hardening',
  'operations/key-management',
  'operations/postgres',
  'operations/redis',
  'operations/scale-capacity',
  'operations/observability',
  'operations/alerts',
  'operations/troubleshooting',
  'operations/debugging',
  'operations/failure-modes',
  'operations/failure-drills',
  'operations/backup-retention',
  'operations/incident-response',
  'operations/platform-rollout-kit',
  'operations/policy-deployment',
  'operations/upgrade',
  'operations/compliance-audit-integration',
  'operations/platform-team-handoff',
  'architecture',
  'architecture/system-topology',
  'architecture/token-exchange-flow',
  'architecture/delegation-flow',
  'architecture/event-streams',
  'architecture/storage-model',
  'architecture/crypto-keys',
  'architecture/trust-boundaries',
  'runtime-console',
  'runtime-console/cli-and-console',
  'runtime-console/stack',
  'runtime-console/console',
  'runtime-console/config-file',
  'runtime-console/runtime',
  'runtime-console/admin',
  'runtime-console/observability',
  'runtime-console/agents',
  'sdks',
  'sdks/typescript',
  'sdks/python',
  'sdks/go',
  'sdks/verification-layer',
  'sdks/connectors',
  'sdks/connectors/express',
  'sdks/connectors/fastmcp',
  'sdks/connectors/nethttp',
  'sdks/transport-mcp',
  'sdks/identity',
  'sdks/revocation',
  'sdks/oauth',
  'sdks/transport-a2a',
  'sdks/admin',
  'sdks/connectors/redis',
  'sdks/connectors/postgres',
  'security',
  'security/threat-model',
  'security/hardening',
  'security/disclosure',
  'examples',
  'examples/echo-upstream',
  'examples/control-bootstrap',
  'examples/provider-preflight',
  'examples/policy-iterate',
  'examples/research-agent',
  'examples/lynx-capital',
  'api',
  'api/control-plane',
  'api/coordinator',
  'api/sts',
  'api/gateway',
  'api/event-topics',
  'services',
  'services/api',
  'services/coordinator',
  'services/sts',
  'services/gateway',
  'services/audit',
  'services/control',
  'reference',
  'reference/faq',
  'reference/glossary',
  'reference/errors',
  'reference/configuration',
  'reference/config-precedence',
  'reference/defaults-and-limits',
  'reference/runtime-exit-codes',
  'reference/compatibility',
  'reference/release-package-runtime-map',
  'reference/interoperability-contracts',
  'enterprise',
  'contributing',
  'contributing/setup',
  'contributing/style',
  'contributing/workflow',
  'contributing/testing',
  'contributing/governance',
  'contributing/release',
]

export async function GET() {
  const docs = await getCollection('docs')
  const byId = new Map(docs.map((d) => [d.id, d]))

  const header = [
    '# Caracal',
    '',
    '> Pre-execution authority enforcement for AI agents. Policies, mandates, and audit for production-grade autonomous systems.',
    '',
    'Caracal is an open-source system built by Garudex Labs. It issues short-lived signed mandates that bind agents and workloads to policy before protected-resource access.',
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
    `# Markdown: ${base}/markdown/${doc.id}.md`,
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
