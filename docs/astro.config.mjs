/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Astro configuration for the Caracal documentation site.
 */

import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  output: 'static',
  site: 'https://docs.garudexlabs.com',
  integrations: [
    starlight({
      title: 'Caracal',
      description:
        'Pre-execution authority enforcement for AI agents. Policies, mandates, and audit for production-grade autonomous systems.',
      logo: {
        light: './src/assets/caracal.png',
        dark: './src/assets/caracal_inverted.png',
        replacesTitle: false,
      },
      favicon: '/img/caracal.png',
      customCss: ['./src/styles/custom.css'],
      editLink: {
        baseUrl: 'https://github.com/Garudex-Labs/caracal/edit/main/docs/',
      },
      lastUpdated: true,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
      components: {
        Hero: './src/components/Hero.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Overview', link: '/start/overview/' },
            { label: 'Installation', link: '/start/installation/' },
            { label: 'Quickstart', link: '/start/quickstart/' },
          ],
        },
        {
          label: 'Concepts',
          collapsed: false,
          items: [
            { label: 'Authority Enforcement Model', link: '/concepts/authority-enforcement/' },
            { label: 'Mandate', link: '/concepts/mandate/' },
            { label: 'Policy', link: '/concepts/policy/' },
            { label: 'Principal', link: '/concepts/principal/' },
            { label: 'Delegation', link: '/concepts/delegation/' },
            { label: 'Caveat', link: '/concepts/caveat/' },
            { label: 'Intent', link: '/concepts/intent/' },
            { label: 'Workspace', link: '/concepts/workspace/' },
            { label: 'Ledger', link: '/concepts/ledger/' },
          ],
        },
        {
          label: 'Architecture',
          collapsed: true,
          items: [
            { label: 'System Overview', link: '/architecture/system/' },
            { label: 'Runtime Model', link: '/architecture/runtime/' },
            { label: 'Services', link: '/architecture/services/' },
            { label: 'Storage & Data', link: '/architecture/storage/' },
            { label: 'Threat Model', link: '/architecture/threat-model/' },
          ],
        },
        {
          label: 'CLI',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/cli/overview/' },
            { label: 'caracal up / down / status', link: '/cli/stack/' },
            { label: 'caracal init', link: '/cli/init/' },
            { label: 'caracal run', link: '/cli/run/' },
            { label: 'audit & explain', link: '/cli/audit/' },
            { label: 'agent & delegation', link: '/cli/agent/' },
          ],
        },
        {
          label: 'Configuration',
          collapsed: true,
          items: [
            { label: 'Environment Variables', link: '/configuration/env/' },
            { label: 'Database', link: '/configuration/database/' },
            { label: 'Redis', link: '/configuration/redis/' },
            { label: 'Logging', link: '/configuration/logging/' },
            { label: 'MCP Adapter', link: '/configuration/mcp/' },
          ],
        },
        {
          label: 'AI Agents',
          collapsed: true,
          items: [
            { label: 'Agent Workflows', link: '/ai/workflows/' },
            { label: 'MCP Integration', link: '/ai/mcp/' },
            { label: 'Coordinator', link: '/ai/coordinator/' },
          ],
        },
        {
          label: 'SDKs',
          collapsed: true,
          items: [
            { label: 'TypeScript', link: '/sdk/typescript/' },
            { label: 'Python', link: '/sdk/python/' },
            { label: 'Go', link: '/sdk/go/' },
          ],
        },
        {
          label: 'Security',
          collapsed: true,
          items: [
            { label: 'Threat Model', link: '/security/threat-model/' },
            { label: 'Disclosure Policy', link: '/security/disclosure/' },
            { label: 'Hardening', link: '/security/hardening/' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'API', link: '/reference/api/' },
            { label: 'Glossary', link: '/reference/glossary/' },
          ],
        },
        {
          label: 'Contributing',
          collapsed: true,
          items: [
            { label: 'Setup', link: '/contributing/setup/' },
            { label: 'Workflow', link: '/contributing/workflow/' },
            { label: 'Code Style', link: '/contributing/style/' },
          ],
        },
      ],
    }),
  ],
})
