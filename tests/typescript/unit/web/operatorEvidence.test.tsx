// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests that the Operator evidence artifact renders each domain's live objects as its purpose-built view.

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { OperatorEvidence } from '@/components/console/OperatorEvidence'
import type { EvidenceView } from '@/platform/operator/timeline'

function render(entries: EvidenceView[]): string {
  return renderToStaticMarkup(createElement(OperatorEvidence, { entries }))
}

describe('OperatorEvidence', () => {
  it('renders a single application domain as a headed card with the row details', () => {
    const html = render([
      {
        capability: 'listApplications',
        domain: 'application',
        count: 1,
        rows: [{ id: 'app-1', name: 'Son of Anton', registration_method: 'oidc', created_at: '2026-01-01T00:00:00Z' }],
      },
    ])
    expect(html).toContain('Applications')
    expect(html).toContain('Son of Anton')
    expect(html).toContain('oidc')
    // A single domain renders as one card, not a tab switcher.
    expect(html).not.toContain('role="tablist"')
  })

  it('states plainly when a domain is empty in the zone', () => {
    const html = render([{ capability: 'listProviders', domain: 'provider', count: 0, rows: [] }])
    expect(html).toContain('No providers in this zone.')
  })

  it('notes when the rows shown are a bounded slice of the live count', () => {
    const html = render([
      {
        capability: 'listResources',
        domain: 'resource',
        count: 25,
        rows: [
          { id: 'res-1', name: 'PiperNet', identifier: 'resource://pipernet' },
          { id: 'res-2', name: 'Not Hotdog', identifier: 'resource://not-hotdog' },
        ],
      },
    ])
    expect(html).toContain('PiperNet')
    expect(html).toContain('resource://not-hotdog')
    expect(html).toContain('Showing 2 of 25.')
  })

  it('switches several domains with segmented tabs, the first domain leading', () => {
    const html = render([
      {
        capability: 'listApplications',
        domain: 'application',
        count: 1,
        rows: [{ id: 'app-1', name: 'Fiona' }],
      },
      { capability: 'listGrants', domain: 'grant', count: 0, rows: [] },
    ])
    expect(html).toContain('role="tablist"')
    expect(html).toContain('Applications')
    expect(html).toContain('Grants')
    // Only the leading panel occupies the tabpanel.
    expect(html).toContain('Fiona')
    expect(html).not.toContain('No grants in this zone.')
  })

  it('renders grants as who reaches what with their scopes and status', () => {
    const html = render([
      {
        capability: 'listGrants',
        domain: 'grant',
        count: 1,
        rows: [
          {
            id: 'grant-1',
            application_name: 'Son of Anton',
            resource_name: 'PiperNet',
            scopes: ['read', 'write'],
            status: 'active',
            user_id: 'user:richard.hendricks@piedpiper.example',
          },
        ],
      },
    ])
    expect(html).toContain('Son of Anton')
    expect(html).toContain('PiperNet')
    expect(html).toContain('read')
    expect(html).toContain('active')
  })

  it('renders audit events as decisions with their event type', () => {
    const html = render([
      {
        capability: 'listAuditEvents',
        domain: 'audit',
        count: 1,
        rows: [{ id: 'evt-1', decision: 'deny', event_type: 'authorization.decision', request_id: 'req-1' }],
      },
    ])
    expect(html).toContain('deny')
    expect(html).toContain('authorization.decision')
  })

  it('truncates a long identifier from the middle while keeping the full value on hover', () => {
    const sessionId = '019f21dc-8299-735e-bd9d-195101a24c9f'
    const html = render([
      {
        capability: 'listAuthorityRecords',
        domain: 'authority-record',
        count: 1,
        rows: [{ id: sessionId, subject_id: sessionId, authority_record_type: 'user', status: 'active' }],
      },
    ])
    expect(html).toContain(`title="${sessionId}"`)
    expect(html).toContain('019f21dc-829')
    expect(html).not.toContain(`>${sessionId}<`)
  })

  it('falls back to label and value pairs for a domain without a dedicated row', () => {
    const html = render([
      {
        capability: 'listZones',
        domain: 'zone',
        count: 1,
        rows: [{ id: 'zone-1', name: 'Hooli Staging' }],
      },
    ])
    expect(html).toContain('Hooli Staging')
    expect(html).toContain('name')
  })

  it('renders nothing when there are no entries', () => {
    expect(render([])).toBe('')
  })
})
