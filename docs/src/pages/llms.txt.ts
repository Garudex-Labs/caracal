/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Build-time generator for the /llms.txt AI discovery file.
 */

import { getCollection } from 'astro:content'
import { logicalDocId, publishedDocs, publishedPath } from '../../versioning.mjs'

const site = 'https://docs.caracal.run'

const sections: Record<string, string[]> = {
  'Get Started': [
    'get-started',
    'get-started/install-caracal',
    'get-started/first-protected-call',
    'get-started/add-sdk-to-your-app',
    'get-started/first-run-troubleshooting',
  ],
  'Tutorials': [
    'tutorials',
    'tutorials/protect-an-api',
    'tutorials/connect-an-agent',
    'tutorials/inspect-a-run',
    'tutorials/choose-production-path',
  ],
  'Guides': [
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
    'guides/protect-fastapi',
    'guides/protect-fastmcp',
    'guides/protect-nethttp',
    'guides/protect-mcp',
    'guides/audit-stream',
    'guides/delegation',
    'guides/step-up',
    'guides/approval-notifications',
    'guides/production-patterns',
  ],
  'Core Concepts': [
    'concepts',
    'concepts/model-overview',
    'concepts/authority-model',
    'concepts/zone',
    'concepts/principal',
    'concepts/resource-grant',
    'concepts/provider',
    'concepts/policy',
    'concepts/step-up',
    'concepts/mandate',
    'concepts/delegation',
    'concepts/constraint',
    'concepts/sessions-revocation',
    'concepts/audit-ledger',
    'concepts/operator',
  ],
  'Operations': [
    'operations',
    'operations/deployment-profiles',
    'operations/docker-compose',
    'operations/kubernetes-helm',
    'operations/cloud-native-profiles',
    'operations/cloud-reference-deployments',
    'operations/opentofu',
    'operations/install-kit',
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
  ],
  'Architecture': [
    'architecture',
    'architecture/system-topology',
    'architecture/token-exchange-flow',
    'architecture/delegation-flow',
    'architecture/event-streams',
    'architecture/storage-model',
    'architecture/crypto-keys',
    'architecture/trust-boundaries',
  ],
  'Runtime and Console': [
    'runtime-console',
    'runtime-console/cli-and-console',
    'runtime-console/stack',
    'runtime-console/console',
    'runtime-console/console-access',
    'runtime-console/config-file',
    'runtime-console/runtime',
    'runtime-console/admin',
    'runtime-console/observability',
    'runtime-console/agents',
  ],
  'SDKs': [
    'sdks',
    'sdks/typescript',
    'sdks/python',
    'sdks/go',
    'sdks/verification-layer',
    'sdks/adapters',
    'sdks/adapters/express',
    'sdks/adapters/asgi',
    'sdks/adapters/fastmcp',
    'sdks/adapters/nethttp',
    'sdks/verify',
    'sdks/identity',
    'sdks/revocation',
    'sdks/oauth',
    'sdks/admin',
    'sdks/backends/redis',
  ],
  'API Reference': ['api', 'api/control-plane', 'api/coordinator', 'api/sts', 'api/gateway', 'api/event-topics'],
  'Services': ['services', 'services/api', 'services/coordinator', 'services/sts', 'services/gateway', 'services/audit', 'services/control'],
  'Security and Adoption': [
    'security',
    'security/threat-model',
    'security/hardening',
    'security/verify-releases',
    'security/evidence-pack',
    'security/adoption-review',
    'security/disclosure',
  ],
  'Examples': ['examples', 'examples/echo-upstream', 'examples/control-bootstrap', 'examples/provider-preflight', 'examples/policy-iterate', 'examples/research-agent', 'examples/lynx-capital'],
  'Reference': ['reference', 'reference/faq', 'reference/glossary', 'reference/errors', 'reference/configuration', 'reference/config-precedence', 'reference/defaults-and-limits', 'reference/runtime-exit-codes', 'reference/compatibility', 'reference/release-package-runtime-map', 'reference/interoperability-contracts'],
  'Contributing': ['contributing', 'contributing/setup', 'contributing/style', 'contributing/workflow', 'contributing/testing', 'contributing/governance', 'contributing/release'],
}

export async function GET() {
  const docs = publishedDocs(await getCollection('docs'))
  const byId = new Map(docs.map((d) => [logicalDocId(d.id), d]))

  const lines: string[] = [
    '# Caracal',
    '',
    '> Caracal gives agents and automated workloads short-lived, policy-approved authority for protected resources.',
    '',
    'Caracal is an open-source system built by Garudex Labs. Applications request scoped authority, STS evaluates the active policy set, Gateway or an in-process verifier enforces the issued Mandate, Coordinator owns Sessions and Delegations, and Audit records decisions and outcomes. Subjects and Authority records provide optional external identity attribution and revocation anchors.',
    '',
    'The runtime includes API (port 3000), STS (port 8080), Gateway (port 8081), Audit (port 9090), and Coordinator (port 4000). Control runs as an optional in-process plugin inside API. Runtime lifecycle uses the top-level caracal runtime CLI; product management uses Console, Admin SDK, or Control API.',
    '',
    '## Machine-readable endpoints',
    `- [Full Markdown corpus](${site}/llms-full.txt): Complete documentation content in one text file.`,
    `- [Page metadata index](${site}/page-index.json): JSON list of canonical HTML URLs, Markdown URLs, titles, descriptions, concepts, requirements, keywords, aliases, and services.`,
    `- [Concept graph](${site}/concept-graph.json): JSON graph of pages, concepts, and requirements.`,
    `- Per-page Markdown: ${site}/markdown/{page-id}.md, for example ${site}/markdown/guides/serve-customers.md.`,
    '',
  ]

  for (const [sectionTitle, ids] of Object.entries(sections)) {
    const entries: string[] = []
    for (const id of ids) {
      const doc = byId.get(id)
      if (!doc) continue
      entries.push(`- [${doc.data.title}](${site}${publishedPath(doc.id)}) ([Markdown](${site}/markdown/${doc.id}.md)): ${doc.data.description}`)
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
