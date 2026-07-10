// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Delegation formatting: identity shortening, status tone/label, and error messages.

import { describe, expect, it } from 'vitest'

import { ConsoleApiError } from '../../../../apps/web/src/platform/api/client.ts'
import type { DelegationEdge } from '../../../../apps/web/src/platform/api/types.ts'
import {
  delegationErrorMessage,
  edgeStatusLabel,
  edgeStatusTone,
  shortId,
} from '../../../../apps/web/src/components/console/delegationFormat.ts'

function edge(overrides: Partial<DelegationEdge>): DelegationEdge {
  return {
    id: 'edge-1',
    zone_id: 'z1',
    source_session_id: 's1',
    target_session_id: 's2',
    issuer_application_id: null,
    receiver_application_id: null,
    parent_edge_id: null,
    resource_id: null,
    scopes: [],
    constraints_json: null,
    status: 'active',
    edge_version: 1,
    expires_at: null,
    revoked_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString()
const HOUR_AHEAD = new Date(Date.now() + 3_600_000).toISOString()

describe('shortId', () => {
  it('abbreviates long ids and leaves short ones intact', () => {
    expect(shortId('0123456789abcdef0123')).toBe('01234567…0123')
    expect(shortId('short')).toBe('short')
    expect(shortId('123456789012')).toBe('123456789012')
  })
})

describe('delegationErrorMessage', () => {
  it('translates known coordinator error codes', () => {
    expect(delegationErrorMessage(new ConsoleApiError(503, 'coordinator_not_configured'))).toBe('Coordinator service not connected.')
    expect(delegationErrorMessage(new ConsoleApiError(502, 'upstream_unreachable'))).toBe('Coordinator service unreachable.')
  })

  it('humanizes an unknown ConsoleApiError code', () => {
    expect(delegationErrorMessage(new ConsoleApiError(400, 'scope_not_granted'))).toBe('scope not granted')
  })

  it('returns a generic message for non-API errors', () => {
    expect(delegationErrorMessage(new Error('boom'))).toBe('Unexpected error.')
    expect(delegationErrorMessage(undefined)).toBe('Unexpected error.')
  })
})

describe('edgeStatusTone', () => {
  it('flags revoked and expired edges as danger', () => {
    expect(edgeStatusTone(edge({ status: 'revoked' }))).toBe('danger')
    expect(edgeStatusTone(edge({ status: 'expired' }))).toBe('danger')
  })

  it('marks an active edge past its expiry as muted, never healthy', () => {
    expect(edgeStatusTone(edge({ status: 'active', expires_at: HOUR_AGO }))).toBe('muted')
  })

  it('shows a live active edge as success', () => {
    expect(edgeStatusTone(edge({ status: 'active', expires_at: HOUR_AHEAD }))).toBe('success')
    expect(edgeStatusTone(edge({ status: 'active', expires_at: null }))).toBe('success')
  })
})

describe('edgeStatusLabel', () => {
  it('labels an active-but-past-expiry edge as expiring', () => {
    expect(edgeStatusLabel(edge({ status: 'active', expires_at: HOUR_AGO }))).toBe('expiring')
  })

  it('echoes the raw status otherwise', () => {
    expect(edgeStatusLabel(edge({ status: 'active', expires_at: HOUR_AHEAD }))).toBe('active')
    expect(edgeStatusLabel(edge({ status: 'revoked' }))).toBe('revoked')
  })
})
