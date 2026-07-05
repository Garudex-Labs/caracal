// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Console BFF operator-identity assertion: deterministic signing, verification, expiry, and tamper resistance.

import { describe, expect, it } from 'vitest'
import { signOperatorAssertion, verifyOperatorAssertion } from '../../../../packages/serverCore/ts/src/operatorAssertion.js'

const ADMIN = 'deployment-admin-token-xyz'
const NOW = 1_900_000_000
const IDENTITY = { id: 'op-1', name: 'Richard Hendricks', email: 'richard.hendricks@piedpiper.example' }

describe('operator assertion', () => {
  it('round-trips a signed identity', () => {
    const assertion = signOperatorAssertion(ADMIN, IDENTITY, NOW + 60)
    expect(verifyOperatorAssertion(ADMIN, assertion, NOW)).toEqual(IDENTITY)
  })

  it('is deterministic for the same inputs', () => {
    expect(signOperatorAssertion(ADMIN, IDENTITY, NOW + 60)).toBe(signOperatorAssertion(ADMIN, IDENTITY, NOW + 60))
  })

  it('rejects an expired assertion', () => {
    const assertion = signOperatorAssertion(ADMIN, IDENTITY, NOW - 1)
    expect(verifyOperatorAssertion(ADMIN, assertion, NOW)).toBeNull()
  })

  it('rejects an assertion signed with a different admin token', () => {
    const assertion = signOperatorAssertion('other-admin', IDENTITY, NOW + 60)
    expect(verifyOperatorAssertion(ADMIN, assertion, NOW)).toBeNull()
  })

  it('rejects a tampered mac', () => {
    const assertion = signOperatorAssertion(ADMIN, IDENTITY, NOW + 60)
    const tampered = `${assertion.slice(0, -1)}${assertion.endsWith('A') ? 'B' : 'A'}`
    expect(verifyOperatorAssertion(ADMIN, tampered, NOW)).toBeNull()
  })

  it('rejects a tampered payload under the same mac', () => {
    const assertion = signOperatorAssertion(ADMIN, IDENTITY, NOW + 60)
    const forged = Buffer.from(JSON.stringify({ id: 'op-1', name: 'Gavin Belson', email: 'x' })).toString('base64url')
    const parts = assertion.split('.')
    const swapped = `${parts[0]}.${forged}.${parts[2]}.${parts[3]}`
    expect(verifyOperatorAssertion(ADMIN, swapped, NOW)).toBeNull()
  })

  it('rejects malformed shapes', () => {
    expect(verifyOperatorAssertion(ADMIN, '', NOW)).toBeNull()
    expect(verifyOperatorAssertion(ADMIN, 'not-an-assertion', NOW)).toBeNull()
    expect(verifyOperatorAssertion(ADMIN, 'v2.x.1.y', NOW)).toBeNull()
    expect(verifyOperatorAssertion(ADMIN, `v1..${NOW + 60}.abc`, NOW)).toBeNull()
    expect(verifyOperatorAssertion(ADMIN, `v1.${Buffer.from('a').toString('base64url')}.notanumber.abc`, NOW)).toBeNull()
  })
})
