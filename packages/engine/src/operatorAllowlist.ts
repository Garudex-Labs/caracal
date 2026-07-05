// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Manages the Console sign-in allowlist file read live by the web console's auth backend.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OPERATOR_ALLOWLIST_DIR = 'allowlist'
export const OPERATOR_ALLOWLIST_FILE = 'operatorAllowlist.json'
// Only the auth backend may read admission policy; group/world access would let any local
// process learn which identities can reach the Console.
const ALLOWLIST_FILE_MODE = 0o600
const ALLOWLIST_DIR_MODE = 0o700

export type AllowlistStatus = 'active' | 'locked' | 'removed'

export interface OperatorAllowlist {
  emails: Record<string, AllowlistStatus>
}

export type AllowlistOutcome = 'added' | 'removed' | 'locked' | 'unlocked' | 'unchanged' | 'missing'

export interface AllowlistChange {
  entry: string
  outcome: AllowlistOutcome
  path: string
}

export function operatorAllowlistPath(secretsDir: string): string {
  return join(secretsDir, OPERATOR_ALLOWLIST_DIR, OPERATOR_ALLOWLIST_FILE)
}

// Entries are exact emails or `@domain` suffixes that admit every address on the domain.
export function normalizeAllowlistEntry(raw: string): string {
  const entry = raw.trim().toLowerCase()
  const at = entry.indexOf('@')
  const domain = entry.slice(at + 1)
  if (at === -1 || domain.length === 0 || domain.includes('@')) {
    throw new Error(`invalid entry '${raw}': use an email address or a @domain suffix`)
  }
  return entry
}

function corruptError(path: string): Error {
  return new Error(`operator allowlist at ${path} is not valid JSON with an "emails" map: fix or delete the file`)
}

// The CLI refuses to touch a file it cannot fully parse, so a corrupted allowlist is never
// silently clobbered; the auth backend independently reads the same file fail-closed.
export function readOperatorAllowlist(secretsDir: string): OperatorAllowlist {
  const path = operatorAllowlistPath(secretsDir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { emails: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw corruptError(path)
  }
  const emails = (parsed as { emails?: unknown } | null)?.emails
  if (typeof emails !== 'object' || emails === null || Array.isArray(emails)) throw corruptError(path)
  const entries: Record<string, AllowlistStatus> = {}
  for (const [email, status] of Object.entries(emails)) {
    if (status !== 'active' && status !== 'locked' && status !== 'removed') throw corruptError(path)
    entries[email] = status
  }
  return { emails: entries }
}

function writeOperatorAllowlist(secretsDir: string, list: OperatorAllowlist): string {
  const dir = ensureOperatorAllowlistDir(secretsDir)
  const path = join(dir, OPERATOR_ALLOWLIST_FILE)
  const emails = Object.fromEntries(Object.entries(list.emails).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(path, JSON.stringify({ emails }, null, 2) + '\n', { mode: ALLOWLIST_FILE_MODE })
  try {
    chmodSync(path, ALLOWLIST_FILE_MODE)
  } catch {
    // permissions may be unsupported on some filesystems
  }
  return path
}

// Adding never reactivates a locked entry implicitly: a lock is a deliberate suspension that
// only an explicit unlock reverses. Re-adding a removed entry starts a fresh admission: the
// prior account's records were erased, so the person registers anew.
export function allowlistAdd(secretsDir: string, raw: string): AllowlistChange {
  const entry = normalizeAllowlistEntry(raw)
  const list = readOperatorAllowlist(secretsDir)
  const current = list.emails[entry]
  if (current === undefined || current === 'removed') {
    list.emails[entry] = 'active'
    return { entry, outcome: 'added', path: writeOperatorAllowlist(secretsDir, list) }
  }
  return { entry, outcome: current === 'locked' ? 'locked' : 'unchanged', path: operatorAllowlistPath(secretsDir) }
}

// Removal writes an explicit `removed` tombstone rather than deleting the entry, so the auth
// backend can distinguish a deliberate removal (erase the account on next contact) from mere
// absence (deny only). Deletion is therefore never triggerable by an empty or missing file.
export function allowlistRemove(secretsDir: string, raw: string): AllowlistChange {
  const entry = normalizeAllowlistEntry(raw)
  const list = readOperatorAllowlist(secretsDir)
  const current = list.emails[entry]
  if (current === undefined) return { entry, outcome: 'missing', path: operatorAllowlistPath(secretsDir) }
  if (current === 'removed') return { entry, outcome: 'unchanged', path: operatorAllowlistPath(secretsDir) }
  list.emails[entry] = 'removed'
  return { entry, outcome: 'removed', path: writeOperatorAllowlist(secretsDir, list) }
}

export function allowlistSetStatus(secretsDir: string, raw: string, status: 'active' | 'locked'): AllowlistChange {
  const entry = normalizeAllowlistEntry(raw)
  const list = readOperatorAllowlist(secretsDir)
  const current = list.emails[entry]
  if (current === undefined) return { entry, outcome: 'missing', path: operatorAllowlistPath(secretsDir) }
  if (current === 'removed') return { entry, outcome: 'removed', path: operatorAllowlistPath(secretsDir) }
  if (current === status) return { entry, outcome: 'unchanged', path: operatorAllowlistPath(secretsDir) }
  list.emails[entry] = status
  return { entry, outcome: status === 'locked' ? 'locked' : 'unlocked', path: writeOperatorAllowlist(secretsDir, list) }
}

// The subdirectory must exist before the stack starts so the container bind mount is created
// with the invoking user's ownership rather than by the Docker daemon as root.
export function ensureOperatorAllowlistDir(secretsDir: string): string {
  const dir = join(secretsDir, OPERATOR_ALLOWLIST_DIR)
  mkdirSync(dir, { recursive: true, mode: ALLOWLIST_DIR_MODE })
  return dir
}
