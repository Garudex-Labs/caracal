// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Read-only execution preview that resolves each catalog-valid plan step against live control-plane state.

import { CAPABILITIES, validateProposedPlan, type PlanDiagnostic, type PreviewTarget, type ProposedPlanInput } from './operator-capabilities.js'

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

// The live-state table and predicate behind each preview target. The keys are a fixed
// internal enum (never caller-supplied) so the table name and predicate carry no injection
// surface; ids, names, and zones are always bound parameters. Owning the database detail
// here keeps the capability catalog free of any schema knowledge.
const PREVIEW_TARGETS: Record<PreviewTarget, { table: string; live: string }> = {
  zones: { table: 'zones', live: 'archived_at IS NULL' },
  applications: { table: 'applications', live: 'archived_at IS NULL' },
  providers: { table: 'providers', live: 'archived_at IS NULL' },
  resources: { table: 'resources', live: 'archived_at IS NULL' },
  policies: { table: 'policies', live: 'archived_at IS NULL' },
  grants: { table: 'delegated_grants', live: "status <> 'revoked'" },
}

// Whether a live object of the named target already carries the given name. Zones are not
// zone-scoped; every other target is bounded to the current zone.
async function nameTaken(db: PreviewQueryable, target: PreviewTarget, zoneId: string, name: string): Promise<boolean> {
  const { table, live } = PREVIEW_TARGETS[target]
  const zoneScoped = target !== 'zones'
  const where = zoneScoped ? `name = $1 AND zone_id = $2 AND ${live}` : `name = $1 AND ${live}`
  const params = zoneScoped ? [name, zoneId] : [name]
  const { rows } = await db.query<{ one: number }>(`SELECT 1 AS one FROM ${table} WHERE ${where} LIMIT 1`, params)
  return rows.length > 0
}

// Whether a live object of the named target exists in the zone under the given id.
async function idLive(db: PreviewQueryable, target: PreviewTarget, zoneId: string, id: string): Promise<boolean> {
  const { table, live } = PREVIEW_TARGETS[target]
  const { rows } = await db.query<{ one: number }>(
    `SELECT 1 AS one FROM ${table} WHERE id = $1 AND zone_id = $2 AND ${live} LIMIT 1`,
    [id, zoneId],
  )
  return rows.length > 0
}

// Resolves a single validated step's effect against live state, driven entirely by the
// capability's declared preview spec. Each branch is a read-only lookup; the catalog has
// already guaranteed the capability and its arguments. A new capability previews correctly
// the moment it declares a preview spec — this interpreter never changes.
async function previewStep(
  db: PreviewQueryable,
  zoneId: string,
  capabilityId: string,
  args: Record<string, unknown>,
): Promise<{ effect: StepEffect; detail: string }> {
  const preview = CAPABILITIES[capabilityId]?.preview ?? { kind: 'read' }

  switch (preview.kind) {
    case 'read':
      return { effect: 'read_only', detail: 'Reads current state; changes nothing.' }

    case 'createByName': {
      const name = String(args.name)
      return (await nameTaken(db, preview.target, zoneId, name))
        ? { effect: 'exists', detail: preview.exists(name) }
        : { effect: 'create', detail: preview.create(name) }
    }

    case 'mutateById': {
      const id = String(args[preview.idArg])
      return (await idLive(db, preview.target, zoneId, id))
        ? { effect: preview.effect, detail: preview.live(id) }
        : { effect: 'blocked', detail: preview.blocked(id) }
    }

    case 'requireLiveThenCreate': {
      for (const requirement of preview.requires) {
        const id = String(args[requirement.idArg])
        if (!(await idLive(db, requirement.target, zoneId, id))) {
          return { effect: 'blocked', detail: requirement.blocked(id) }
        }
      }
      return { effect: 'create', detail: preview.create(args) }
    }
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
