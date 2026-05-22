// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// explainError unit tests.

import { describe, it, expect } from 'vitest'
import { AdminApiError } from '../../../../packages/admin/ts/src/errors.js'
import { explainError } from '../../../../apps/tui/src/errors.ts'

describe('explainError', () => {
  it('formats AdminApiError 401', () => {
    expect(explainError(new AdminApiError(401, 'unauthorized', {}))).toMatch(/CARACAL_ADMIN_TOKEN/)
  })

  it('formats AdminApiError 403 with code', () => {
    expect(explainError(new AdminApiError(403, 'insufficient_scope', {}))).toMatch(/forbidden.*insufficient_scope/)
  })

  it('formats AdminApiError 404', () => {
    expect(explainError(new AdminApiError(404, 'not_found', {}))).toMatch(/not found/)
  })

  it('hints local-services-not-running on fetch failure', () => {
    expect(explainError(new TypeError('fetch failed'))).toMatch(/local services running.*caracal up/)
  })

  it('hints local-services-not-running on ECONNREFUSED', () => {
    expect(explainError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toMatch(/caracal up/)
  })

  it('explains coordinator misconfig', () => {
    expect(explainError(new Error('coordinator_url_not_configured'))).toMatch(/CARACAL_COORDINATOR_URL/)
    expect(explainError(new Error('coordinator_token_not_configured'))).toMatch(/CARACAL_COORDINATOR_TOKEN/)
  })

  it('falls back to message for unknown errors', () => {
    expect(explainError(new Error('weird'))).toBe('weird')
    expect(explainError('plain string')).toBe('plain string')
  })
})
