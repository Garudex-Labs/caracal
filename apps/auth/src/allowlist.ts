// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves and enforces Console access from the allowlist file managed by `caracal allowlist`.

import { readFileSync } from 'node:fs'

import type { AuthConfig } from './config.ts'

type AllowlistConfig = Pick<AuthConfig, 'operatorAllowlistFile' | 'openRegistration'>

export type AccessDecision = 'allowed' | 'locked' | 'removed' | 'denied'

type EntryStatus = 'active' | 'locked' | 'removed'

type Entries = Record<string, EntryStatus>

// The minimal Better Auth context surface enforcement needs, typed structurally so hooks and
// HTTP handlers can pass the live auth context without an import cycle.
export interface EnforcementContext {
  internalAdapter: {
    deleteUser(userId: string): Promise<unknown>
    deleteUserSessions(userId: string): Promise<unknown>
  }
  adapter: {
    deleteMany(input: { model: string; where: { field: string; value: string }[] }): Promise<unknown>
  }
}

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
    if (status === 'active' || status === 'locked' || status === 'removed') entries[email] = status
  }
  return entries
}

// Decides whether an email may register, sign in, and use the Console. A matching entry is
// always authoritative: exact entries win over `@domain` suffixes, `locked` suspends access
// with the account kept intact, and `removed` is an explicit erasure tombstone written by
// `caracal allowlist remove` - never inferred from absence, so a missing or corrupted file can
// only ever deny, not destroy. Active or locked entries put the list in enforcing mode for
// everyone else; with no such entries, access follows the open-registration default (open in
// development, fail-closed in production).
export function resolveAccess(email: string, cfg: AllowlistConfig): AccessDecision {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return 'denied'
  const entries = readEntries(cfg.operatorAllowlistFile)
  const match = entries[normalized] ?? entries[normalized.slice(normalized.indexOf('@'))]
  if (match === 'active') return 'allowed'
  if (match === 'locked') return 'locked'
  if (match === 'removed') return 'removed'
  const enforcing = Object.values(entries).some((status) => status !== 'removed')
  return enforcing ? 'denied' : cfg.openRegistration ? 'allowed' : 'denied'
}

// Applies the server-side consequence of a denial. `removed` erases the account's auth records
// (user, sessions, linked provider accounts, pending verifications) exactly like self-service
// account deletion; every other denial revokes the account's sessions so a live browser is
// signed out rather than left riding a session it can no longer use. Idempotent: repeated
// enforcement of an already-erased or already-revoked account is a no-op.
export async function enforceDenial(
  ctx: EnforcementContext,
  access: Exclude<AccessDecision, 'allowed'>,
  user: { id: string; email: string },
): Promise<void> {
  if (access === 'removed') {
    await ctx.internalAdapter.deleteUser(user.id)
    await ctx.adapter.deleteMany({
      model: 'verification',
      where: [{ field: 'identifier', value: user.email }],
    })
    return
  }
  await ctx.internalAdapter.deleteUserSessions(user.id)
}
