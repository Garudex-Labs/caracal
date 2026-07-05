// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Console BFF per-account assertion: deterministic signing, verification, expiry, and tamper resistance.

import { describe, expect, it } from 'vitest'
import { signAccountAssertion, verifyAccountAssertion } from '../../../../packages/core/ts/src/accountAssertion.js'

const ADMIN = 'deployment-admin-token-xyz'
const NOW = 1_900_000_000

describe('account assertion', () => {
  it('round-trips a signed assertion', () => {
    const assertion = signAccountAssertion(ADMIN, 'acct-1', NOW + 60)
    expect(verifyAccountAssertion(ADMIN, assertion, NOW)).toEqual({ accountId: 'acct-1' })
  })

  it('is deterministic for the same inputs', () => {
    expect(signAccountAssertion(ADMIN, 'acct-1', NOW + 60)).toBe(signAccountAssertion(ADMIN, 'acct-1', NOW + 60))
  })

  it('binds the account id, so a different id never verifies under the same mac', () => {
    const assertion = signAccountAssertion(ADMIN, 'acct-1', NOW + 60)
    const swapped = assertion.replace(/\.[^.]+\./, `.${Buffer.from('acct-2').toString('base64url')}.`)
    expect(verifyAccountAssertion(ADMIN, swapped, NOW)).toBeNull()
  })

  it('rejects an expired assertion', () => {
    const assertion = signAccountAssertion(ADMIN, 'acct-1', NOW - 1)
    expect(verifyAccountAssertion(ADMIN, assertion, NOW)).toBeNull()
  })

  it('rejects an assertion signed with a different admin token', () => {
    const assertion = signAccountAssertion('other-admin', 'acct-1', NOW + 60)
    expect(verifyAccountAssertion(ADMIN, assertion, NOW)).toBeNull()
  })

  it('rejects a tampered mac', () => {
    const assertion = signAccountAssertion(ADMIN, 'acct-1', NOW + 60)
    const tampered = `${assertion.slice(0, -1)}${assertion.endsWith('A') ? 'B' : 'A'}`
    expect(verifyAccountAssertion(ADMIN, tampered, NOW)).toBeNull()
  })

  it('rejects malformed shapes', () => {
    expect(verifyAccountAssertion(ADMIN, '', NOW)).toBeNull()
    expect(verifyAccountAssertion(ADMIN, 'not-an-assertion', NOW)).toBeNull()
    expect(verifyAccountAssertion(ADMIN, 'v2.x.1.y', NOW)).toBeNull()
    expect(verifyAccountAssertion(ADMIN, `v1..${NOW + 60}.abc`, NOW)).toBeNull()
    expect(verifyAccountAssertion(ADMIN, `v1.${Buffer.from('a').toString('base64url')}.notanumber.abc`, NOW)).toBeNull()
  })
})
