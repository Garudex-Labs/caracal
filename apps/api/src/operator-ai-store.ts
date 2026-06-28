// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Persistence for the Operator's model-provider registry, holding only non-secret metadata while each upstream key lives in the sealed Caracal provider.

import type { Queryable } from './db.js'

export const PROVIDER_SLUG_PATTERN = /^[a-z0-9_]{1,32}$/

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
}

interface ProviderRow {
  slug: string
  label: string
  base_url: string
  models: unknown
  context_window: number
  enabled: boolean
  sort_order: number
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
  }
}

export interface ProviderUpsert {
  slug: string
  label: string
  baseUrl: string
  models: string[]
  contextWindow: number
  enabled: boolean
}

// Lists every configured provider in display order, newest fields included. Read on boot to
// build the gateway and on each registry change to rebuild it.
export async function listAiProviders(db: Queryable): Promise<OperatorAiProviderRecord[]> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT slug, label, base_url, models, context_window, enabled, sort_order
       FROM operator_ai_providers
      ORDER BY sort_order, slug`,
  )
  return rows.map(toRecord)
}

export async function getAiProvider(db: Queryable, slug: string): Promise<OperatorAiProviderRecord | null> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT slug, label, base_url, models, context_window, enabled, sort_order
       FROM operator_ai_providers WHERE slug = $1`,
    [slug],
  )
  return rows[0] ? toRecord(rows[0]) : null
}

// Inserts or replaces a provider's metadata. The sort order places a new provider at the end
// while preserving an existing one's position, so the failover order an operator arranged is
// stable across edits.
export async function upsertAiProvider(db: Queryable, input: ProviderUpsert): Promise<OperatorAiProviderRecord> {
  const { rows } = await db.query<ProviderRow>(
    `INSERT INTO operator_ai_providers (slug, label, base_url, models, context_window, enabled, sort_order)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6,
             COALESCE((SELECT sort_order FROM operator_ai_providers WHERE slug = $1),
                      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM operator_ai_providers)))
     ON CONFLICT (slug) DO UPDATE
       SET label = EXCLUDED.label,
           base_url = EXCLUDED.base_url,
           models = EXCLUDED.models,
           context_window = EXCLUDED.context_window,
           enabled = EXCLUDED.enabled,
           updated_at = now()
     RETURNING slug, label, base_url, models, context_window, enabled, sort_order`,
    [input.slug, input.label, input.baseUrl, JSON.stringify(input.models), input.contextWindow, input.enabled],
  )
  return toRecord(rows[0])
}

export async function deleteAiProvider(db: Queryable, slug: string): Promise<boolean> {
  const { rows } = await db.query<{ slug: string }>(`DELETE FROM operator_ai_providers WHERE slug = $1 RETURNING slug`, [slug])
  return rows.length > 0
}
