// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Maps each governed Operator capability to the in-zone control command, least-privilege scopes, and outcome shaping it executes through.

// The single control-plane invocation that applies a capability. command and subcommand
// name the control command; flags is the control-invoke flag map, already using the
// control flag names. Every governed Operator capability is in-zone: the control surface
// deliberately excludes cross-zone commands (zone management) from a zone-bound key.
export interface ControlInvocation {
  command: string
  subcommand: string
  flags: Record<string, unknown>
}

// Generated material a capability needs that is not derivable from its arguments. The
// only case today is a freshly minted client secret for a rotation, supplied by the
// executor so the mapping stays deterministic and testable.
export interface ControlGen {
  secret: string
}

// The ledger-safe result of applying a capability through the control plane. detail is
// the human summary persisted to the turn; output carries one-time material (such as an
// issued client secret) that reaches the caller in the HTTP response only.
export interface ControlOutcome {
  detail: string
  output?: Record<string, unknown>
}

// A governed capability: the scopes its control command requires, the invocation built
// from the capability arguments, and the outcome shaped from the control-invoke result. A
// capability holds no authority — the control plane decides — so this only describes how
// to express the capability as a governed control command.
export interface ControlCapability {
  scopes: readonly string[]
  buildInvocation(args: Record<string, unknown>, gen: ControlGen): ControlInvocation
  describeOutcome(result: unknown, args: Record<string, unknown>, gen: ControlGen): ControlOutcome
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function asScopes(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString) : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pluralize(singular: string): string {
  return /[^aeiou]y$/.test(singular) ? `${singular.slice(0, -1)}ies` : `${singular}s`
}

function countLabel(rows: unknown[], singular: string): string {
  const n = rows.length
  return `Found ${n} ${n === 1 ? singular : pluralize(singular)}`
}

// A governed read capability: lists the live rows of a noun and surfaces them under their
// plural key with a counted, pluralized detail. command names the control command; noun is
// the singular surfaced to the human, so identity-provider rows still read as “providers”.
function readControl(command: string, noun: string): ControlCapability {
  return {
    scopes: [`control:${command}:read`],
    buildInvocation: () => ({ command, subcommand: 'list', flags: {} }),
    describeOutcome: (result) => {
      const rows = asArray(result)
      return { detail: `${countLabel(rows, noun)} in this zone.`, output: { [pluralize(noun)]: rows } }
    },
  }
}

// A governed remove capability: applies a delete or revoke that needs only the object id,
// requests the least-privilege delete scope, and surfaces the id back as a one-time output.
// subcommand is the control verb (delete or revoke); idArg names both the capability argument
// and the output key.
function removeControl(command: string, subcommand: string, idArg: string, describe: (id: string) => string): ControlCapability {
  return {
    scopes: [`control:${command}:delete`],
    buildInvocation: (args) => ({ command, subcommand, flags: { id: asString(args[idArg]) } }),
    describeOutcome: (_result, args) => {
      const id = asString(args[idArg])
      return { detail: describe(id), output: { [idArg]: id } }
    },
  }
}

// The governed control mapping for every Operator capability that executes through the
// control plane. Read capabilities map to a list command and surface the live rows;
// mutating capabilities map to a create or patch command and surface the ledger-safe
// detail plus any one-time output. Zone lifecycle is absent: the control surface does not
// expose cross-zone commands to a zone-bound key, so creating or listing zones is a
// platform operation outside the Operator's governed authority. A capability absent here
// is not governed-executable and stays plan-only.
export const CONTROL_CAPABILITIES: Record<string, ControlCapability> = {
  listApplications: readControl('app', 'application'),
  listProviders: readControl('identity-provider', 'provider'),
  listResources: readControl('resource', 'resource'),
  // The control policy list returns metadata only — name, description, ownership — never the
  // Rego source, which lives in policy versions behind a separate read. So a list is safe to
  // surface in full without leaking policy logic.
  listPolicies: readControl('policy', 'policy'),
  listGrants: readControl('grant', 'grant'),

  registerApplication: {
    scopes: ['control:app:write'],
    buildInvocation: (args) => ({ command: 'app', subcommand: 'create', flags: { name: asString(args.name) } }),
    describeOutcome: (result, args) => {
      const app = asRecord(result)
      return {
        detail: `Registered application “${asString(args.name)}” and issued a client secret.`,
        output: { application_id: app.id, client_secret: app.client_secret },
      }
    },
  },
  // A resource is created from just its name and the scopes it exposes; the control plane derives
  // the resource://<slug> identifier from the name. This is the thin, credential-free create the
  // Operator can apply directly — a caracal_mandate target verifies Caracal's own mandate, so no
  // provider or upstream credential is involved.
  defineResource: {
    scopes: ['control:resource:write'],
    buildInvocation: (args) => ({
      command: 'resource',
      subcommand: 'create',
      flags: { name: asString(args.name), scopes: asScopes(args.scopes) },
    }),
    describeOutcome: (result, args) => {
      const resource = asRecord(result)
      const scopes = asScopes(args.scopes)
      return {
        detail: `Defined resource “${asString(args.name)}” exposing ${scopes.join(', ')}.`,
        output: { resource_id: resource.id },
      }
    },
  },
  rotateApplicationSecret: {
    scopes: ['control:app:write'],
    // The control plane sets a caller-provided secret rather than minting one, so the
    // Operator generates a fresh high-entropy secret and sets it through app patch. This
    // is the same way an external customer rotates a secret through the control plane.
    buildInvocation: (args, gen) => ({
      command: 'app',
      subcommand: 'patch',
      flags: { id: asString(args.application_id), 'client-secret': gen.secret },
    }),
    describeOutcome: (_result, args, gen) => ({
      detail: `Rotated the client secret for application ${asString(args.application_id)} and retired the old one.`,
      output: { application_id: asString(args.application_id), client_secret: gen.secret },
    }),
  },
  deleteApplication: removeControl('app', 'delete', 'application_id', (id) => `Deleted application ${id} from this zone.`),
  deleteResource: removeControl('resource', 'delete', 'resource_id', (id) => `Deleted resource ${id} from this zone.`),
  deleteProvider: removeControl('identity-provider', 'delete', 'provider_id', (id) => `Deleted provider ${id} from this zone.`),
  deletePolicy: removeControl('policy', 'delete', 'policy_id', (id) => `Deleted policy ${id} from this zone.`),
  revokeGrant: removeControl('grant', 'revoke', 'grant_id', (id) => `Revoked grant ${id} and the active sessions it authorized.`),
  grantAccess: {
    scopes: ['control:grant:write'],
    buildInvocation: (args) => ({
      command: 'grant',
      subcommand: 'create',
      flags: {
        'application-id': asString(args.application_id),
        'user-id': asString(args.user_id),
        'resource-id': asString(args.resource_id),
        scopes: asScopes(args.scopes),
      },
    }),
    describeOutcome: (result, args) => {
      const grant = asRecord(result)
      const scopes = asScopes(args.scopes)
      return {
        detail: `Granted ${scopes.join(', ')} to application ${asString(args.application_id)} on resource ${asString(args.resource_id)}.`,
        output: { grant_id: grant.id },
      }
    },
  },
}

// Whether a capability executes through the control plane. A capability that maps to no
// in-zone control command (or needs configuration the thin arguments cannot supply) is
// not governed-executable and stays plan-only.
export function isControlExecutable(capabilityId: string): boolean {
  return capabilityId in CONTROL_CAPABILITIES
}
