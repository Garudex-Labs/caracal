// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Deterministic derivation of the Console BFF's operational admin tokens from the deployment admin token.

import { createHmac } from 'node:crypto'

// The reserved domain-separation labels for the Console BFF's derived operational tokens. Each
// is derived from the deployment's admin (god) token so the BFF and the API agree on its value
// with no shared secret file to manage and no minting round-trip. Distinct labels keep the read
// and write credentials independent; versioned so a derivation can be rotated without ambiguity.
const CONSOLE_READ_TOKEN_LABEL = 'caracal:console:read-only:v1'
const CONSOLE_WRITE_TOKEN_LABEL = 'caracal:console:write:v1'

function deriveConsoleToken(adminToken: string, label: string): string {
  const mac = createHmac('sha256', adminToken).update(label).digest('base64url')
  return `cat_${mac}`
}

// Derives the Console BFF's read-only admin token deterministically from the deployment admin
// token. The result is HMAC-SHA256(adminToken, label) rendered in the cat_ admin-token format,
// so both the API (which provisions the read-capability row) and the BFF (which presents it on
// read traffic) compute the identical value independently. The derived token is strictly weaker
// than the admin token it comes from, so deriving it discloses nothing the holder of the admin
// token did not already have.
export function deriveConsoleReadToken(adminToken: string): string {
  return deriveConsoleToken(adminToken, CONSOLE_READ_TOKEN_LABEL)
}

// Derives the Console BFF's write admin token, the credential it presents on mutating traffic so
// the deployment admin token is reserved as a break-glass fallback rather than the everyday
// operational credential. It is independently revocable from the bootstrap admin token (rotating
// the admin token rotates it), yet derivable only by a holder of the admin token, who already
// has full authority - so its existence grants nothing new.
export function deriveConsoleWriteToken(adminToken: string): string {
  return deriveConsoleToken(adminToken, CONSOLE_WRITE_TOKEN_LABEL)
}
