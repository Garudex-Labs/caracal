// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Mints the one-time first-operator invite file consumed by the web console's auth backend.

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OPERATOR_INVITE_DIR = 'invites'
export const OPERATOR_INVITE_FILE = 'operatorInvite.json'
const INVITE_CODE_BYTES = 32
const INVITE_TTL_MS = 60 * 60 * 1000
// Only the auth backend may read the invite hash; group/world access would let any local
// process race the operator to the bootstrap registration.
const INVITE_FILE_MODE = 0o600
const INVITE_DIR_MODE = 0o700

export interface MintedOperatorInvite {
  code: string
  email: string
  expiresAt: string
  path: string
}

// The file stores only the SHA-256 of the code, so shell access to the secrets directory after
// minting cannot recover the code itself; possession of the plaintext code stays the proof of
// having run the mint. Minting overwrites any prior invite: one live invite at a time. Invites
// live in a dedicated subdirectory so containers can mount it without seeing sibling secrets.
export function mintOperatorInvite(secretsDir: string, email: string): MintedOperatorInvite {
  const normalized = email.trim().toLowerCase()
  if (!normalized.includes('@')) {
    throw new Error(`invalid email address: ${email}`)
  }
  const code = randomBytes(INVITE_CODE_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString()
  const dir = ensureOperatorInviteDir(secretsDir)
  const path = join(dir, OPERATOR_INVITE_FILE)
  const record = {
    email: normalized,
    code_sha256: createHash('sha256').update(code).digest('hex'),
    expires_at: expiresAt,
  }
  writeFileSync(path, JSON.stringify(record) + '\n', { mode: INVITE_FILE_MODE })
  try {
    chmodSync(path, INVITE_FILE_MODE)
  } catch {
    // permissions may be unsupported on some filesystems
  }
  return { code, email: normalized, expiresAt, path }
}

// The subdirectory must exist before the stack starts so the container bind mount is created
// with the invoking user's ownership rather than by the Docker daemon as root.
export function ensureOperatorInviteDir(secretsDir: string): string {
  const dir = join(secretsDir, OPERATOR_INVITE_DIR)
  mkdirSync(dir, { recursive: true, mode: INVITE_DIR_MODE })
  return dir
}
