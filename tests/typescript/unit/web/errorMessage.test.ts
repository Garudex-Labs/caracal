// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests the shared Console API error classification helpers used across console routes.

import { describe, it, expect } from 'vitest'
import { ConsoleApiError } from '@/platform/api/client'
import { errorMessage, coordinatorErrorMessage } from '@/platform/api/errors'

describe('errorMessage', () => {
  it('maps the control-plane not-configured and unreachable codes', () => {
    expect(errorMessage(new ConsoleApiError(503, 'control_plane_not_configured'))).toBe('Control plane not connected.')
    expect(errorMessage(new ConsoleApiError(503, 'control_plane_unreachable'))).toBe('Control plane unreachable.')
  })

  it('humanizes any other error code by default', () => {
    expect(errorMessage(new ConsoleApiError(409, 'zone_slug_conflict'))).toBe('zone slug conflict')
  })

  it('applies a route override before the shared classification', () => {
    expect(
      errorMessage(new ConsoleApiError(409, 'zone_slug_conflict'), {
        zone_slug_conflict: 'That slug is already taken.',
      }),
    ).toBe('That slug is already taken.')
  })

  it('ignores overrides that do not match the error code', () => {
    expect(errorMessage(new ConsoleApiError(409, 'other_code'), { zone_slug_conflict: 'x' })).toBe('other code')
  })

  it('falls back to a generic message for non-API errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('Unexpected error.')
    expect(errorMessage('nope')).toBe('Unexpected error.')
  })
})

describe('coordinatorErrorMessage', () => {
  it('maps the coordinator not-configured and unreachable codes', () => {
    expect(coordinatorErrorMessage(new ConsoleApiError(503, 'coordinator_not_configured'))).toBe('Coordinator service not connected.')
    expect(coordinatorErrorMessage(new ConsoleApiError(502, 'upstream_unreachable'))).toBe('Coordinator service unreachable.')
  })

  it('humanizes other codes and falls back for non-API errors', () => {
    expect(coordinatorErrorMessage(new ConsoleApiError(400, 'bad_request'))).toBe('bad request')
    expect(coordinatorErrorMessage(null)).toBe('Unexpected error.')
  })
})
