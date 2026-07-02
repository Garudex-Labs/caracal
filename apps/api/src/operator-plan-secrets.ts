// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The plan credential vault: derives which credential fields a plan step needs and holds pasted values sealed at rest until the step applies them.

import { loadZoneKek, open, seal } from '@caracalai/core'
import { PROVIDER_KINDS, PUBLIC_PROVIDER_CONFIG_KEYS, type ProviderKind } from './provider-config.js'

// The longest single credential value accepted: bounded to hold a PEM private key while
// refusing pathological payloads.
export const CREDENTIAL_VALUE_MAX = 16384

// How long pasted credentials stay available for an undecided plan. A plan the operator
// abandons leaves nothing behind: an expired row is treated as absent and swept on write.
export const PLAN_SECRET_TTL_MS = 30 * 60 * 1000

function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)
}

// The credential fields a connectProvider step collects through the console's secure prompt,
// per provider convention: an OAuth client is an id and a secret (or a private key under
// private_key_jwt, or the id alone under public-client "none" auth), an API key provider is
// its key, a bearer provider is its token. Deterministic on kind and the step's public
// config, so the plan, the approval gate, and the executor all derive the same requirement.
// Credential values themselves never ride in plan args - client_id included - so a plan
// argument can never carry pasted credential material.
export function credentialFieldsFor(capability: string, args: Record<string, unknown>): string[] {
  if (capability !== 'connectProvider' || !isProviderKind(args.kind)) return []
  const config = args.config && typeof args.config === 'object' && !Array.isArray(args.config) ? (args.config as Record<string, unknown>) : {}
  switch (args.kind) {
    case 'api_key':
      return ['api_key']
    case 'bearer_token':
      return ['bearer_token']
    case 'oauth2_authorization_code':
      return config.client_auth_method === 'none' ? ['client_id'] : ['client_id', 'client_secret']
    case 'oauth2_client_credentials':
      return config.client_auth_method === 'private_key_jwt'
        ? ['client_id', 'private_key']
        : config.client_auth_method === 'none'
          ? ['client_id']
          : ['client_id', 'client_secret']
    default:
      return []
  }
}

// Validates the non-secret config a connectProvider step may carry: only keys the provider
// kind's public contract accepts, and never a credential field - those are collected through
// the console's secure prompt, sealed, and merged at apply time.
export function planProviderConfigError(kind: unknown, config: Record<string, unknown> | undefined): string | null {
  if (!config || Object.keys(config).length === 0) return null
  if (!isProviderKind(kind)) return 'config requires a valid provider kind'
  const allowed = PUBLIC_PROVIDER_CONFIG_KEYS[kind]
  const credentials = new Set(credentialFieldsFor('connectProvider', { kind, config }))
  for (const key of Object.keys(config)) {
    if (credentials.has(key)) return `config must not carry ${key}: credentials are entered through the console's secure prompt`
    if (!allowed.has(key)) return `config key ${key} is not a public ${kind} provider setting`
  }
  return null
}

export interface PlanSecretQueryable {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

export interface PlanSecretRef {
  conversationId: string
  zoneId: string
  planSeq: number
}

// Seals and stores one step's pasted credentials, replacing any earlier paste for the same
// step so the operator can correct a value before approving. The sweep of this plan's
// expired rows keeps abandoned credentials from lingering beyond their window.
export async function storePlanStepSecrets(
  db: PlanSecretQueryable,
  ref: PlanSecretRef,
  stepId: string,
  values: Record<string, string>,
): Promise<void> {
  const sealed = seal(loadZoneKek(), Buffer.from(JSON.stringify(values), 'utf8'))
  const expiresAt = new Date(Date.now() + PLAN_SECRET_TTL_MS).toISOString()
  await db.query(
    `DELETE FROM operator_plan_secrets
     WHERE conversation_id = $1 AND zone_id = $2 AND expires_at <= now()`,
    [ref.conversationId, ref.zoneId],
  )
  await db.query(
    `INSERT INTO operator_plan_secrets (conversation_id, zone_id, plan_seq, step_id, ciphertext, nonce, secret_keys, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (conversation_id, plan_seq, step_id)
     DO UPDATE SET ciphertext = $5, nonce = $6, secret_keys = $7, expires_at = $8, created_at = now()`,
    [ref.conversationId, ref.zoneId, ref.planSeq, stepId, sealed.ciphertext, sealed.nonce, Object.keys(values).sort(), expiresAt],
  )
}

// The step ids of this plan whose credentials are stored and still live. The console uses
// this to gate approval and to know which steps still need the secure prompt; values are
// never read back out of the vault by any read surface.
export async function listSatisfiedPlanSteps(db: PlanSecretQueryable, ref: PlanSecretRef): Promise<Set<string>> {
  const { rows } = await db.query<{ step_id: string }>(
    `SELECT step_id FROM operator_plan_secrets
     WHERE conversation_id = $1 AND zone_id = $2 AND plan_seq = $3 AND expires_at > now()`,
    [ref.conversationId, ref.zoneId, ref.planSeq],
  )
  return new Set(rows.map((row) => row.step_id))
}

// Opens one step's sealed credentials for the executor. Returns null when nothing live is
// stored, so the execute path can refuse before applying anything.
export async function openPlanStepSecrets(
  db: PlanSecretQueryable,
  ref: PlanSecretRef,
  stepId: string,
): Promise<Record<string, string> | null> {
  const { rows } = await db.query<{ ciphertext: Buffer; nonce: Buffer }>(
    `SELECT ciphertext, nonce FROM operator_plan_secrets
     WHERE conversation_id = $1 AND zone_id = $2 AND plan_seq = $3 AND step_id = $4 AND expires_at > now()`,
    [ref.conversationId, ref.zoneId, ref.planSeq, stepId],
  )
  if (!rows[0]) return null
  const plaintext = open(loadZoneKek(), { nonce: rows[0].nonce, ciphertext: rows[0].ciphertext })
  return JSON.parse(plaintext.toString('utf8')) as Record<string, string>
}

// Discards a plan's stored credentials: on rejection, on a spent plan, or after the steps
// that needed them have applied - the provider create sealed them at their final place.
export async function deletePlanSecrets(db: PlanSecretQueryable, ref: PlanSecretRef, stepIds?: string[]): Promise<void> {
  if (stepIds && stepIds.length === 0) return
  if (stepIds) {
    await db.query(
      `DELETE FROM operator_plan_secrets
       WHERE conversation_id = $1 AND zone_id = $2 AND plan_seq = $3 AND step_id = ANY($4)`,
      [ref.conversationId, ref.zoneId, ref.planSeq, stepIds],
    )
    return
  }
  await db.query(
    `DELETE FROM operator_plan_secrets
     WHERE conversation_id = $1 AND zone_id = $2 AND plan_seq = $3`,
    [ref.conversationId, ref.zoneId, ref.planSeq],
  )
}
