#!/usr/bin/env node
/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Copies every stored provider credential document from one secret backend to another.
 */

// Backend migration runbook: keep CARACAL_SECRET_BACKEND pointing at the source,
// export the target's connection environment, and run
//   node scripts/migrate-secret-backend.mjs <target-kind>
// then switch CARACAL_SECRET_BACKEND to the target and restart the services.
// Documents are sealed envelopes bound to their backend-independent ref, so the
// copy moves ciphertext byte-for-byte and never needs the KEK. Re-running is
// safe: puts are idempotent upserts.

import pg from 'pg'
import { SECRET_BACKEND_KINDS, providerSecretConfigRef, resolveFileSecrets, secretBackendKind } from '@caracalai/server-core'
import { buildRawSecretBackend } from '../dist/secret-store.js'

resolveFileSecrets([
  'DATABASE_URL',
  'CARACAL_VAULT_TOKEN',
  'CARACAL_INFISICAL_TOKEN',
  'CARACAL_AZURE_CLIENT_SECRET',
  'CARACAL_CUSTOM_SECRETS_TOKEN',
])
const targetKind = (process.argv[2] ?? '').trim().toLowerCase()
if (!SECRET_BACKEND_KINDS.includes(targetKind)) {
  console.error(`usage: migrate-secret-backend.mjs <${SECRET_BACKEND_KINDS.join('|')}>`)
  process.exit(1)
}
const sourceKind = secretBackendKind()
if (sourceKind === targetKind) {
  console.error(`source and target are both '${sourceKind}'; nothing to migrate`)
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const source = buildRawSecretBackend(pool, sourceKind)
const target = buildRawSecretBackend(pool, targetKind)

const { rows } = await pool.query(`SELECT zone_id, id FROM providers WHERE archived_at IS NULL AND secret_config_keys <> '{}'`)
let copied = 0
let missing = 0
let failed = 0
for (const row of rows) {
  const ref = providerSecretConfigRef(row.zone_id, row.id)
  try {
    const envelope = await source.get(ref)
    if (!envelope) {
      missing++
      console.error(`${ref}: not present in ${sourceKind}`)
      continue
    }
    await target.put(ref, envelope)
    copied++
  } catch (err) {
    failed++
    console.error(`${ref}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

await pool.end()
console.log(`migration ${sourceKind} -> ${targetKind}: ${copied} copied, ${missing} missing, ${failed} failed of ${rows.length} providers`)
if (failed > 0 || missing > 0) process.exit(1)
console.log(`switch CARACAL_SECRET_BACKEND to '${targetKind}' and restart the control plane and STS`)
