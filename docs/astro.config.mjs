/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Astro configuration for the Caracal documentation site.
 */

import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import starlight from '@astrojs/starlight'
import sitemap from '@astrojs/sitemap'
import { remarkMermaid } from './src/plugins/remarkMermaid.mjs'

const site = 'https://docs.caracal.run'
const ogImage = '/img/caracal.png'
const description =
  'Pre-execution authority enforcement for AI agents. Policies, mandates, and audit for production-grade autonomous systems.'

export default defineConfig({
  output: 'static',
  redirects: {
    '/get-started/choose-your-path/': '/get-started/',
    '/get-started/welcome/': '/get-started/',
    '/get-started/installation/': '/get-started/install-caracal/',
    '/get-started/quickstart/': '/get-started/first-protected-call/',
    '/get-started/five-minute-setup/': '/get-started/first-protected-call/',
    '/get-started/first-integration/': '/get-started/add-sdk-to-your-app/',
    '/get-started/key-ideas/': '/concepts/model-overview/',
    '/get-started/what-caracal-does/': '/concepts/authority-model/',
    '/get-started/contributor-quickstart/': '/contributing/setup/',
    '/tutorials/protect-real-api/': '/tutorials/protect-an-api/',
    '/tutorials/connect-sdk-app/': '/tutorials/connect-an-agent/',
    '/tutorials/trace-request/': '/tutorials/inspect-a-run/',
    '/guides/model-application/': '/guides/modeling-recipes/',
    '/guides/debug-authorization/': '/guides/authorize-access/',
    '/guides/production-integration-patterns/': '/guides/enterprise-runtime-patterns/',
  },
  markdown: {
    remarkPlugins: [remarkMermaid],
  },
  site,
  trailingSlash: 'always',
  build: {
    inlineStylesheets: 'auto',
  },
  integrations: [
    react(),
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
        Head: './src/components/Head.astro',
        Header: './src/components/Header.astro',
        Hero: './src/components/Hero.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        Footer: './src/components/DocFooter.astro',
        PageSidebar: './src/components/PageSidebar.astro',
      },
      sidebar: [
        { label: 'Blogs', link: '/blogs/' },
        { label: 'Vlogs', link: '/vlogs/' },
        {
          label: 'Get Started',
          items: [
            { label: 'Overview', link: '/get-started/' },
            { label: 'Install Caracal', link: '/get-started/install-caracal/' },
            { label: 'First Protected Call', link: '/get-started/first-protected-call/' },
            { label: 'Add SDK to Your App', link: '/get-started/add-sdk-to-your-app/' },
            { label: 'First-Run Troubleshooting', link: '/get-started/first-run-troubleshooting/' },
          ],
        },
        {
          label: 'Tutorials',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/tutorials/' },
            { label: 'Protect Your First Real API', link: '/tutorials/protect-an-api/' },
            { label: 'Connect Your App with the SDK', link: '/tutorials/connect-an-agent/' },
            { label: 'Trace One Protected Request', link: '/tutorials/inspect-a-run/' },
            { label: 'Choose Your Production Integration Path', link: '/tutorials/choose-production-path/' },
          ],
        },
        {
          label: 'Guides',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/guides/' },
            {
              label: 'Plan the Integration',
              items: [
                { label: 'Model Your Application in Caracal', link: '/guides/modeling-recipes/' },
                { label: 'Serve Your Own Customers', link: '/guides/serve-customers/' },
                { label: 'Define Resources and Providers', link: '/guides/resources-providers/' },
                { label: 'Provider Recipes', link: '/guides/provider-recipes/' },
              ],
            },
            {
              label: 'Authorization',
              items: [
                { label: 'Author a Rego Policy', link: '/guides/author-policy/' },
                { label: 'Activate a Policy Set', link: '/guides/activate-policy-set/' },
                { label: 'Debug Authorization Decisions', link: '/guides/authorize-access/' },
              ],
            },
            {
              label: 'Integrate Application Code',
              items: [
                { label: 'Integrate the TypeScript SDK', link: '/guides/sdk-typescript/' },
                { label: 'Integrate the Python SDK', link: '/guides/sdk-python/' },
                { label: 'Integrate the Go SDK', link: '/guides/sdk-go/' },
                { label: 'Run an Agent with caracal run', link: '/guides/runtime-run/' },
              ],
            },
            {
              label: 'Protect Resource Servers',
              items: [
                { label: 'Protect a Gateway-Routed HTTP API', link: '/guides/protect-gateway-http/' },
                { label: 'Protect an Express App', link: '/guides/protect-express/' },
                { label: 'Protect a FastMCP App', link: '/guides/protect-fastmcp/' },
                { label: 'Protect a Go net/http Service', link: '/guides/protect-nethttp/' },
                { label: 'Protect an MCP Server', link: '/guides/protect-mcp/' },
              ],
            },
            {
              label: 'Operate and Extend',
              items: [
                { label: 'Tail and Query the Audit Stream', link: '/guides/audit-stream/' },
                { label: 'Implement Multi-Agent Delegation', link: '/guides/delegation/' },
                { label: 'Step-Up Re-Authentication', link: '/guides/step-up/' },
                { label: 'Production Integration Patterns', link: '/guides/enterprise-runtime-patterns/' },
              ],
            },
          ],
        },
        {
          label: 'SDKs',
          collapsed: true,
          items: [
            { label: 'Choose an SDK or Package', link: '/sdks/' },
            {
              label: 'Language SDKs',
              collapsed: true,
              items: [
                { label: 'TypeScript SDK', link: '/sdks/typescript/' },
                { label: 'Python SDK', link: '/sdks/python/' },
                { label: 'Go SDK', link: '/sdks/go/' },
              ],
            },
            {
              label: 'Protect Resource Servers',
              collapsed: true,
              items: [
                { label: 'Verification Layer Overview', link: '/sdks/verification-layer/' },
                { label: 'Framework Connectors', link: '/sdks/connectors/' },
                { label: 'Express Connector', link: '/sdks/connectors/express/' },
                { label: 'FastMCP Connector', link: '/sdks/connectors/fastmcp/' },
                { label: 'Go net/http Connector', link: '/sdks/connectors/nethttp/' },
                { label: 'MCP Auth Transport', link: '/sdks/transport-mcp/' },
                { label: 'Identity Package', link: '/sdks/identity/' },
                { label: 'Revocation Package', link: '/sdks/revocation/' },
              ],
            },
            {
              label: 'Token Exchange and A2A',
              collapsed: true,
              items: [
                { label: 'OAuth Package', link: '/sdks/oauth/' },
                { label: 'A2A Transport', link: '/sdks/transport-a2a/' },
              ],
            },
            {
              label: 'Admin Automation',
              collapsed: true,
              items: [{ label: 'Admin Package', link: '/sdks/admin/' }],
            },
            {
              label: 'State Backends',
              collapsed: true,
              items: [
                { label: 'Redis Revocation Store', link: '/sdks/connectors/redis/' },
                { label: 'Postgres Token State Backend', link: '/sdks/connectors/postgres/' },
              ],
            },
          ],
        },
        {
          label: 'Runtime and Console',
          collapsed: true,
          items: [
            { label: 'Operate Runtime and Console', link: '/runtime-console/' },
            { label: 'Choose the Right Surface', link: '/runtime-console/cli-and-console/' },
            { label: 'Start and Check the Stack', link: '/runtime-console/stack/' },
            { label: 'Use the Console', link: '/runtime-console/console/' },
            { label: 'Configure Workloads', link: '/runtime-console/config-file/' },
            { label: 'Run Workloads', link: '/runtime-console/runtime/' },
            { label: 'Manage Product Objects', link: '/runtime-console/admin/' },
            { label: 'Inspect Diagnostics and Audit', link: '/runtime-console/observability/' },
            { label: 'Manage Agents and Delegation', link: '/runtime-console/agents/' },
          ],
        },
        {
          label: 'Concepts',
          collapsed: true,
          items: [
            { label: 'Understand the Model', link: '/concepts/' },
            {
              label: 'Foundations',
              collapsed: true,
              items: [
                { label: 'Caracal Mental Model', link: '/concepts/model-overview/' },
                { label: 'Authority and Enforcement', link: '/concepts/authority-model/' },
                { label: 'Zones', link: '/concepts/zone/' },
                { label: 'Identities and Applications', link: '/concepts/principal/' },
              ],
            },
            {
              label: 'Authorization Decisions',
              collapsed: true,
              items: [
                { label: 'Resources and Grants', link: '/concepts/resource-grant/' },
                { label: 'Policies and Policy Sets', link: '/concepts/policy/' },
                { label: 'Step-Up Challenges', link: '/concepts/step-up/' },
                { label: 'Mandates', link: '/concepts/mandate/' },
              ],
            },
            {
              label: 'Agent Authority',
              collapsed: true,
              items: [
                { label: 'Agent Delegation', link: '/concepts/delegation/' },
                { label: 'Delegation Constraints', link: '/concepts/constraint/' },
                { label: 'Sessions and Revocation', link: '/concepts/sessions-revocation/' },
              ],
            },
            {
              label: 'Audit and Assurance',
              collapsed: true,
              items: [{ label: 'Audit and Request Traces', link: '/concepts/audit-ledger/' }],
            },
          ],
        },
        {
          label: 'Operations',
          collapsed: true,
          items: [
            { label: 'Operate Caracal', link: '/operations/' },
            {
              label: 'Deploy',
              collapsed: true,
              items: [
                { label: 'Deploy with Docker Compose', link: '/operations/docker-compose/' },
                { label: 'Deploy with Helm', link: '/operations/kubernetes-helm/' },
                { label: 'Choose a Cloud Profile', link: '/operations/cloud-native-profiles/' },
                { label: 'Deploy on Managed Kubernetes', link: '/operations/cloud-reference-deployments/' },
                { label: 'Package an Install Kit', link: '/operations/enterprise-install-kit/' },
              ],
            },
            {
              label: 'Configure and Secure',
              collapsed: true,
              items: [
                { label: 'Configure Service Environment', link: '/operations/env-vars/' },
                { label: 'Harden Production', link: '/operations/tls-hardening/' },
                { label: 'Rotate Keys and Secrets', link: '/operations/key-management/' },
                { label: 'Operate PostgreSQL', link: '/operations/postgres/' },
                { label: 'Operate Redis Streams', link: '/operations/redis/' },
                { label: 'Scale Capacity', link: '/operations/scale-capacity/' },
              ],
            },
            {
              label: 'Observe and Debug',
              collapsed: true,
              items: [
                { label: 'Monitor Health and Metrics', link: '/operations/observability/' },
                { label: 'Configure Alerts', link: '/operations/alerts/' },
                { label: 'Troubleshoot by Symptom', link: '/operations/troubleshooting/' },
                { label: 'Debug Infrastructure Issues', link: '/operations/debugging/' },
              ],
            },
            {
              label: 'Recover',
              collapsed: true,
              items: [
                { label: 'Recover from Failures', link: '/operations/failure-modes/' },
                { label: 'Run Failure Drills', link: '/operations/failure-drills/' },
                { label: 'Back Up and Retain Data', link: '/operations/backup-retention/' },
                { label: 'Respond to Incidents', link: '/operations/incident-response/' },
              ],
            },
            {
              label: 'Release and Handoff',
              collapsed: true,
              items: [
                { label: 'Plan a Platform Rollout', link: '/operations/platform-rollout-kit/' },
                { label: 'Deploy Policy Changes', link: '/operations/policy-deployment/' },
                { label: 'Upgrade Caracal', link: '/operations/upgrade/' },
                { label: 'Export Audit Evidence', link: '/operations/compliance-audit-integration/' },
                { label: 'Hand Off to Platform Teams', link: '/operations/platform-team-handoff/' },
              ],
            },
          ],
        },
        {
          label: 'Security',
          collapsed: true,
          items: [
            { label: 'Secure Caracal', link: '/security/' },
            { label: 'Review the Threat Model', link: '/security/threat-model/' },
            { label: 'Harden Security Posture', link: '/security/hardening/' },
            { label: 'Verify a Release', link: '/security/verify-releases/' },
            { label: 'Report a Vulnerability', link: '/security/disclosure/' },
          ],
        },
        {
          label: 'Examples',
          collapsed: true,
          items: [
            { label: 'Use Examples', link: '/examples/' },
            {
              label: 'Local Targets',
              collapsed: true,
              items: [{ label: 'Run Echo Upstream', link: '/examples/echo-upstream/' }],
            },
            {
              label: 'Automation',
              collapsed: true,
              items: [
                { label: 'Bootstrap Control State', link: '/examples/control-bootstrap/' },
                { label: 'Check Provider Readiness', link: '/examples/provider-preflight/' },
                { label: 'Iterate Policy Safely', link: '/examples/policy-iterate/' },
              ],
            },
            {
              label: 'Agent Launch',
              collapsed: true,
              items: [{ label: 'Launch Research Agent', link: '/examples/research-agent/' }],
            },
            {
              label: 'Reference Lab',
              collapsed: true,
              items: [{ label: 'Run Lynx Capital', link: '/examples/lynx-capital/' }],
            },
          ],
        },
        {
          label: 'Contributing',
          collapsed: true,
          items: [
            { label: 'Contribute to Caracal', link: '/contributing/' },
            {
              label: 'Contributor Path',
              collapsed: true,
              items: [
                { label: 'Set Up Locally', link: '/contributing/setup/' },
                { label: 'Follow Project Standards', link: '/contributing/style/' },
                { label: 'Make a Change', link: '/contributing/workflow/' },
                { label: 'Validate Changes', link: '/contributing/testing/' },
              ],
            },
            {
              label: 'Maintainer Path',
              collapsed: true,
              items: [
                { label: 'Understand Governance', link: '/contributing/governance/' },
                { label: 'Release Caracal', link: '/contributing/release/' },
              ],
            },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'Use Reference', link: '/reference/' },
            {
              label: 'Find Answers',
              collapsed: true,
              items: [
                { label: 'FAQ', link: '/reference/faq/' },
                { label: 'Glossary', link: '/reference/glossary/' },
                { label: 'Error Codes', link: '/reference/errors/' },
              ],
            },
            {
              label: 'Configure and Run',
              collapsed: true,
              items: [
                { label: 'Configuration Keys', link: '/reference/configuration/' },
                { label: 'Configuration Order', link: '/reference/config-precedence/' },
                { label: 'Defaults and Limits', link: '/reference/defaults-and-limits/' },
                { label: 'CLI Exit Codes', link: '/reference/runtime-exit-codes/' },
              ],
            },
            {
              label: 'Versions and Contracts',
              collapsed: true,
              items: [
                { label: 'Releases', link: '/releases/' },
                { label: 'Compatibility', link: '/reference/compatibility/' },
                { label: 'Release Map', link: '/reference/release-package-runtime-map/' },
                { label: 'Wire Contracts', link: '/reference/interoperability-contracts/' },
              ],
            },
            { label: 'Compare Editions', link: '/enterprise/' },
          ],
        },
        {
          label: 'Architecture',
          collapsed: true,
          items: [
            { label: 'Understand Architecture', link: '/architecture/' },
            {
              label: 'System Flows',
              collapsed: true,
              items: [
                { label: 'Map the System', link: '/architecture/system-topology/' },
                { label: 'Exchange Tokens', link: '/architecture/token-exchange-flow/' },
                { label: 'Coordinate Agents', link: '/architecture/delegation-flow/' },
              ],
            },
            {
              label: 'State and Safety',
              collapsed: true,
              items: [
                { label: 'Propagate Events', link: '/architecture/event-streams/' },
                { label: 'Store State', link: '/architecture/storage-model/' },
                { label: 'Manage Keys', link: '/architecture/crypto-keys/' },
                { label: 'Enforce Boundaries', link: '/architecture/trust-boundaries/' },
              ],
            },
          ],
        },
        {
          label: 'Services',
          collapsed: true,
          items: [
            { label: 'Understand Services', link: '/services/' },
            {
              label: 'Management Plane',
              collapsed: true,
              items: [
                { label: 'Manage Product State', link: '/services/api/' },
                { label: 'Coordinate Agent State', link: '/services/coordinator/' },
              ],
            },
            {
              label: 'Authority Path',
              collapsed: true,
              items: [
                { label: 'Issue Mandates', link: '/services/sts/' },
                { label: 'Protect Upstreams', link: '/services/gateway/' },
              ],
            },
            {
              label: 'Evidence and Automation',
              collapsed: true,
              items: [
                { label: 'Ingest Audit Evidence', link: '/services/audit/' },
                { label: 'Automate Management', link: '/services/control/' },
              ],
            },
          ],
        },
        {
          label: 'API Reference',
          collapsed: true,
          items: [
            { label: 'Use API Reference', link: '/api/' },
            {
              label: 'Management APIs',
              collapsed: true,
              items: [
                { label: 'Use Management API', link: '/api/control-plane/' },
                { label: 'Use Coordinator API', link: '/api/coordinator/' },
              ],
            },
            {
              label: 'Authority APIs',
              collapsed: true,
              items: [
                { label: 'Use STS Endpoint', link: '/api/sts/' },
                { label: 'Proxy Through Gateway', link: '/api/gateway/' },
              ],
            },
            { label: 'Use Event Topics', link: '/api/event-topics/' },
          ],
        },
      ],
    }),
  ],
})
