// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Persistence for the Operator's model-provider registry, holding only non-secret metadata while each upstream key lives in the sealed Caracal provider.

import type { Queryable } from './db.js'
import {
  LLM_SCOPE,
  OPERATOR_POLICY_NAME,
  OPERATOR_POLICY_SET_NAME,
  OPERATOR_ROLE,
  llmProviderIdentifier,
  llmResourceIdentifier,
} from './system-zone.js'

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
  auth: AuthPlacement
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
}

// Lists every configured provider in display order, newest fields included. Read on boot to
// build the gateway and on each registry change to rebuild it.
export async function listAiProviders(db: Queryable): Promise<OperatorAiProviderRecord[]> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT slug, label, base_url, models, context_window, enabled, sort_order, auth_config
       FROM operator_ai_providers
      ORDER BY sort_order, slug`,
  )
  return rows.map(toRecord)
}

interface GovernedResourceRow {
  resource_identifier: string
  provider_identifier: string
  grant_content: string
}

function grantedResources(content: string, operatorAppId: string): Set<string> {
  const assignment = content
    .split('\n')
    .find((line) => line.startsWith('grants := '))
    ?.slice('grants := '.length)
  if (!assignment) return new Set()

  try {
    const parsed = JSON.parse(assignment) as Record<string, unknown>
    return new Set(
      Object.entries(parsed)
        .filter(([, rawGrant]) => {
          if (!rawGrant || typeof rawGrant !== 'object' || Array.isArray(rawGrant)) return false
          const grant = rawGrant as { application?: unknown; roles?: unknown }
          if (grant.application !== operatorAppId || !grant.roles || typeof grant.roles !== 'object' || Array.isArray(grant.roles))
            return false
          const scopes = (grant.roles as Record<string, unknown>)[OPERATOR_ROLE]
          return Array.isArray(scopes) && scopes.includes(LLM_SCOPE)
        })
        .map(([identifier]) => identifier),
    )
  } catch {
    return new Set()
  }
}

// Resolves only complete governed endpoints. A deterministic identifier alone is insufficient:
// a failed lifecycle reconcile can leave registry metadata without a sealed key, resource, or
// active grant. Requiring all three keeps a remote replica from selecting that partial state.
export async function listReadyAiProviderResources(
  db: Queryable,
  zoneId: string,
  operatorAppId: string,
  records: OperatorAiProviderRecord[],
): Promise<Map<string, string>> {
  const { rows } = await db.query<GovernedResourceRow>(
    `SELECT DISTINCT r.identifier AS resource_identifier,
                     p.identifier AS provider_identifier,
                     pv.content AS grant_content
       FROM resources r
       JOIN providers p
         ON p.id = r.credential_provider_id
        AND p.zone_id = r.zone_id
        AND p.archived_at IS NULL
       JOIN policy_sets ps
         ON ps.zone_id = r.zone_id
        AND ps.name = $2
        AND ps.archived_at IS NULL
       JOIN policy_set_bindings psb
         ON psb.zone_id = ps.zone_id
        AND psb.policy_set_id = ps.id
        AND psb.active_version_id IS NOT NULL
       JOIN policy_set_versions psv
         ON psv.id = psb.active_version_id
        AND psv.policy_set_id = ps.id
        AND psv.archived_at IS NULL
       JOIN LATERAL jsonb_array_elements(psv.manifest_json) manifest ON true
       JOIN policy_versions pv
         ON pv.id = manifest->>'policy_version_id'
        AND pv.archived_at IS NULL
       JOIN policies policy
         ON policy.id = pv.policy_id
        AND policy.zone_id = r.zone_id
        AND policy.name = $3
        AND policy.archived_at IS NULL
      WHERE r.zone_id = $1
        AND r.archived_at IS NULL
        AND r.operation_enforcement = 'transport_uniform'
        AND $4 = ANY(r.scopes)
        AND p.provider_kind = 'api_key'
        AND p.secret_config_keys @> ARRAY['api_key']::text[]
        AND p.config_json @> '{"allow_runtime_injection": true}'::jsonb`,
    [zoneId, OPERATOR_POLICY_SET_NAME, OPERATOR_POLICY_NAME, LLM_SCOPE],
  )

  const granted = new Set<string>()
  for (const row of rows) {
    for (const identifier of grantedResources(row.grant_content, operatorAppId)) granted.add(identifier)
  }

  const ready = new Map<string, string>()
  for (const record of records) {
    const resourceIdentifier = llmResourceIdentifier(record.slug)
    const providerIdentifier = llmProviderIdentifier(record.slug)
    const complete = rows.some(
      (row) =>
        row.resource_identifier === resourceIdentifier && row.provider_identifier === providerIdentifier && granted.has(resourceIdentifier),
    )
    if (complete) ready.set(record.slug, resourceIdentifier)
  }
  return ready
}

export async function getAiProvider(db: Queryable, slug: string): Promise<OperatorAiProviderRecord | null> {
  const { rows } = await db.query<ProviderRow>(
    `SELECT slug, label, base_url, models, context_window, enabled, sort_order, auth_config
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
    `INSERT INTO operator_ai_providers (slug, label, base_url, models, context_window, enabled, auth_config, sort_order)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb,
             COALESCE((SELECT sort_order FROM operator_ai_providers WHERE slug = $1),
                      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM operator_ai_providers)))
     ON CONFLICT (slug) DO UPDATE
       SET label = EXCLUDED.label,
           base_url = EXCLUDED.base_url,
           models = EXCLUDED.models,
           context_window = EXCLUDED.context_window,
           enabled = EXCLUDED.enabled,
           auth_config = EXCLUDED.auth_config,
           updated_at = now()
     RETURNING slug, label, base_url, models, context_window, enabled, sort_order, auth_config`,
    [input.slug, input.label, input.baseUrl, JSON.stringify(input.models), input.contextWindow, input.enabled, JSON.stringify(input.auth)],
  )
  return toRecord(rows[0])
}

export async function deleteAiProvider(db: Queryable, slug: string): Promise<boolean> {
  const { rows } = await db.query<{ slug: string }>(`DELETE FROM operator_ai_providers WHERE slug = $1 RETURNING slug`, [slug])
  return rows.length > 0
}
