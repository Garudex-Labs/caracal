// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator execution engine: applies an approved plan's steps through shared capability handlers.

import type { TxClient } from './db.js'
import { createZoneRecord } from './routes/zones.js'
import { createManagedApplication, rotateApplicationClientSecret } from './routes/applications.js'
import { createDelegatedGrant } from './routes/grants.js'

// The outcome of applying one step. detail is ledger-safe (never a secret); output
// carries any one-time material that must reach the caller in the HTTP response only
// and is never persisted to a turn; audit identifies the entity the step changed so the
// execution can be recorded in Caracal's own admin audit log, per entity, the same way a
// manual change through the API would be.
export interface StepOutcome {
  detail: string
  output?: Record<string, unknown>
  audit?: StepAudit
}

// Identifies the control-plane entity a mutating step created or changed, and the zone
// whose tamper-evident audit chain the record belongs to. Read-only steps leave this
// unset, so they are never recorded as mutations.
export interface StepAudit {
  entityType: string
  entityId: string | null
  zoneId: string
}

// A capability handler performs one real control-plane operation inside the caller's
// transaction. Handlers are the single execution path: they call the same shared
// functions the manual routes use, so the Operator can do nothing a route cannot.
type CapabilityHandler = (client: TxClient, zoneId: string, args: Record<string, unknown>) => Promise<StepOutcome>

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function asScopes(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString) : []
}

const HANDLERS: Record<string, CapabilityHandler> = {
  // Read capabilities resolve real control-plane state and return it as step output, so
  // the Operator can answer "what do I have" with live data rather than prose.
  listZones: async (client) => {
    const { rows } = await client.query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM zones ORDER BY created_at DESC, id DESC LIMIT 200`,
    )
    return { detail: `Found ${rows.length} zone${rows.length === 1 ? '' : 's'}.`, output: { zones: rows } }
  },
  listApplications: async (client, zoneId) => {
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM applications
        WHERE zone_id = $1 AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 200`,
      [zoneId],
    )
    return {
      detail: `Found ${rows.length} application${rows.length === 1 ? '' : 's'} in this zone.`,
      output: { applications: rows },
    }
  },
  listProviders: async (client, zoneId) => {
    const { rows } = await client.query<{ id: string; name: string; provider_kind: string }>(
      `SELECT id, name, provider_kind FROM providers
        WHERE zone_id = $1 AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 200`,
      [zoneId],
    )
    return {
      detail: `Found ${rows.length} provider${rows.length === 1 ? '' : 's'} in this zone.`,
      output: { providers: rows },
    }
  },
  explainAccess: async (client, zoneId, args) => {
    const conditions = ['zone_id = $1', "status = 'active'"]
    const values: unknown[] = [zoneId]
    if (args.application_id !== undefined) {
      values.push(asString(args.application_id))
      conditions.push(`application_id = $${values.length}`)
    }
    if (args.resource_id !== undefined) {
      values.push(asString(args.resource_id))
      conditions.push(`resource_id = $${values.length}`)
    }
    const { rows } = await client.query<{ application_id: string; resource_id: string; user_id: string; scopes: string[] }>(
      `SELECT application_id, resource_id, user_id, scopes FROM delegated_grants
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC LIMIT 200`,
      values,
    )
    const detail =
      rows.length === 0
        ? 'No active grants match. Access would be denied for that combination.'
        : `Found ${rows.length} active grant${rows.length === 1 ? '' : 's'} that permit access.`
    return { detail, output: { grants: rows } }
  },

  createZone: async (client, _zoneId, args) => {
    const zone = await createZoneRecord(client, { name: asString(args.name) })
    return {
      detail: `Created zone “${zone.name}”.`,
      output: { zone_id: zone.id, slug: zone.slug },
      audit: { entityType: 'zones', entityId: zone.id, zoneId: zone.id },
    }
  },
  registerApplication: async (client, zoneId, args) => {
    const { row, clientSecret } = await createManagedApplication(client, zoneId, {
      name: asString(args.name),
    })
    // The plaintext secret is returned for this response only; the persisted detail
    // records that a secret was issued without ever storing it.
    return {
      detail: `Registered application “${asString(args.name)}” and issued a client secret.`,
      output: { application_id: row.id, client_secret: clientSecret },
      audit: { entityType: 'applications', entityId: row.id, zoneId },
    }
  },
  rotateApplicationSecret: async (client, zoneId, args) => {
    const applicationId = asString(args.application_id)
    const result = await rotateApplicationClientSecret(client, zoneId, applicationId)
    if (!result) {
      throw new StepExecutionError('', 'rotateApplicationSecret', `application ${applicationId} was not found in this zone`)
    }
    return {
      detail: `Rotated the client secret for application ${applicationId} and retired the old one.`,
      output: { application_id: applicationId, client_secret: result.clientSecret },
      audit: { entityType: 'applications', entityId: applicationId, zoneId },
    }
  },
  grantAccess: async (client, zoneId, args) => {
    const result = await createDelegatedGrant(client, zoneId, {
      application_id: asString(args.application_id),
      user_id: asString(args.user_id),
      resource_id: asString(args.resource_id),
      scopes: asScopes(args.scopes),
    })
    if (!result.ok) {
      throw new StepExecutionError('', 'grantAccess', result.error)
    }
    const scopes = asScopes(args.scopes)
    return {
      detail: `Granted ${scopes.join(', ')} to application ${asString(args.application_id)} on resource ${asString(args.resource_id)}.`,
      output: { grant_id: result.row.id },
      audit: { entityType: 'grants', entityId: result.row.id, zoneId },
    }
  },
}

export function isExecutable(capabilityId: string): boolean {
  return capabilityId in HANDLERS
}

export interface PlanStepToExecute {
  id: string
  capability: string
  args: Record<string, unknown>
}

// Identifies steps whose capability has no execution handler. Execution refuses the
// whole plan up-front when this is non-empty so a plan never half-applies.
export function unsupportedSteps(steps: PlanStepToExecute[]): PlanStepToExecute[] {
  return steps.filter((step) => !isExecutable(step.capability))
}

// Raised when a handler fails, carrying the step so the caller can roll back the
// whole plan and record a precise failure without leaking internal error text.
export class StepExecutionError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly capability: string,
    message: string,
  ) {
    super(message)
    this.name = 'StepExecutionError'
  }
}

export interface ExecutedStep {
  id: string
  capability: string
  detail: string
  output?: Record<string, unknown>
  audit?: StepAudit
}

// Applies every step in order within the caller's open transaction. Any handler
// failure throws StepExecutionError, so the caller's transaction rolls back and no
// step is partially applied.
export async function applyPlanSteps(client: TxClient, zoneId: string, steps: PlanStepToExecute[]): Promise<ExecutedStep[]> {
  const executed: ExecutedStep[] = []
  for (const step of steps) {
    const handler = HANDLERS[step.capability]
    if (!handler) {
      throw new StepExecutionError(step.id, step.capability, 'capability is not executable')
    }
    try {
      const outcome = await handler(client, zoneId, step.args)
      executed.push({ id: step.id, capability: step.capability, detail: outcome.detail, output: outcome.output, audit: outcome.audit })
    } catch (err) {
      if (err instanceof StepExecutionError) throw err
      const message = err instanceof Error ? err.message : 'step failed'
      throw new StepExecutionError(step.id, step.capability, message)
    }
  }
  return executed
}
