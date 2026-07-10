// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// HMAC-SHA256 stream signing that matches the Go shared crypto format.

import { createHmac } from 'node:crypto'

// STREAM_SIG_FIELD is the reserved key used to carry an HMAC-SHA256 origin signature
// on Redis stream messages. Mirrors `crypto.StreamSigField` in the Go shared package.
export const STREAM_SIG_FIELD = '_sig'

export type StreamValue = string | number | boolean | null | undefined

function canonicalizeStream(stream: string, values: Record<string, StreamValue>): string {
  const keys = Object.keys(values)
    .filter((k) => k !== STREAM_SIG_FIELD)
    .sort()
  let out = `${stream}\n`
  for (const k of keys) {
    const v = values[k]
    if (v === null || v === undefined) continue
    out += `${k}=${String(v)}\n`
  }
  return out
}

// signStream returns the hex HMAC-SHA256 over the canonical form of the values map.
// Mirrors `crypto.SignStream` in the Go shared package so producers and consumers
// across language boundaries agree on the signature.
export function signStream(key: Buffer, stream: string, values: Record<string, StreamValue>): string {
  return createHmac('sha256', key).update(canonicalizeStream(stream, values)).digest('hex')
}
