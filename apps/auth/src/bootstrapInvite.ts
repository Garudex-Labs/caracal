// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies the one-time first-operator invite minted by `caracal invite` on the stack host.

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'

import type { AuthConfig } from './config.ts'

type InviteConfig = Pick<AuthConfig, 'operatorInviteFile'>

export interface OperatorInvite {
  email: string
  codeSha256: string
}

const RATE_WINDOW_MS = 60_000
const RATE_MAX_ATTEMPTS = 10
let windowStart = 0
let attempts = 0

// The code is 32 random bytes, so online guessing is hopeless even without a limit; the
// fixed window exists to keep the endpoint from becoming a free hashing oracle and to bound
// log noise from abuse. Counting is per-process, which matches the single-invite trust model.
function withinRateBudget(now: number): boolean {
  if (now - windowStart >= RATE_WINDOW_MS) {
    windowStart = now
    attempts = 0
  }
  attempts += 1
  return attempts <= RATE_MAX_ATTEMPTS
}

// Reads the invite file fresh on every call so a newly minted or expired invite takes effect
// without a restart. Anything malformed, missing, or past expiry reads as "no invite": the
// flow fails closed on every parse or shape error.
export function readInvite(path: string): OperatorInvite | null {
  if (!path) return null
  let record: unknown
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (typeof record !== 'object' || record === null) return null
  const { email, code_sha256: codeSha256, expires_at: expiresAt } = record as Record<string, unknown>
  if (typeof email !== 'string' || typeof codeSha256 !== 'string' || typeof expiresAt !== 'string') return null
  if (!/^[0-9a-f]{64}$/.test(codeSha256)) return null
  const expiry = Date.parse(expiresAt)
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null
  return { email: email.trim().toLowerCase(), codeSha256 }
}

// True when a live invite names this email. Used by the user-creation hook as an authority
// check: the invite was minted by someone with shell access to the stack host's secrets
// directory, which outranks a self-asserted email address.
export function inviteAuthorizes(email: string, cfg: InviteConfig): boolean {
  const invite = readInvite(cfg.operatorInviteFile)
  return invite !== null && invite.email === email.trim().toLowerCase()
}

export function verifyInviteCode(code: string, email: string, cfg: InviteConfig): boolean {
  if (!withinRateBudget(Date.now())) return false
  const invite = readInvite(cfg.operatorInviteFile)
  if (invite === null || invite.email !== email.trim().toLowerCase()) return false
  const presented = createHash('sha256').update(code).digest()
  const stored = Buffer.from(invite.codeSha256, 'hex')
  return presented.length === stored.length && timingSafeEqual(presented, stored)
}

// Deleting the file is what makes the invite one-time. Best effort: a failed unlink leaves an
// invite that still expires within the hour, and registration is already complete by then.
export function consumeInvite(cfg: InviteConfig): void {
  if (!cfg.operatorInviteFile) return
  try {
    unlinkSync(cfg.operatorInviteFile)
  } catch {
    // already gone or read-only mount; expiry bounds the residual window
  }
}
