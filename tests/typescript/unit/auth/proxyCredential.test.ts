// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Console BFF proxy credential selection: reads use the read token, step-up decisions use the approve token, other writes use the write token, the admin token is the break-glass fallback.

import { describe, expect, it } from 'vitest'
import { selectProxyCredential, shouldRetryWithFallback } from '../../../../apps/auth/src/proxyCredential.ts'

const ADMIN = 'cat_admin_god'
const READ = 'cat_read_only'
const WRITE = 'cat_write'
const APPROVE = 'cat_approve'
const ZONE_PATH = '/v1/zones/z1/applications'
const DECISION_PATH = '/v1/zones/z1/approvals/chal-1/approve'

describe('selectProxyCredential', () => {
  it('uses the read token with an admin fallback for GET', () => {
    expect(selectProxyCredential('GET', ZONE_PATH, ADMIN, READ, WRITE, APPROVE)).toEqual({ token: READ, fallbackToken: ADMIN })
  })

  it('uses the read token with an admin fallback for HEAD', () => {
    expect(selectProxyCredential('HEAD', ZONE_PATH, ADMIN, READ, WRITE, APPROVE)).toEqual({ token: READ, fallbackToken: ADMIN })
  })

  it('treats the method case-insensitively', () => {
    expect(selectProxyCredential('get', ZONE_PATH, ADMIN, READ, WRITE, APPROVE)).toEqual({ token: READ, fallbackToken: ADMIN })
  })

  it('uses the write token with an admin fallback for writes', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(selectProxyCredential(method, ZONE_PATH, ADMIN, READ, WRITE, APPROVE), method).toEqual({ token: WRITE, fallbackToken: ADMIN })
    }
  })

  it('presents the approve token on a step-up decision', () => {
    for (const verb of ['approve', 'reject']) {
      const path = `/v1/zones/z1/approvals/chal-1/${verb}`
      expect(selectProxyCredential('POST', path, ADMIN, READ, WRITE, APPROVE), verb).toEqual({ token: APPROVE, fallbackToken: ADMIN })
    }
  })

  it('never presents the approve token off the decision surface', () => {
    expect(selectProxyCredential('POST', ZONE_PATH, ADMIN, READ, WRITE, APPROVE).token).toBe(WRITE)
    expect(selectProxyCredential('GET', DECISION_PATH, ADMIN, READ, WRITE, APPROVE).token).toBe(READ)
    expect(selectProxyCredential('POST', '/v1/zones/z1/approvals/chal-1', ADMIN, READ, WRITE, APPROVE).token).toBe(WRITE)
  })

  it('never presents the read token on a write', () => {
    const credential = selectProxyCredential('POST', ZONE_PATH, ADMIN, READ, WRITE, APPROVE)
    expect(credential.token).toBe(WRITE)
    expect(credential.token).not.toBe(READ)
  })

  it('keeps the admin token off the normal path: no request uses it as the primary', () => {
    expect(selectProxyCredential('GET', ZONE_PATH, ADMIN, READ, WRITE, APPROVE).token).not.toBe(ADMIN)
    expect(selectProxyCredential('POST', ZONE_PATH, ADMIN, READ, WRITE, APPROVE).token).not.toBe(ADMIN)
    expect(selectProxyCredential('POST', DECISION_PATH, ADMIN, READ, WRITE, APPROVE).token).not.toBe(ADMIN)
  })

  it('falls back to the admin token on a read when no read token is configured', () => {
    expect(selectProxyCredential('GET', ZONE_PATH, ADMIN, undefined, WRITE, APPROVE)).toEqual({ token: ADMIN })
  })

  it('falls back to the admin token on a write when no write token is configured', () => {
    expect(selectProxyCredential('POST', ZONE_PATH, ADMIN, READ, undefined, APPROVE)).toEqual({ token: ADMIN })
  })

  it('falls back to the admin token on a decision when no approve token is configured', () => {
    expect(selectProxyCredential('POST', DECISION_PATH, ADMIN, READ, WRITE, undefined)).toEqual({ token: ADMIN })
  })

  it('does not set a redundant fallback when a derived token equals the admin token', () => {
    expect(selectProxyCredential('GET', ZONE_PATH, ADMIN, ADMIN, WRITE, APPROVE)).toEqual({ token: ADMIN })
    expect(selectProxyCredential('POST', ZONE_PATH, ADMIN, READ, ADMIN, APPROVE)).toEqual({ token: ADMIN })
    expect(selectProxyCredential('POST', DECISION_PATH, ADMIN, READ, WRITE, ADMIN)).toEqual({ token: ADMIN })
  })
})

describe('shouldRetryWithFallback', () => {
  it('retries on 401 when a distinct fallback exists', () => {
    expect(shouldRetryWithFallback(401, READ, ADMIN)).toBe(true)
  })

  it('does not retry on 403, a genuine authorization denial', () => {
    expect(shouldRetryWithFallback(403, READ, ADMIN)).toBe(false)
  })

  it('does not retry on a success or any non-401 status', () => {
    for (const status of [200, 204, 400, 404, 429, 500, 502]) {
      expect(shouldRetryWithFallback(status, READ, ADMIN), String(status)).toBe(false)
    }
  })

  it('does not retry when there is no fallback', () => {
    expect(shouldRetryWithFallback(401, ADMIN, undefined)).toBe(false)
  })

  it('does not retry when the fallback equals the token already used', () => {
    expect(shouldRetryWithFallback(401, ADMIN, ADMIN)).toBe(false)
  })
})
