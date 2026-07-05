// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves Console access for an email from the allowlist file managed by `caracal allowlist`.

import { readFileSync } from 'node:fs'

import type { AuthConfig } from './config.ts'

type AllowlistConfig = Pick<AuthConfig, 'operatorAllowlistFile' | 'openRegistration'>

export type AccessDecision = 'allowed' | 'locked' | 'denied'

type Entries = Record<string, 'active' | 'locked'>

// Reads the allowlist fresh on every call so `caracal allowlist` changes on the host take
// effect on the next request without a restart. Anything missing, malformed, or unexpected
// reads as an empty list, which falls back to the deployment's registration posture; a
// malformed individual entry reads as absent, so every parse error fails closed.
function readEntries(path: string): Entries {
  if (!path) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  const emails = (parsed as { emails?: unknown } | null)?.emails
  if (typeof emails !== 'object' || emails === null || Array.isArray(emails)) return {}
  const entries: Entries = {}
  for (const [email, status] of Object.entries(emails)) {
    if (status === 'active' || status === 'locked') entries[email] = status
  }
  return entries
}

// Decides whether an email may register, sign in, and use the Console. Entries are
// authoritative whenever any exist: the email must match an exact entry or an `@domain`
// suffix, exact entries win over domain entries, and a locked match blocks access while the
// account's data stays. With no entries, access follows the open-registration default
// (open in development, fail-closed in production).
export function resolveAccess(email: string, cfg: AllowlistConfig): AccessDecision {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return 'denied'
  const entries = readEntries(cfg.operatorAllowlistFile)
  if (Object.keys(entries).length === 0) return cfg.openRegistration ? 'allowed' : 'denied'
  const match = entries[normalized] ?? entries[normalized.slice(normalized.indexOf('@'))]
  if (match === undefined) return 'denied'
  return match === 'active' ? 'allowed' : 'locked'
}
