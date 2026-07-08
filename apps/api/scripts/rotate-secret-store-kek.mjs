#!/usr/bin/env node
/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Re-seals every stored envelope under the current SECRET_STORE_KEK so the previous key can be retired.
 */

// Rotation runbook: deploy the new key as SECRET_STORE_KEK with the old key as
// SECRET_STORE_KEK_PREVIOUS, run this sweep inside the API environment, then
// remove SECRET_STORE_KEK_PREVIOUS. Reads route by each envelope's embedded
// kekId, so services keep serving throughout. The sweep is idempotent: rows
// already under the current key are skipped, and every rewrite is guarded by a
// compare-and-swap on the envelope bytes so a concurrent live write - which
// always seals under the current key - is never overwritten.

import pg from 'pg'
import {
  envelopeKekId,
  kekId,
  loadSecretStoreKek,
  loadSecretStoreKeks,
  openSecretEnvelope,
  sealSecretEnvelope,
  providerSecretConfigRef,
  resolveFileSecrets,
  secretBackendKind,
  AAD_CONNECTION_ACCESS_TOKEN,
  AAD_CONNECTION_REFRESH_TOKEN,
  AAD_NOTIFICATION_SINK_SECRET,
  AAD_OPERATOR_PLAN_SECRETS,
  AAD_ZONE_SIGNING_KEY,
} from '@caracalai/server-core'
import { buildRawSecretBackend } from '../dist/secret-store.js'

resolveFileSecrets(['DATABASE_URL', 'SECRET_STORE_KEK', 'SECRET_STORE_KEK_PREVIOUS'])
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
loadSecretStoreKeks()
const currentKekId = kekId(loadSecretStoreKek())

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const totals = { resealed: 0, skipped: 0, raced: 0, failed: 0 }

function reseal(envelope, aad) {
  if (envelopeKekId(envelope).equals(currentKekId)) return null
  return sealSecretEnvelope(openSecretEnvelope(envelope, aad), aad)
}

// Each row rewrite compares against the bytes that were read, so a row rewritten
// by a live service in the meantime is left alone: live writers already seal
// under the current key.
async function sweep(label, selectSql, updateSql, aadFor) {
  const { rows } = await pool.query(selectSql)
  for (const row of rows) {
    try {
      const sealed = reseal(row.envelope, aadFor(row))
      if (!sealed) {
        totals.skipped++
        continue
      }
      const { rowCount } = await pool.query(updateSql, [sealed, row.envelope, ...row.keys])
      if (rowCount === 1) totals.resealed++
      else totals.raced++
    } catch (err) {
      totals.failed++
      console.error(`${label}: ${row.keys.join('/')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`${label}: ${rows.length} rows examined`)
}

await sweep(
  'secret_store',
  `SELECT ref, envelope, ARRAY[ref] AS keys FROM secret_store`,
  `UPDATE secret_store SET envelope = $1, updated_at = now() WHERE envelope = $2 AND ref = $3`,
  (row) => row.ref,
)
await sweep(
  'secrets (zone signing keys)',
  `SELECT id, envelope, ARRAY[id] AS keys FROM secrets WHERE name = 'zone_signing_key'`,
  `UPDATE secrets SET envelope = $1, updated_at = now() WHERE envelope = $2 AND id = $3`,
  () => AAD_ZONE_SIGNING_KEY,
)
await sweep(
  'provider_connections.access_token_ct',
  `SELECT id, access_token_ct AS envelope, ARRAY[id] AS keys FROM provider_connections WHERE access_token_ct IS NOT NULL`,
  `UPDATE provider_connections SET access_token_ct = $1, updated_at = now() WHERE access_token_ct = $2 AND id = $3`,
  () => AAD_CONNECTION_ACCESS_TOKEN,
)
await sweep(
  'provider_connections.refresh_token_ct',
  `SELECT id, refresh_token_ct AS envelope, ARRAY[id] AS keys FROM provider_connections WHERE refresh_token_ct IS NOT NULL`,
  `UPDATE provider_connections SET refresh_token_ct = $1, updated_at = now() WHERE refresh_token_ct = $2 AND id = $3`,
  () => AAD_CONNECTION_REFRESH_TOKEN,
)
await sweep(
  'notification_sinks.secret_ct',
  `SELECT id, secret_ct AS envelope, ARRAY[id] AS keys FROM notification_sinks`,
  `UPDATE notification_sinks SET secret_ct = $1, updated_at = now() WHERE secret_ct = $2 AND id = $3`,
  () => AAD_NOTIFICATION_SINK_SECRET,
)
await sweep(
  'operator_plan_secrets',
  `SELECT conversation_id, plan_seq, step_id, envelope,
          ARRAY[conversation_id, plan_seq::text, step_id] AS keys
   FROM operator_plan_secrets WHERE expires_at > now()`,
  `UPDATE operator_plan_secrets SET envelope = $1
   WHERE envelope = $2 AND conversation_id = $3 AND plan_seq = $4::bigint AND step_id = $5`,
  () => AAD_OPERATOR_PLAN_SECRETS,
)

// Provider credential documents in an external backend are envelopes too; they
// are re-sealed in place through the same store the services read from.
const kind = secretBackendKind()
if (kind !== 'builtin') {
  const external = buildRawSecretBackend(pool, kind)
  const { rows } = await pool.query(`SELECT zone_id, id FROM providers WHERE archived_at IS NULL AND secret_config_keys <> '{}'`)
  for (const row of rows) {
    const ref = providerSecretConfigRef(row.zone_id, row.id)
    try {
      const envelope = await external.get(ref)
      if (!envelope) {
        totals.skipped++
        continue
      }
      const sealed = reseal(envelope, ref)
      if (!sealed) {
        totals.skipped++
        continue
      }
      await external.put(ref, sealed)
      totals.resealed++
    } catch (err) {
      totals.failed++
      console.error(`${kind}: ${ref}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`${kind}: ${rows.length} provider documents examined`)
}

await pool.end()
console.log(
  `re-seal complete: ${totals.resealed} resealed, ${totals.skipped} already current, ${totals.raced} rewritten by live services, ${totals.failed} failed`,
)
if (totals.failed > 0) process.exit(1)
console.log('SECRET_STORE_KEK_PREVIOUS can now be removed from every service environment.')
