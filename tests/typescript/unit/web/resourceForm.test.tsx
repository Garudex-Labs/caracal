// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests that the resource dialog surfaces the caracal_mandate verify affordance only when it applies.

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ResourceFormModal } from '@/components/console/ResourceForm'
import type { Provider, Resource } from '@/platform/api/types'

// The server renderer cannot host the modal portal, so the overlay renders its body and
// footer inline while every other kit component stays real.
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>()
  return {
    ...actual,
    Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement('div', null, children, footer),
  }
})

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'prov-1',
    zone_id: 'zone-1',
    name: 'Hooli OIDC',
    identifier: 'hooli-oidc',
    kind: 'oauth2_client_credentials',
    config_json: {},
    secret_config_keys: [],
    connectivity_failed_at: null,
    created_by: null,
    created_via_operator: false,
    updated_by: null,
    updated_via_operator: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function render(props: Partial<Parameters<typeof ResourceFormModal>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ResourceFormModal, {
      open: true,
      mode: 'create',
      providers: [provider()],
      busy: false,
      onClose: () => {},
      onSubmit: async () => undefined,
      ...props,
    }),
  )
}

describe('ResourceFormModal create affordances', () => {
  it('offers only Create resource when the bound provider cannot be verified', () => {
    const html = render({ providers: [provider({ kind: 'api_key' })] })
    expect(html).toContain('Create resource')
    expect(html).not.toContain('Skip for now')
  })

  it('surfaces the missing-provider notice when the zone has no providers', () => {
    const html = render({ providers: [] })
    expect(html).toContain('This zone has no provider yet.')
    expect(html).toContain('Create resource')
  })

  it('offers Skip for now once a caracal_mandate provider and an upstream URL are set', () => {
    const mandate = provider({ id: 'prov-mandate', kind: 'caracal_mandate', name: 'PiperNet mandate' })
    // Create mode seeds field state from `resource`, so the SSR render reaches the verify
    // affordance that normally appears once the operator types an upstream URL.
    const seed: Resource = {
      id: 'seed',
      zone_id: 'zone-1',
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      upstream_url: 'https://api.pipernet.example',
      scopes: ['mcp:tool:call'],
      credential_provider_id: 'prov-mandate',
      operations: [],
      operation_enforcement: 'transport_uniform',
      created_by: null,
      created_via_operator: false,
      updated_by: null,
      updated_via_operator: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const html = render({ providers: [mandate], resource: seed })
    expect(html).toContain('Skip for now')
    expect(html).toContain('Create resource')
  })
})
