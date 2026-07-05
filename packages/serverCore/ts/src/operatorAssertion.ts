// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Deterministic signing and verification of the Console BFF's operator-identity assertion that carries the authenticated operator's display name and email to the API for creator attribution.

import { createHmac, timingSafeEqual } from 'node:crypto'

// The domain-separation label for the operator-identity MAC, versioned and distinct from the
// account assertion so the two signals can never be confused for one another. It is keyed by the
// deployment admin token both the BFF and API hold, so forging it needs a credential whose holder
// already has full deployment authority - it grants nothing new, exactly like the account assertion.
const OPERATOR_ASSERTION_LABEL = 'caracal:operator:v1'
const OPERATOR_ASSERTION_PREFIX = 'v1'

// A defensive ceiling on the serialized identity so a malformed or hostile header cannot blow up
// the MAC computation. A name and email pair is well within this.
const MAX_IDENTITY_BYTES = 1024

export interface OperatorIdentity {
  id: string
  name: string
  email: string
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function fromB64url(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

function mac(adminToken: string, payload: string, exp: number): string {
  return createHmac('sha256', adminToken).update(`${OPERATOR_ASSERTION_LABEL}:${payload}:${exp}`).digest('base64url')
}

// Signs an assertion binding the operator's identity to an expiry. The result is a compact dotted
// token `v1.<b64url(json)>.<exp>.<mac>` the BFF attaches to each proxied request; the API recomputes
// the MAC with the same admin token to verify it. exp is an absolute Unix time in seconds, kept short
// by the caller so a captured assertion is only briefly replayable.
export function signOperatorAssertion(adminToken: string, identity: OperatorIdentity, exp: number): string {
  const payload = b64url(JSON.stringify({ id: identity.id, name: identity.name, email: identity.email }))
  return `${OPERATOR_ASSERTION_PREFIX}.${payload}.${exp}.${mac(adminToken, payload, exp)}`
}

// Verifies an assertion and returns the bound identity, or null if it is malformed, expired, or its
// MAC does not match - so the caller attributes to the operator only on a positively verified
// assertion and otherwise falls back to the admin token's own name. The MAC comparison is
// constant-time. now is an injectable Unix time in seconds.
export function verifyOperatorAssertion(adminToken: string, assertion: string, now: number): OperatorIdentity | null {
  const parts = assertion.split('.')
  if (parts.length !== 4 || parts[0] !== OPERATOR_ASSERTION_PREFIX) return null
  const payload = parts[1]
  if (payload.length === 0 || Buffer.byteLength(payload, 'utf8') > MAX_IDENTITY_BYTES) return null
  const exp = Number(parts[2])
  if (!Number.isInteger(exp) || exp <= now) return null
  const expected = mac(adminToken, payload, exp)
  const got = parts[3]
  const expectedBuf = Buffer.from(expected, 'utf8')
  const gotBuf = Buffer.from(got, 'utf8')
  if (expectedBuf.length !== gotBuf.length || !timingSafeEqual(expectedBuf, gotBuf)) return null
  const json = fromB64url(payload)
  if (json === null) return null
  try {
    const parsed = JSON.parse(json) as Partial<OperatorIdentity>
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || typeof parsed.email !== 'string') return null
    return { id: parsed.id, name: parsed.name, email: parsed.email }
  } catch {
    return null
  }
}
