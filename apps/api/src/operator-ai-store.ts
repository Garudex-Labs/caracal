// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Persistence for the Operator's model-provider registry, holding only non-secret metadata while each upstream key lives in the sealed Caracal provider.

import type { Queryable } from './db.js'

export const PROVIDER_SLUG_PATTERN = /^[a-z0-9_]{1,32}$/

export type OperatorAiReconciliationState = 'ready' | 'pending' | 'error' | 'deleting'

// One configured upstream the Operator may route a model call through. The key is never held
// here; it is sealed into the matching Caracal provider. models is the set of model ids the
// upstream serves behind one endpoint and key, each surfaced to the gateway as its own
// selectable provider entry.
export interface OperatorAiProviderRecord {
  slug: string
  label: string
  baseUrl: string
  models: string[]
  contextWindow: number
  enabled: boolean
  sortOrder: number
  auth: AuthPlacement
  reconciliationState: OperatorAiReconciliationState
  reconciliationErrorCode: string | null
  credentialRequired: boolean
  reconciledAt: string | null
}

// Where the gateway injects the sealed key for this upstream. Defaults to an Authorization
// Bearer header, which covers OpenAI-compatible providers; an upstream that expects a different
// header (e.g. api-key) or a query parameter sets it here, so no per-vendor handling is needed.
export interface AuthPlacement {
  location: 'header' | 'query'
  headerName?: string
  authScheme?: string
  queryParamName?: string
}

export const DEFAULT_AUTH: AuthPlacement = { location: 'header', headerName: 'Authorization', authScheme: 'Bearer' }

function toAuth(raw: unknown): AuthPlacement {
  if (!raw || typeof raw !== 'object') return DEFAULT_AUTH
  const value = raw as Record<string, unknown>
  if (value.location !== 'header' && value.location !== 'query') return DEFAULT_AUTH
  if (value.location === 'query') {
    return { location: 'query', queryParamName: typeof value.queryParamName === 'string' ? value.queryParamName : 'api_key' }
  }
  return {
    location: 'header',
    headerName: typeof value.headerName === 'string' && value.headerName ? value.headerName : 'Authorization',
    authScheme: typeof value.authScheme === 'string' ? value.authScheme : undefined,
  }
}

interface ProviderRow {
  slug: string
  label: string
  base_url: string
  models: unknown
  context_window: number
  enabled: boolean
  sort_order: number
  auth_config: unknown
  reconciliation_state: string
  reconciliation_error_code: string | null
  credential_required: boolean
  reconciled_at: string | Date | null
}

function toReconciliationState(value: string): OperatorAiReconciliationState {
  if (value === 'ready' || value === 'pending' || value === 'error' || value === 'deleting') return value
  return 'error'
}

function toReconciledAt(value: string | Date | null): string | null {
  return value instanceof Date ? value.toISOString() : value
}

function toRecord(row: ProviderRow): OperatorAiProviderRecord {
  const models = Array.isArray(row.models) ? row.models.filter((value): value is string => typeof value === 'string') : []
  return {
    slug: row.slug,
    label: row.label,
    baseUrl: row.base_url,
    models,
    contextWindow: row.context_window,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    auth: toAuth(row.auth_config),
    reconciliationState: toReconciliationState(row.reconciliation_state),
    reconciliationErrorCode: row.reconciliation_error_code,
    credentialRequired: row.credential_required,
    reconciledAt: toReconciledAt(row.reconciled_at),
  }
}

export interface ProviderUpsert {
  slug: string
  label: string
  baseUrl: string
  models: string[]
  contextWindow: number
  enabled: boolean
  auth: AuthPlacement
  reconciliationState: OperatorAiReconciliationState
  reconciliationErrorCode: string | null
  credentialRequired: boolean
}

// Inserts a new provider without replacing an existing slug. POST and PATCH have distinct
// lifecycle semantics: a duplicate create must not silently take a live provider offline or
// replace its metadata, while PATCH deliberately uses the upsert helper below.
export async function insertAiProvider(db: Queryable, input: ProviderUpsert): Promise<OperatorAiProviderRecord | null> {
  const { rows } = await db.query<ProviderRow>(
    `INSERT INTO operator_ai_providers
       (slug, label, base_url, models, context_window, enabled, auth_config, reconciliation_state,
        reconciliation_error_code, credential_required, reconciled_at, sort_order)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, NULL,
             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM operator_ai_providers))
     ON CONFLICT (slug) DO NOTHING
     RETURNING slug, label, base_url, models, context_window, enabled, sort_order, auth_config,
               reconciliation_state, reconciliation_error_code, credential_required, reconciled_at`,
    [
      input.slug,
      input.label,
      input.baseUrl,
      JSON.stringify(input.models),
      input.contextWindow,
      input.enabled,
      JSON.stringify(input.auth),
      input.reconciliationState,
      input.reconciliationErrorCode,
      input.credentialRequired,
    ],
  )
  return rows[0] ? toRecord(rows[0]) : null
}

// Lists every configured provider in display order, newest fields included. Read on boot to
// build the gateway and on each registry change to rebuild it.
export async function listAiProviders(db: Queryable): Promise<OperatorAiProviderRecord[]> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT slug, label, base_url, models, context_window, enabled, sort_order, auth_config,
            reconciliation_state, reconciliation_error_code, credential_required, reconciled_at
       FROM operator_ai_providers
      ORDER BY sort_order, slug`,
  )
  return rows.map(toRecord)
}

export async function getAiProvider(db: Queryable, slug: string): Promise<OperatorAiProviderRecord | null> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT slug, label, base_url, models, context_window, enabled, sort_order, auth_config,
            reconciliation_state, reconciliation_error_code, credential_required, reconciled_at
       FROM operator_ai_providers WHERE slug = $1`,
    [slug],
  )
  return rows[0] ? toRecord(rows[0]) : null
}

// Inserts or replaces a provider's metadata. The sort order places a new provider at the end
// while preserving an existing one's position, so the failover order an operator arranged is
// stable across edits. Returns null when the slug is a delete tombstone, which no metadata write
// may revive; a concurrent remove therefore always wins over an edit that read the row first.
export async function upsertAiProvider(db: Queryable, input: ProviderUpsert): Promise<OperatorAiProviderRecord | null> {
  const { rows } = await db.query<ProviderRow>(
    `INSERT INTO operator_ai_providers
       (slug, label, base_url, models, context_window, enabled, auth_config, reconciliation_state,
        reconciliation_error_code, credential_required, reconciled_at, sort_order)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, NULL,
             COALESCE((SELECT sort_order FROM operator_ai_providers WHERE slug = $1),
                      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM operator_ai_providers)))
     ON CONFLICT (slug) DO UPDATE
       SET label = EXCLUDED.label,
           base_url = EXCLUDED.base_url,
           models = EXCLUDED.models,
           context_window = EXCLUDED.context_window,
           enabled = EXCLUDED.enabled,
           auth_config = EXCLUDED.auth_config,
           reconciliation_state = EXCLUDED.reconciliation_state,
           reconciliation_error_code = EXCLUDED.reconciliation_error_code,
           credential_required = EXCLUDED.credential_required,
           reconciled_at = NULL,
           updated_at = now()
     WHERE operator_ai_providers.reconciliation_state <> 'deleting'
     RETURNING slug, label, base_url, models, context_window, enabled, sort_order, auth_config,
               reconciliation_state, reconciliation_error_code, credential_required, reconciled_at`,
    [
      input.slug,
      input.label,
      input.baseUrl,
      JSON.stringify(input.models),
      input.contextWindow,
      input.enabled,
      JSON.stringify(input.auth),
      input.reconciliationState,
      input.reconciliationErrorCode,
      input.credentialRequired,
    ],
  )
  return rows[0] ? toRecord(rows[0]) : null
}

// Advances only the durable reconciliation fields. Error codes are deliberately low-cardinality
// internal values; provider responses and credentials never enter this table. A delete tombstone
// accepts only a write that keeps it one, so a lifecycle operation racing a remove cannot revive
// the row it already agreed to destroy. Returns null when no row matched.
export async function setAiProviderReconciliation(
  db: Queryable,
  slug: string,
  state: OperatorAiReconciliationState,
  errorCode: string | null,
  credentialRequired: boolean,
): Promise<OperatorAiProviderRecord | null> {
  const { rows } = await db.query<ProviderRow>(
    `UPDATE operator_ai_providers
        SET reconciliation_state = $2,
            reconciliation_error_code = $3,
            credential_required = $4,
            reconciled_at = CASE WHEN $2 = 'ready' THEN now() ELSE reconciled_at END,
            updated_at = now()
      WHERE slug = $1 AND (reconciliation_state <> 'deleting' OR $2 = 'deleting')
      RETURNING slug, label, base_url, models, context_window, enabled, sort_order, auth_config,
                reconciliation_state, reconciliation_error_code, credential_required, reconciled_at`,
    [slug, state, errorCode, credentialRequired],
  )
  return rows[0] ? toRecord(rows[0]) : null
}

export async function deleteAiProvider(db: Queryable, slug: string): Promise<boolean> {
  const { rows } = await db.query<{ slug: string }>(`DELETE FROM operator_ai_providers WHERE slug = $1 RETURNING slug`, [slug])
  return rows.length > 0
}
