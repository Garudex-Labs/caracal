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

function countLabel(rows: unknown[], singular: string): string {
  const n = rows.length
  return `Found ${n} ${singular}${n === 1 ? '' : 's'}`
}

// The governed control mapping for every Operator capability that executes through the
// control plane. Read capabilities map to a list command and surface the live rows;
// mutating capabilities map to a create or patch command and surface the ledger-safe
// detail plus any one-time output. Zone lifecycle is absent: the control surface does not
// expose cross-zone commands to a zone-bound key, so creating or listing zones is a
// platform operation outside the Operator's governed authority. A capability absent here
// is not governed-executable and stays plan-only.
export const CONTROL_CAPABILITIES: Record<string, ControlCapability> = {
  listApplications: {
    scopes: ['control:app:read'],
    buildInvocation: () => ({ command: 'app', subcommand: 'list', flags: {} }),
    describeOutcome: (result) => {
      const applications = asArray(result)
      return { detail: `${countLabel(applications, 'application')} in this zone.`, output: { applications } }
    },
  },
  listProviders: {
    scopes: ['control:identity-provider:read'],
    buildInvocation: () => ({ command: 'identity-provider', subcommand: 'list', flags: {} }),
    describeOutcome: (result) => {
      const providers = asArray(result)
      return { detail: `${countLabel(providers, 'provider')} in this zone.`, output: { providers } }
    },
  },

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
