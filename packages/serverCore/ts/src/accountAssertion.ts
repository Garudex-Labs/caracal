// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Deterministic signing and verification of the Console BFF's per-account assertion that carries the authenticated operator's account identity to the API.

import { createHmac, timingSafeEqual } from 'node:crypto'

// The domain-separation label for the account assertion MAC, versioned so the derivation can be
// rotated without ambiguity. The MAC is keyed by the deployment admin token, the secret both the
// Console BFF and the API already hold, so the two agree on the assertion with no new shared key.
// Forging an assertion requires that token, whose holder already has full deployment authority -
// so the assertion grants nothing a god-token holder did not already have, exactly like the
// derived Console read/write tokens.
const ACCOUNT_ASSERTION_LABEL = 'caracal:account:v1'
const ACCOUNT_ASSERTION_PREFIX = 'v1'

// A defensive ceiling on the account id length so a malformed or hostile header cannot blow up
// the MAC computation; Better Auth account ids are short opaque strings well within this.
const MAX_ACCOUNT_ID_BYTES = 256

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

function mac(adminToken: string, accountId: string, exp: number): string {
  return createHmac('sha256', adminToken).update(`${ACCOUNT_ASSERTION_LABEL}:${accountId}:${exp}`).digest('base64url')
}

// Signs an assertion binding an account id to an expiry. The result is a compact dotted token
// `v1.<b64url(accountId)>.<exp>.<mac>` the BFF attaches to each proxied request; the API
// recomputes the MAC with the same admin token to verify it. exp is an absolute Unix time in
// seconds, kept short by the caller so a captured assertion is only briefly replayable - and a
// replay on the internal BFF-to-API hop grants strictly less than the admin bearer already on
// that same hop.
export function signAccountAssertion(adminToken: string, accountId: string, exp: number): string {
  return `${ACCOUNT_ASSERTION_PREFIX}.${b64url(accountId)}.${exp}.${mac(adminToken, accountId, exp)}`
}

// Verifies an assertion and returns the bound account id, or null if it is malformed, expired, or
// its MAC does not match - so the caller binds an account only on a positively verified assertion
// and otherwise falls back to unbound (legacy) behaviour. The MAC comparison is constant-time so a
// forged assertion cannot be tuned by timing. now is an injectable Unix time in seconds.
export function verifyAccountAssertion(adminToken: string, assertion: string, now: number): { accountId: string } | null {
  const parts = assertion.split('.')
  if (parts.length !== 4 || parts[0] !== ACCOUNT_ASSERTION_PREFIX) return null
  const accountId = fromB64url(parts[1])
  if (accountId === null || accountId.length === 0 || Buffer.byteLength(accountId, 'utf8') > MAX_ACCOUNT_ID_BYTES) return null
  const exp = Number(parts[2])
  if (!Number.isInteger(exp) || exp <= now) return null
  const expected = mac(adminToken, accountId, exp)
  const got = parts[3]
  const expectedBuf = Buffer.from(expected, 'utf8')
  const gotBuf = Buffer.from(got, 'utf8')
  if (expectedBuf.length !== gotBuf.length || !timingSafeEqual(expectedBuf, gotBuf)) return null
  return { accountId }
}
