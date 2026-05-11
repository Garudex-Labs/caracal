// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Argon2id client-secret hashing compatible with the STS verifier.

import { hashRaw, Algorithm } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'

const PARAMS = { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 2, outputLen: 32 }

// hashClientSecret produces the canonical argon2id$<saltB64>$<hashB64> storage
// form matching the Go STS verifyClientSecret format (base64 raw standard, no padding).
export async function hashClientSecret(secret: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await hashRaw(secret, { ...PARAMS, salt })
  const saltB64 = (salt as Buffer).toString('base64').replace(/=/g, '')
  const hashB64 = hash.toString('base64').replace(/=/g, '')
  return `argon2id$${saltB64}$${hashB64}`
}
