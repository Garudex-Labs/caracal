// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests that Console tabs, the DCR switch, and resource operation controls carry a visible focus ring.

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Tabs } from '@/components/ui/Tabs'
import { DcrField } from '@/components/console/DcrField'
import { ResourceFormModal } from '@/components/console/ResourceForm'
import type { Application, Provider, Resource } from '@/platform/api/types'

// The server renderer cannot host the modal portal, so the overlay is stubbed to render its
// body inline while every other kit component stays real.
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>()
  return {
    ...actual,
    Modal: ({ children }: { children?: ReactNode }) => children,
  }
})

const buttonRing =
  'focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background'

function tagOf(html: string, pattern: RegExp): string {
  const match = html.match(pattern)
  expect(match, `expected markup to match ${pattern}`).not.toBeNull()
  return match![0]
}

describe('Console focus ring treatment', () => {
  it('renders every tab with the button focus ring', () => {
    const html = renderToStaticMarkup(
      createElement(Tabs, {
        tabs: [
          { id: 'overview', label: 'Overview' },
          { id: 'operations', label: 'Operations', count: 2 },
        ],
        active: 'overview',
        onChange: () => {},
      }),
    )
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toContain('outline-none')
      expect(button).toContain(buttonRing)
    }
  })

  it('renders the DCR switch with the button focus ring', () => {
    const html = renderToStaticMarkup(createElement(DcrField, { enabled: false, onChange: () => {} }))
    const toggle = tagOf(html, /<button[^>]*role="switch"[^>]*>/)
    expect(toggle).toContain('outline-none')
    expect(toggle).toContain(buttonRing)
  })

  it('renders resource operation inputs with the field focus ring', () => {
    const resource: Resource = {
      id: 'res-1',
      zone_id: 'zone-1',
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      upstream_url: 'https://api.pipernet.example',
      gateway_application_id: 'app-1',
      scopes: ['read'],
      credential_provider_id: 'prov-1',
      operations: [{ method: 'GET', path: '/v1/nodes', scope: 'read' }],
      operation_enforcement: 'enforced',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const applications: Application[] = [
      {
        id: 'app-1',
        zone_id: 'zone-1',
        name: 'Son of Anton',
        registration_method: 'managed',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    const providers: Provider[] = [
      {
        id: 'prov-1',
        zone_id: 'zone-1',
        name: 'Hooli OIDC',
        identifier: 'hooli-oidc',
        kind: 'oauth2_client_credentials',
        config_json: {},
        secret_config_keys: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]
    const html = renderToStaticMarkup(
      createElement(ResourceFormModal, {
        open: true,
        mode: 'edit',
        resource,
        applications,
        providers,
        busy: false,
        onClose: () => {},
        onSubmit: () => {},
      }),
    )
    const fieldRing = 'focus:border-ring focus:ring-2 focus:ring-ring/25'
    const method = tagOf(html, /<input[^>]*aria-label="Method"[^>]*>/)
    const path = tagOf(html, /<input[^>]*value="\/v1\/nodes"[^>]*>/)
    const scope = (html.match(/<select[^>]*>/g) ?? []).find((tag) => tag.includes('font-mono'))
    expect(scope).toBeDefined()
    for (const control of [method, path, scope!]) {
      expect(control).toContain('outline-none')
      expect(control).toContain(fieldRing)
    }
  })
})
