/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Astro configuration for the Caracal documentation site.
 */

import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import sitemap from '@astrojs/sitemap'

const site = 'https://docs.garudexlabs.com'
const ogImage = '/img/caracal.png'
const description =
  'Pre-execution authority enforcement for AI agents. Policies, mandates, and audit for production-grade autonomous systems.'

export default defineConfig({
  output: 'static',
  site,
  trailingSlash: 'always',
  build: {
    inlineStylesheets: 'auto',
  },
  integrations: [
    sitemap(),
    starlight({
      title: 'Caracal',
      description,
      logo: {
        light: './src/assets/caracal.png',
        dark: './src/assets/caracal_inverted.png',
        replacesTitle: false,
      },
      favicon: '/img/caracal.png',
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:site_name', content: 'Caracal' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:type', content: 'website' },
        },
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: `${site}${ogImage}` },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:image', content: `${site}${ogImage}` },
        },
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#0b0b0e' },
        },
        {
          tag: 'meta',
          attrs: { name: 'color-scheme', content: 'dark light' },
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'Caracal',
            description,
            url: site,
            author: { '@type': 'Organization', name: 'Garudex Labs' },
            license: 'https://www.apache.org/licenses/LICENSE-2.0',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Linux, macOS',
            programmingLanguage: ['Go', 'TypeScript', 'Python'],
          }),
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/Garudex-Labs/caracal/edit/main/docs/',
      },
      lastUpdated: true,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      components: {
        Header: './src/components/Header.astro',
        Hero: './src/components/Hero.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        Footer: './src/components/DocFooter.astro',
        PageSidebar: './src/components/PageSidebar.astro',
      },
      sidebar: [
        {
          label: 'Get Started',
          items: [
            { label: 'Overview', link: '/get-started/' },
            { label: 'Welcome', link: '/get-started/welcome/' },
            { label: 'What Caracal Does', link: '/get-started/what-caracal-does/' },
            { label: 'Installation', link: '/get-started/installation/' },
            { label: 'Quickstart: Run the Stack', link: '/get-started/quickstart/' },
            { label: 'First Integration', link: '/get-started/first-integration/' },
            { label: 'Key Ideas at a Glance', link: '/get-started/key-ideas/' },
          ],
        },
        {
          label: 'Concepts',
          collapsed: false,
          items: [
            { label: 'Overview', link: '/concepts/' },
            { label: 'Authority Model', link: '/concepts/authority-model/' },
            { label: 'Mandate', link: '/concepts/mandate/' },
            { label: 'Policy', link: '/concepts/policy/' },
            { label: 'Principal and Application', link: '/concepts/principal/' },
            { label: 'Zone', link: '/concepts/zone/' },
            { label: 'Resource and Grant', link: '/concepts/resource-grant/' },
            { label: 'Delegation Graph', link: '/concepts/delegation/' },
            { label: 'Caveats and Constraints', link: '/concepts/caveat/' },
            { label: 'Sessions and Revocation', link: '/concepts/sessions-revocation/' },
            { label: 'Audit Ledger', link: '/concepts/audit-ledger/' },
            { label: 'Step-Up Challenge', link: '/concepts/step-up/' },
          ],
        },
        {
          label: 'Architecture',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/architecture/' },
            { label: 'System Topology', link: '/architecture/system-topology/' },
            { label: 'Token Exchange Flow', link: '/architecture/token-exchange-flow/' },
            { label: 'Delegation and Coordinator Flow', link: '/architecture/delegation-flow/' },
            { label: 'Event Streams and Outbox', link: '/architecture/event-streams/' },
            { label: 'Storage Model', link: '/architecture/storage-model/' },
            { label: 'Cryptography and Keys', link: '/architecture/crypto-keys/' },
            { label: 'Trust Boundaries', link: '/architecture/trust-boundaries/' },
          ],
        },
        {
          label: 'Guides',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/guides/' },
            { label: 'Integrate the TypeScript SDK', link: '/guides/sdk-typescript/' },
            { label: 'Integrate the Python SDK', link: '/guides/sdk-python/' },
            { label: 'Integrate the Go SDK', link: '/guides/sdk-go/' },
            { label: 'Protect an MCP Server', link: '/guides/protect-mcp/' },
            { label: 'Protect an Express App', link: '/guides/protect-express/' },
            { label: 'Protect a FastMCP App', link: '/guides/protect-fastmcp/' },
            { label: 'Protect a Go net/http Service', link: '/guides/protect-nethttp/' },
            { label: 'Author a Rego Policy', link: '/guides/author-policy/' },
            { label: 'Activate a Policy Set', link: '/guides/activate-policy-set/' },
            { label: 'Define Resources and Providers', link: '/guides/resources-providers/' },
            { label: 'Issue Grants and Invitations', link: '/guides/grants-invitations/' },
            { label: 'Implement Multi-Agent Delegation', link: '/guides/delegation/' },
            { label: 'Tail and Query the Audit Stream', link: '/guides/audit-stream/' },
            { label: 'Run an Agent with caracal run', link: '/guides/cli-run/' },
            { label: 'Step-Up Re-Authentication', link: '/guides/step-up/' },
          ],
        },
        {
          label: 'SDKs',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/sdks/' },
            { label: 'TypeScript SDK', link: '/sdks/typescript/' },
            { label: 'Python SDK', link: '/sdks/python/' },
            { label: 'Go SDK', link: '/sdks/go/' },
            { label: 'Identity Package', link: '/sdks/identity/' },
            { label: 'OAuth Package', link: '/sdks/oauth/' },
            { label: 'Revocation Package', link: '/sdks/revocation/' },
            { label: 'Admin Package', link: '/sdks/admin/' },
            { label: 'MCP Transport', link: '/sdks/transport-mcp/' },
            { label: 'A2A Transport', link: '/sdks/transport-a2a/' },
            {
              label: 'Connectors',
              collapsed: true,
              items: [
                { label: 'Overview', link: '/sdks/connectors/' },
                { label: 'Express', link: '/sdks/connectors/express/' },
                { label: 'FastMCP', link: '/sdks/connectors/fastmcp/' },
                { label: 'Go net/http', link: '/sdks/connectors/nethttp/' },
                { label: 'Postgres Token State', link: '/sdks/connectors/postgres/' },
                { label: 'Redis Token State', link: '/sdks/connectors/redis/' },
              ],
            },
          ],
        },
        {
          label: 'CLI and TUI',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/cli-tui/' },
            { label: 'Stack Commands', link: '/cli-tui/stack/' },
            { label: 'Runtime Commands', link: '/cli-tui/runtime/' },
            { label: 'Admin Commands', link: '/cli-tui/admin/' },
            { label: 'Observability Commands', link: '/cli-tui/observability/' },
            { label: 'Agent and Delegation Commands', link: '/cli-tui/agents/' },
            { label: 'Configuration File', link: '/cli-tui/config-file/' },
            { label: 'TUI Walkthrough', link: '/cli-tui/tui/' },
          ],
        },
        {
          label: 'Services',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/services/' },
            { label: 'Control-Plane API', link: '/services/api/' },
            { label: 'Coordinator', link: '/services/coordinator/' },
            { label: 'STS', link: '/services/sts/' },
            { label: 'Gateway', link: '/services/gateway/' },
            { label: 'Audit', link: '/services/audit/' },
          ],
        },
        {
          label: 'API Reference',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/api/' },
            { label: 'Control-Plane REST', link: '/api/control-plane/' },
            { label: 'Coordinator REST', link: '/api/coordinator/' },
            { label: 'STS Token Endpoint', link: '/api/sts/' },
            { label: 'Gateway Behavior', link: '/api/gateway/' },
            { label: 'Event Topics', link: '/api/event-topics/' },
          ],
        },
        {
          label: 'Operations',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/operations/' },
            { label: 'Deployment with Docker Compose', link: '/operations/docker-compose/' },
            { label: 'Environment Variables', link: '/operations/env-vars/' },
            { label: 'PostgreSQL', link: '/operations/postgres/' },
            { label: 'Redis Streams', link: '/operations/redis/' },
            { label: 'TLS and Production Hardening', link: '/operations/tls-hardening/' },
            { label: 'Key Management and Rotation', link: '/operations/key-management/' },
            { label: 'Observability and Health', link: '/operations/observability/' },
            { label: 'Backup and Retention', link: '/operations/backup-retention/' },
            { label: 'Incident Response', link: '/operations/incident-response/' },
          ],
        },
        {
          label: 'Security',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/security/' },
            { label: 'Threat Model', link: '/security/threat-model/' },
            { label: 'Hardening Checklist', link: '/security/hardening/' },
            { label: 'Disclosure Policy', link: '/security/disclosure/' },
          ],
        },
        {
          label: 'Examples',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/examples/' },
            { label: 'Lynx Capital: Autonomous Payouts', link: '/examples/lynx-capital/' },
          ],
        },
        {
          label: 'Contributing',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/contributing/' },
            { label: 'Local Setup', link: '/contributing/setup/' },
            { label: 'Development Workflow', link: '/contributing/workflow/' },
            { label: 'Code Style', link: '/contributing/style/' },
            { label: 'Testing', link: '/contributing/testing/' },
            { label: 'Release and Versioning', link: '/contributing/release/' },
            { label: 'Governance', link: '/contributing/governance/' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/reference/' },
            { label: 'Glossary', link: '/reference/glossary/' },
            { label: 'Error Reference', link: '/reference/errors/' },
            { label: 'Configuration Reference', link: '/reference/configuration/' },
            { label: 'Compatibility Matrix', link: '/reference/compatibility/' },
          ],
        },
      ],
    }),
  ],
})
