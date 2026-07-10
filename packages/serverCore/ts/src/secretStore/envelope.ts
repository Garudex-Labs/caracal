// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CSS1 envelope encryption for the Caracal Secret Store: per-secret data keys wrapped by the master KEK.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAGIC = Buffer.from('CSS1', 'ascii')
const KEK_ID_BYTES = 8
const DEK_BLOCK_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES
const MIN_ENVELOPE_BYTES = MAGIC.length + KEK_ID_BYTES + DEK_BLOCK_BYTES + NONCE_BYTES + TAG_BYTES
const DEK_AAD = Buffer.from('caracal.css1.dek', 'utf8')

// Envelope layout, all lengths fixed except the value block:
//   magic(4) | kekId(8) | dekNonce(12) | dekCt(48) | valNonce(12) | valCt(n+16)
// The data key is random per envelope and sealed under the KEK; the value is sealed
// under the data key with the caller's AAD binding the ciphertext to its logical
// location, so a blob moved to another row or table refuses to decrypt.

export function kekId(kek: Buffer): Buffer {
  return createHash('sha256').update(kek).digest().subarray(0, KEK_ID_BYTES)
}

function aeadSeal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad, { plaintextLength: plaintext.length })
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([enc, cipher.getAuthTag()])
}

function aeadOpen(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const body = sealed.subarray(0, sealed.length - TAG_BYTES)
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  decipher.setAAD(aad, { plaintextLength: body.length })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function sealEnvelope(kek: Buffer, plaintext: Buffer, aad: string): Buffer {
  if (kek.length !== KEY_BYTES) throw new Error(`kek must be ${KEY_BYTES} bytes`)
  const dek = randomBytes(KEY_BYTES)
  try {
    const dekNonce = randomBytes(NONCE_BYTES)
    const valNonce = randomBytes(NONCE_BYTES)
    const dekCt = aeadSeal(kek, dekNonce, dek, DEK_AAD)
    const valCt = aeadSeal(dek, valNonce, plaintext, Buffer.from(aad, 'utf8'))
    return Buffer.concat([MAGIC, kekId(kek), dekNonce, dekCt, valNonce, valCt])
  } finally {
    dek.fill(0)
  }
}

export function openEnvelope(kek: Buffer, envelope: Buffer, aad: string): Buffer {
  if (kek.length !== KEY_BYTES) throw new Error(`kek must be ${KEY_BYTES} bytes`)
  if (envelope.length < MIN_ENVELOPE_BYTES) throw new Error('secret envelope too short')
  if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('secret envelope has unknown format')
  let offset = MAGIC.length
  const id = envelope.subarray(offset, offset + KEK_ID_BYTES)
  offset += KEK_ID_BYTES
  if (!id.equals(kekId(kek))) throw new Error('secret envelope was sealed under a different KEK')
  const dekNonce = envelope.subarray(offset, offset + NONCE_BYTES)
  offset += NONCE_BYTES
  const dekCt = envelope.subarray(offset, offset + KEY_BYTES + TAG_BYTES)
  offset += KEY_BYTES + TAG_BYTES
  const valNonce = envelope.subarray(offset, offset + NONCE_BYTES)
  offset += NONCE_BYTES
  const valCt = envelope.subarray(offset)
  const dek = aeadOpen(kek, dekNonce, dekCt, DEK_AAD)
  try {
    return aeadOpen(dek, valNonce, valCt, Buffer.from(aad, 'utf8'))
  } finally {
    dek.fill(0)
  }
}

function weakKekReason(key: Buffer): string {
  let allSame = true
  let ascending = true
  let descending = true
  let alternating = true
  for (let i = 1; i < key.length; i++) {
    if (key[i] !== key[0]) allSame = false
    if (key[i] !== key[i - 1]! + 1) ascending = false
    if (key[i] !== key[i - 1]! - 1) descending = false
    if (i >= 2 && key[i] !== key[i % 2]) alternating = false
  }
  if (allSame && key[0] === 0) return 'must not be all zeros'
  if (allSame) return 'must not repeat the same byte'
  if (ascending || descending) return 'must not use a sequential byte pattern'
  if (alternating) return 'must not use a repeating byte pattern'
  return ''
}

function parseKek(name: string, raw: string): Buffer {
  const key = Buffer.from(raw, 'hex')
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
  const reason = weakKekReason(key)
  if (reason) throw new Error(`${name} ${reason}`)
  return key
}

// The Secret Store master key: 32 bytes of hex delivered by file-backed environment,
// never stored in the database, so a database compromise alone cannot decrypt secrets.
export function loadSecretStoreKek(): Buffer {
  const raw = process.env.SECRET_STORE_KEK
  if (!raw) throw new Error('SECRET_STORE_KEK is required')
  return parseKek('SECRET_STORE_KEK', raw)
}

// The active keyring, current key first. SECRET_STORE_KEK_PREVIOUS keeps the
// retiring key readable during a rotation window while envelopes are re-sealed.
export function loadSecretStoreKeks(): Buffer[] {
  const keys = [loadSecretStoreKek()]
  const previous = process.env.SECRET_STORE_KEK_PREVIOUS
  if (previous) keys.push(parseKek('SECRET_STORE_KEK_PREVIOUS', previous))
  return keys
}

// The key identifier embedded in an envelope, for rotation tooling that routes
// or skips rows without decrypting them.
export function envelopeKekId(envelope: Buffer): Buffer {
  if (envelope.length < MIN_ENVELOPE_BYTES) throw new Error('secret envelope too short')
  if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('secret envelope has unknown format')
  return envelope.subarray(MAGIC.length, MAGIC.length + KEK_ID_BYTES)
}

// The operational seal path: always the current key.
export function sealSecretEnvelope(plaintext: Buffer, aad: string): Buffer {
  return sealEnvelope(loadSecretStoreKek(), plaintext, aad)
}

// The operational open path: the embedded kekId routes each envelope to the key
// that sealed it, so reads keep working across a KEK rotation window.
export function openSecretEnvelope(envelope: Buffer, aad: string): Buffer {
  const id = envelopeKekId(envelope)
  for (const kek of loadSecretStoreKeks()) {
    if (id.equals(kekId(kek))) return openEnvelope(kek, envelope, aad)
  }
  throw new Error('secret envelope was sealed under a different KEK')
}
