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
      },
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Overview', link: '/start/' },
            { label: 'Introduction', link: '/start/overview/' },
            { label: 'Installation', link: '/start/installation/' },
            { label: 'Quickstart', link: '/start/quickstart/' },
          ],
        },
        {
          label: 'Concepts',
          collapsed: false,
          items: [
            { label: 'Overview', link: '/concepts/' },
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
            { label: 'Overview', link: '/architecture/' },
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
            { label: 'Overview', link: '/cli/' },
            { label: 'Commands', link: '/cli/overview/' },
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
            { label: 'Overview', link: '/configuration/' },
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
            { label: 'Overview', link: '/ai/' },
            { label: 'Agent Workflows', link: '/ai/workflows/' },
            { label: 'MCP Integration', link: '/ai/mcp/' },
            { label: 'Coordinator', link: '/ai/coordinator/' },
          ],
        },
        {
          label: 'SDKs',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/sdk/' },
            { label: 'TypeScript', link: '/sdk/typescript/' },
            { label: 'Python', link: '/sdk/python/' },
            { label: 'Go', link: '/sdk/go/' },
          ],
        },
        {
          label: 'Security',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/security/' },
            { label: 'Threat Model', link: '/security/threat-model/' },
            { label: 'Disclosure Policy', link: '/security/disclosure/' },
            { label: 'Hardening', link: '/security/hardening/' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/reference/' },
            { label: 'API', link: '/reference/api/' },
            { label: 'Glossary', link: '/reference/glossary/' },
          ],
        },
        {
          label: 'Contributing',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/contributing/' },
            { label: 'Setup', link: '/contributing/setup/' },
            { label: 'Workflow', link: '/contributing/workflow/' },
            { label: 'Code Style', link: '/contributing/style/' },
          ],
        },
      ],
    }),
  ],
})
