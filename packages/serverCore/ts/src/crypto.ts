// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared hashing and HMAC primitives for Caracal server apps.

import { createHash, createHmac } from 'node:crypto'

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest()
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

// loadStreamsHmacKey reads STREAMS_HMAC_KEY (hex) and enforces ≥32 bytes. Returns
// null when unset; callers in production paths must reject null themselves.
export function loadStreamsHmacKey(): Buffer | null {
  const raw = process.env.STREAMS_HMAC_KEY
  if (!raw) return null
  const key = Buffer.from(raw, 'hex')
  if (key.length < 32) {
    throw new Error('STREAMS_HMAC_KEY must be hex-encoded with at least 32 bytes')
  }
  return key
}

export const GATEWAY_TIMESTAMP_HEADER = 'X-Caracal-Gateway-Timestamp'
export const GATEWAY_REQUEST_HEADER = 'X-Caracal-Gateway-Request'
export const GATEWAY_SIGNATURE_HEADER = 'X-Caracal-Gateway-Signature'

// signGatewayExchange returns the hex HMAC-SHA256 over the canonical envelope:
//   `${unix}\n${requestId}\n${METHOD}\n${path}\n${sha256(body)}`
// Method and path bind the signature to a specific endpoint so a signed
// envelope cannot be replayed against any other endpoint accepting the same key.
export function signGatewayExchange(
  key: Buffer,
  timestampUnix: number,
  requestId: string,
  method: string,
  path: string,
  body: Buffer | string,
): string {
  const digest = createHash('sha256').update(body).digest('hex')
  const payload = `${timestampUnix}\n${requestId}\n${method.toUpperCase()}\n${path}\n${digest}`
  return createHmac('sha256', key).update(payload).digest('hex')
}
