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

// The ledger-safe result of applying a capability through the control plane. detail is
// the human summary persisted to the turn; output carries one-time material (such as an
// issued client secret) that reaches the caller in the HTTP response only.
export interface ControlOutcome {
  detail: string
  output?: Record<string, unknown>
}

// A governed capability: the scopes its control command requires, the invocation built
// from the capability arguments, and the outcome shaped from the control-invoke result. A
// capability holds no authority - the control plane decides - so this only describes how
// to express the capability as a governed control command. secrets carries the pasted
// credential values a step collected through the console's secure prompt, opened from the
// vault at apply time only; they are merged into the invocation in memory and never touch
// the plan, the ledger, or any log.
export interface ControlCapability {
  scopes: readonly string[]
  buildInvocation(args: Record<string, unknown>, secrets?: Record<string, string>): ControlInvocation
  describeOutcome(result: unknown, args: Record<string, unknown>): ControlOutcome
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

// Unwraps a list result to its rows: a bare array is taken as-is, and an envelope carrying
// rows under `rows` or `items` (the delegation read pages through `items`) is unwrapped.
function asRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const envelope = asRecord(value)
  if (Array.isArray(envelope.rows)) return envelope.rows
  if (Array.isArray(envelope.items)) return envelope.items
  return []
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
// The read verb and its fixed flags default to a plain list but a read whose control
// command pages differently (delegation active, audit tail) names its own verb and bounds.
function readControl(command: string, noun: string, subcommand: string = 'list', flags: Record<string, unknown> = {}): ControlCapability {
  return {
    scopes: [`control:${command}:read`],
    buildInvocation: () => ({ command, subcommand, flags }),
    describeOutcome: (result) => {
      const rows = asRows(result)
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
  // The control policy list returns metadata only - name, description, ownership - never the
  // Rego source, which lives in policy versions behind a separate read. So a list is safe to
  // surface in full without leaking policy logic.
  listPolicies: readControl('policy', 'policy'),
  listPolicySets: readControl('policy-set', 'policy set'),
  listGrants: readControl('grant', 'grant'),
  listSessions: readControl('session', 'session'),
  listAgents: readControl('agent', 'agent session'),
  listDelegations: readControl('delegation', 'delegation', 'active'),
  // The audit read tails the most recent decisions; the bound keeps a read small while still
  // showing what the zone decided last.
  listAuditEvents: readControl('audit', 'audit event', 'tail', { limit: 50 }),

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
  // A provider is created from its name, kind, and non-secret config. The credential-free kinds -
  // caracal_mandate, which forwards Caracal’s own mandate, and none, which forwards nothing - apply
  // from name and kind alone. A credential-bearing kind (oauth2, api_key, bearer_token) merges the
  // credentials the operator pasted through the console's secure prompt - opened from the sealed
  // vault at apply time - into the create config here, in memory only; the provider create seals
  // them at their final place and this invocation is never persisted. The control plane derives the
  // provider:// identifier from the name.
  connectProvider: {
    scopes: ['control:identity-provider:write'],
    buildInvocation: (args, secrets) => {
      const config = { ...asRecord(args.config), ...(secrets ?? {}) }
      return {
        command: 'identity-provider',
        subcommand: 'create',
        flags: {
          name: asString(args.name),
          kind: asString(args.kind),
          ...(Object.keys(config).length > 0 ? { config: JSON.stringify(config) } : {}),
        },
      }
    },
    describeOutcome: (result, args) => {
      const provider = asRecord(result)
      return {
        detail: `Connected provider “${asString(args.name)}” (${asString(args.kind)}).`,
        output: { provider_id: provider.id },
      }
    },
  },
  // A resource is created with its full Gateway routing in one step: the control plane requires
  // every resource to name the upstream URL it fronts and the provider whose credential the
  // Gateway attaches. The resource://<slug> identifier is derived from the name.
  defineResource: {
    scopes: ['control:resource:write'],
    buildInvocation: (args) => ({
      command: 'resource',
      subcommand: 'create',
      flags: {
        name: asString(args.name),
        scopes: asScopes(args.scopes),
        'upstream-url': asString(args.upstream_url),
        'credential-provider-id': asString(args.credential_provider_id),
      },
    }),
    describeOutcome: (result, args) => {
      const resource = asRecord(result)
      const scopes = asScopes(args.scopes)
      return {
        detail: `Defined resource “${asString(args.name)}” exposing ${scopes.join(', ')}, routed to ${asString(args.upstream_url)}.`,
        output: { resource_id: resource.id },
      }
    },
  },
  // The control plane mints the replacement secret server-side and returns it once in the
  // rotation response; it reaches the caller through the step output only and is never
  // persisted to the plan or the ledger.
  rotateApplicationSecret: {
    scopes: ['control:app:write'],
    buildInvocation: (args) => ({
      command: 'app',
      subcommand: 'rotate-secret',
      flags: { id: asString(args.application_id) },
    }),
    describeOutcome: (result, args) => ({
      detail: `Rotated the client secret for application ${asString(args.application_id)} and retired the old one.`,
      output: { application_id: asString(args.application_id), client_secret: asString(asRecord(result).client_secret) },
    }),
  },
  deleteApplication: removeControl('app', 'delete', 'application_id', (id) => `Deleted application ${id} from this zone.`),
  deleteResource: removeControl('resource', 'delete', 'resource_id', (id) => `Deleted resource ${id} from this zone.`),
  deleteProvider: removeControl('identity-provider', 'delete', 'provider_id', (id) => `Deleted provider ${id} from this zone.`),
  deletePolicy: removeControl('policy', 'delete', 'policy_id', (id) => `Deleted policy ${id} from this zone.`),
  // Creates a policy from an authored data document and seals its first immutable version. The
  // Rego content rides inline - it is the policy logic, not a secret - and the control plane
  // validates it on create, so an invalid document is rejected there rather than applied. The
  // create returns the policy and its first version, both surfaced so a follow-on action can
  // compose the version into a policy set.
  createPolicy: {
    scopes: ['control:policy:write'],
    buildInvocation: (args) => ({
      command: 'policy',
      subcommand: 'create',
      flags: {
        name: asString(args.name),
        ...(args.description === undefined ? {} : { description: asString(args.description) }),
        content: asString(args.content),
      },
    }),
    describeOutcome: (result, args) => {
      const policy = asRecord(result)
      return {
        detail: `Created policy “${asString(args.name)}” and sealed its first version.`,
        output: { policy_id: policy.id, policy_version_id: policy.version_id },
      }
    },
  },
  // Seals a new immutable version of an existing policy from an authored data document. The
  // policy id names the existing policy; the content is the new version's Rego, validated by the
  // control plane on apply. The sealed version id is surfaced so it can compose into a policy set.
  versionPolicy: {
    scopes: ['control:policy:write'],
    buildInvocation: (args) => ({
      command: 'policy',
      subcommand: 'version',
      flags: {
        id: asString(args.policy_id),
        content: asString(args.content),
      },
    }),
    describeOutcome: (result, args) => {
      const version = asRecord(result)
      return {
        detail: `Sealed a new version of policy ${asString(args.policy_id)}.`,
        output: { policy_id: asString(args.policy_id), policy_version_id: version.version_id },
      }
    },
  },
  // Creates a policy set - the composable unit a zone activates. It holds no policy logic itself;
  // versions composed from policy versions carry that. The set id is surfaced so a follow-on
  // action can seal a version into it.
  createPolicySet: {
    scopes: ['control:policy-set:write'],
    buildInvocation: (args) => ({
      command: 'policy-set',
      subcommand: 'create',
      flags: { name: asString(args.name), ...(args.description === undefined ? {} : { description: asString(args.description) }) },
    }),
    describeOutcome: (result, args) => {
      const set = asRecord(result)
      return { detail: `Created policy set “${asString(args.name)}”.`, output: { policy_set_id: set.id } }
    },
  },
  // Seals a new immutable version of a policy set from the policy versions it composes. The
  // sealed version id is surfaced so it can be simulated and then activated.
  versionPolicySet: {
    scopes: ['control:policy-set:write'],
    buildInvocation: (args) => ({
      command: 'policy-set',
      subcommand: 'version',
      flags: { id: asString(args.policy_set_id), 'policy-versions': asScopes(args.policy_version_ids) },
    }),
    describeOutcome: (result, args) => {
      const version = asRecord(result)
      return {
        detail: `Sealed a new version of policy set ${asString(args.policy_set_id)}.`,
        output: { policy_set_id: asString(args.policy_set_id), policy_set_version_id: version.version_id },
      }
    },
  },
  // Activates a policy set version so the zone evaluates every authorization decision against it.
  // This is the zone-wide switch: activation invalidates issued tokens and reshapes the STS
  // decision, so it is the highest-impact governed policy action and rides the same approval gate.
  activatePolicySet: {
    scopes: ['control:policy-set:write'],
    buildInvocation: (args) => ({
      command: 'policy-set',
      subcommand: 'activate',
      flags: { id: asString(args.policy_set_id), version: asString(args.policy_set_version_id) },
    }),
    describeOutcome: (_result, args) => ({
      detail: `Activated version ${asString(args.policy_set_version_id)} of policy set ${asString(args.policy_set_id)} for the zone.`,
      output: { policy_set_id: asString(args.policy_set_id), policy_set_version_id: asString(args.policy_set_version_id) },
    }),
  },
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
