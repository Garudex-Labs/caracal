// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Deterministic derivation of the Console BFF's read-only admin token from the deployment admin token.

import { createHmac } from 'node:crypto'

// The reserved domain-separation label for the Console BFF's read-only admin token. The token
// is derived from the deployment's admin (god) token so the BFF and the API agree on its value
// with no shared secret file to manage and no minting round-trip. Versioned so the derivation
// can be rotated without ambiguity.
const CONSOLE_READ_TOKEN_LABEL = 'caracal:console:read-only:v1'

// Derives the Console BFF's read-only admin token deterministically from the deployment admin
// token. The result is HMAC-SHA256(adminToken, label) rendered in the cat_ admin-token format,
// so both the API (which provisions the read-capability row) and the BFF (which presents it on
// read traffic) compute the identical value independently. The derived token is strictly
// weaker than the admin token it comes from, so deriving it discloses nothing the holder of the
// admin token did not already have.
export function deriveConsoleReadToken(adminToken: string): string {
  const mac = createHmac('sha256', adminToken).update(CONSOLE_READ_TOKEN_LABEL).digest('base64url')
  return `cat_${mac}`
}
