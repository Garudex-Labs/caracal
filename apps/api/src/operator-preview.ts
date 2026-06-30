// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Read-only execution preview that resolves each catalog-valid plan step against live control-plane state.

import { validateProposedPlan, type PlanDiagnostic, type ProposedPlanInput } from './operator-capabilities.js'

// The minimal read surface the preview needs. The API DB satisfies this
// structurally; the preview never writes, so only query is required.
export interface PreviewQueryable {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

// What applying a step would do against current state. Purely informational: the
// preview performs no writes and resolves entirely from live reads.
export type StepEffect = 'create' | 'update' | 'delete' | 'exists' | 'blocked' | 'read_only'

export interface StepPreview {
  id: string
  capability: string
  title: string
  mutating: boolean
  effect: StepEffect
  detail: string
}

export interface PlanPreview {
  ok: boolean
  mutating: boolean
  steps: StepPreview[]
  diagnostics: PlanDiagnostic[]
}

async function nameTaken(
  db: PreviewQueryable,
  table: 'zones' | 'applications' | 'providers' | 'resources',
  zoneId: string,
  name: string,
): Promise<boolean> {
  // table is a fixed internal literal (never caller-supplied), so the interpolation
  // carries no injection surface; name and zone are always bound parameters.
  const scope = table === 'zones' ? 'id IS NOT NULL' : 'zone_id = $2'
  const params = table === 'zones' ? [name] : [name, zoneId]
  const { rows } = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM ${table}
     WHERE name = $1 AND ${scope} AND archived_at IS NULL LIMIT 1`,
    params,
  )
  return rows.length > 0
}

async function idLive(db: PreviewQueryable, table: 'applications' | 'resources', zoneId: string, id: string): Promise<boolean> {
  const { rows } = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM ${table}
     WHERE id = $1 AND zone_id = $2 AND archived_at IS NULL LIMIT 1`,
    [id, zoneId],
  )
  return rows.length > 0
}

// Resolves a single validated step's effect against live state. Each branch is a
// read-only lookup; the catalog has already guaranteed the capability and args.
async function previewStep(
  db: PreviewQueryable,
  zoneId: string,
  capabilityId: string,
  args: Record<string, unknown>,
): Promise<{ effect: StepEffect; detail: string }> {
  switch (capabilityId) {
    case 'listZones':
    case 'listApplications':
    case 'listProviders':
    case 'listResources':
    case 'listPolicies':
    case 'explainAccess':
      return { effect: 'read_only', detail: 'Reads current state; changes nothing.' }

    case 'createZone': {
      const name = String(args.name)
      return (await nameTaken(db, 'zones', zoneId, name))
        ? { effect: 'exists', detail: `A zone named “${name}” already exists.` }
        : { effect: 'create', detail: `Would create zone “${name}”.` }
    }

    case 'registerApplication': {
      const name = String(args.name)
      return (await nameTaken(db, 'applications', zoneId, name))
        ? { effect: 'exists', detail: `An application named “${name}” already exists.` }
        : { effect: 'create', detail: `Would register application “${name}”.` }
    }

    case 'connectProvider': {
      const name = String(args.name)
      return (await nameTaken(db, 'providers', zoneId, name))
        ? { effect: 'exists', detail: `A provider named “${name}” already exists.` }
        : { effect: 'create', detail: `Would connect provider “${name}”.` }
    }

    case 'defineResource': {
      const name = String(args.name)
      return (await nameTaken(db, 'resources', zoneId, name))
        ? { effect: 'exists', detail: `A resource named “${name}” already exists.` }
        : { effect: 'create', detail: `Would define resource “${name}”.` }
    }

    case 'rotateApplicationSecret': {
      const appId = String(args.application_id)
      return (await idLive(db, 'applications', zoneId, appId))
        ? { effect: 'update', detail: `Would rotate the secret for application ${appId}.` }
        : { effect: 'blocked', detail: `Application ${appId} was not found in this zone.` }
    }

    case 'deleteApplication': {
      const appId = String(args.application_id)
      return (await idLive(db, 'applications', zoneId, appId))
        ? { effect: 'delete', detail: `Would delete application ${appId} from this zone.` }
        : { effect: 'blocked', detail: `Application ${appId} was not found in this zone.` }
    }

    case 'grantAccess': {
      const appId = String(args.application_id)
      const resourceId = String(args.resource_id)
      if (!(await idLive(db, 'applications', zoneId, appId))) {
        return { effect: 'blocked', detail: `Application ${appId} was not found in this zone.` }
      }
      if (!(await idLive(db, 'resources', zoneId, resourceId))) {
        return { effect: 'blocked', detail: `Resource ${resourceId} was not found in this zone.` }
      }
      const scopes = Array.isArray(args.scopes) ? (args.scopes as string[]) : []
      return {
        effect: 'create',
        detail: `Would grant ${scopes.join(', ')} to application ${appId} on resource ${resourceId}.`,
      }
    }

    default:
      return { effect: 'read_only', detail: 'No preview available for this capability.' }
  }
}

// Validates a proposed plan against the catalog, then resolves each step's effect
// against live state. Returns the catalog diagnostics unchanged when validation
// fails so a caller never previews an unverified plan.
export async function previewPlan(db: PreviewQueryable, zoneId: string, plan: ProposedPlanInput): Promise<PlanPreview> {
  const validation = validateProposedPlan(plan)
  if (!validation.ok) {
    return { ok: false, mutating: validation.mutating, steps: [], diagnostics: validation.diagnostics }
  }

  const steps: StepPreview[] = []
  for (const step of validation.steps) {
    const { effect, detail } = await previewStep(db, zoneId, step.capability, step.args)
    steps.push({
      id: step.id,
      capability: step.capability,
      title: step.title,
      mutating: step.mutating,
      effect,
      detail,
    })
  }

  const blocked = steps.some((s) => s.effect === 'blocked')
  return { ok: !blocked, mutating: validation.mutating, steps, diagnostics: [] }
}
