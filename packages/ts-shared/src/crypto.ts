// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ChaCha20-Poly1305 envelope encryption that matches the Go shared/crypto format.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
}

export function loadZoneKek(): Buffer {
  const raw = process.env.ZONE_KEK;
  if (!raw) throw new Error('ZONE_KEK is required');
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`ZONE_KEK must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  let allZero = 0;
  for (const b of key) allZero |= b;
  if (allZero === 0) throw new Error('ZONE_KEK must not be all zeros');
  return key;
}

export function seal(key: Buffer, plaintext: Buffer): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), nonce };
}

export function open(key: Buffer, sealed: SealedSecret): Buffer {
  if (sealed.ciphertext.length < TAG_BYTES) throw new Error('ciphertext too short');
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('chacha20-poly1305', key, sealed.nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// STREAM_SIG_FIELD is the reserved key used to carry an HMAC-SHA256 origin signature
// on Redis stream messages. Mirrors `crypto.StreamSigField` in the Go shared package.
export const STREAM_SIG_FIELD = '_sig';

export type StreamValue = string | number | boolean | null | undefined;

// loadStreamsHmacKey reads STREAMS_HMAC_KEY (hex) and enforces ≥32 bytes. Returns
// null when unset; callers in production paths must reject null themselves.
export function loadStreamsHmacKey(): Buffer | null {
  const raw = process.env.STREAMS_HMAC_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'hex');
  if (key.length < 32) {
    throw new Error('STREAMS_HMAC_KEY must be hex-encoded with at least 32 bytes');
  }
  return key;
}

function canonicalizeStream(stream: string, values: Record<string, StreamValue>): string {
  const keys = Object.keys(values).filter((k) => k !== STREAM_SIG_FIELD).sort();
  let out = `${stream}\n`;
  for (const k of keys) {
    const v = values[k];
    if (v === null || v === undefined) continue;
    out += `${k}=${String(v)}\n`;
  }
  return out;
}

// signStream returns the hex HMAC-SHA256 over the canonical form of the values map.
// Mirrors `crypto.SignStream` in the Go shared package so producers and consumers
// across language boundaries agree on the signature.
export function signStream(key: Buffer, stream: string, values: Record<string, StreamValue>): string {
  return createHmac('sha256', key).update(canonicalizeStream(stream, values)).digest('hex');
}
