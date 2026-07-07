// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator capability catalog and the deterministic plan validator that grounds and safety-classifies every proposed action.

import { z } from 'zod'
import { planProviderConfigError } from './operator-plan-secrets.js'
import { SECRET_PROVIDER_CONFIG_KEYS } from './provider-config.js'

const IdRef = z.string().min(1).max(128)
const ScopePattern = /^[A-Za-z][A-Za-z0-9._:-]*$/
const Scope = z.string().min(1).max(128).regex(ScopePattern)
// A policy data document: the authored, validated Rego the create and version capabilities carry
// inline to the control plane. Bounded in length so a plan step stays small; the control plane
// re-validates the Rego on apply, so the catalog only guards shape.
const PolicyContent = z.string().min(1).max(20000)

// The object domain a capability operates on, mirroring the Console's navigation
// so the Operator reasons in user-visible terms rather than internal endpoints.
export type CapabilityDomain =
  | 'zone'
  | 'application'
  | 'provider'
  | 'resource'
  | 'policy'
  | 'grant'
  | 'session'
  | 'agent'
  | 'delegation'
  | 'audit'
  | 'workload'
  | 'approval'

// A live-state target a preview resolves against. The catalog names the logical noun; the
// preview interpreter owns the table and liveness predicate, so the catalog stays free of
// any database detail.
export type PreviewTarget =
  'applications' | 'providers' | 'resources' | 'policies' | 'policySets' | 'grants' | 'workloads' | 'agentSessions' | 'delegations'

// How a capability's effect is resolved against live state, declared on the capability so a
// new capability needs no change to the preview interpreter: a read changes nothing; a
// create-by-name is taken-or-new; a mutate-by-id is live-or-blocked; a create that depends on
// existing objects is blocked until each is live. Detail builders are pure and database-free.
export type CapabilityPreview =
  | { kind: 'read' }
  | { kind: 'createByName'; target: PreviewTarget; exists: (name: string) => string; create: (name: string) => string }
  | {
      kind: 'mutateById'
      target: PreviewTarget
      idArg: string
      effect: 'update' | 'delete'
      live: (id: string) => string
      blocked: (id: string) => string
    }
  | {
      kind: 'requireLiveThenCreate'
      requires: { target: PreviewTarget; idArg: string; blocked: (id: string) => string }[]
      create: (args: Record<string, unknown>) => string
    }

export interface Capability {
  id: string
  title: string
  summary: string
  domain: CapabilityDomain
  // Authoritative effect classification. The catalog - never a caller or a model -
  // decides whether a step changes state, so a plan cannot be approved under a
  // mislabeled read-only flag.
  mutating: boolean
  args: z.ZodType<Record<string, unknown>>
  // A concise, human-readable description of the arguments, used to ground the
  // planner agent. The authoritative shape is `args`; this only describes it.
  argsHint: string
  // How the preview resolves this capability's effect against live state. Co-located here so
  // the single declaration that adds a capability also describes how it previews.
  preview: CapabilityPreview
  // The output keys the governed apply surfaces for this step, referencable by later steps
  // through the {{steps.<id>.outputs.<key>}} syntax. Only durable identifiers appear here:
  // one-time material such as an issued client secret is never persisted, so it is never
  // referencable. Absent when a capability produces nothing a later step could bind to.
  outputs?: readonly string[]
}

const NoArgs = z.object({}).strict()

// Every config key any provider kind seals, plus the client id the credential vault also
// carries: an update's config may never touch credential material, whatever kind the
// provider turns out to be at apply time.
const PROVIDER_CREDENTIAL_KEYS = new Set(['client_id', ...Object.values(SECRET_PROVIDER_CONFIG_KEYS).flatMap((keys) => [...keys])])

// A resource operation route: the method, path, and scope triple the Gateway enforces.
const ResourceOperationArg = z.object({ method: z.string().min(1).max(16), path: z.string().min(1).max(2048), scope: Scope }).strict()

// A workload credential binding: which environment variable carries which governed
// resource credential when caracal run launches the workload.
const WorkloadBindingArg = z
  .object({
    env: z.string().min(1).max(200),
    resource: z.string().min(1).max(500),
    scopes: z.array(z.string().min(1).max(200)).max(32).optional(),
    optional: z.boolean().optional(),
    on_failure: z.enum(['warn', 'error']).optional(),
  })
  .strict()

export const CAPABILITIES: Record<string, Capability> = {
  listApplications: {
    id: 'listApplications',
    title: 'List applications',
    summary: 'Read the applications registered in the zone.',
    domain: 'application',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  registerApplication: {
    id: 'registerApplication',
    title: 'Register an application',
    summary: 'Register a managed application identity in the zone.',
    domain: 'application',
    mutating: true,
    args: z.object({ name: z.string().min(1).max(200) }).strict(),
    argsHint: 'name (string)',
    preview: {
      kind: 'createByName',
      target: 'applications',
      exists: (name) => `An application named “${name}” already exists.`,
      create: (name) => `Would register application “${name}”.`,
    },
    outputs: ['application_id'],
  },
  rotateApplicationSecret: {
    id: 'rotateApplicationSecret',
    title: 'Rotate an application secret',
    summary: 'Issue a fresh client secret for an application and retire the old one.',
    domain: 'application',
    mutating: true,
    args: z.object({ application_id: IdRef }).strict(),
    argsHint: 'application_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'applications',
      idArg: 'application_id',
      effect: 'update',
      live: (id) => `Would rotate the secret for application ${id}.`,
      blocked: (id) => `Application ${id} was not found in this zone.`,
    },
    outputs: ['application_id'],
  },
  updateApplication: {
    id: 'updateApplication',
    title: 'Rename an application',
    summary: 'Change the display name of an application registered in the zone.',
    domain: 'application',
    mutating: true,
    args: z.object({ application_id: IdRef, name: z.string().min(1).max(200) }).strict(),
    argsHint: 'application_id (string), name (string)',
    preview: {
      kind: 'mutateById',
      target: 'applications',
      idArg: 'application_id',
      effect: 'update',
      live: (id) => `Would rename application ${id}.`,
      blocked: (id) => `Application ${id} was not found in this zone.`,
    },
    outputs: ['application_id'],
  },
  deleteApplication: {
    id: 'deleteApplication',
    title: 'Delete an application',
    summary: 'Archive an application identity, removing it from active use in the zone; the record is retained for audit.',
    domain: 'application',
    mutating: true,
    args: z.object({ application_id: IdRef }).strict(),
    argsHint: 'application_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'applications',
      idArg: 'application_id',
      effect: 'delete',
      live: (id) => `Would delete application ${id} from this zone.`,
      blocked: (id) => `Application ${id} was not found in this zone.`,
    },
  },
  listProviders: {
    id: 'listProviders',
    title: 'List providers',
    summary: 'Read the upstream providers configured in the zone.',
    domain: 'provider',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  connectProvider: {
    id: 'connectProvider',
    title: 'Connect a provider',
    summary:
      'Add an upstream provider the zone can exchange credentials with. A credential-bearing kind collects its id, secret, key, or token through the console\u2019s secure prompt before approval - never through the chat.',
    domain: 'provider',
    mutating: true,
    args: z
      .object({
        name: z.string().min(1).max(200),
        kind: z.enum(['none', 'caracal_mandate', 'oauth2_authorization_code', 'oauth2_client_credentials', 'api_key', 'bearer_token']),
        config: z.record(z.string().max(64), z.unknown()).optional(),
      })
      .strict()
      .superRefine((args, ctx) => {
        const error = planProviderConfigError(args.kind, args.config)
        if (error) ctx.addIssue({ code: 'custom', message: error, path: ['config'] })
      }),
    argsHint:
      'name (string), kind (one of: none, caracal_mandate, oauth2_authorization_code, oauth2_client_credentials, api_key, bearer_token), config (object, optional: the kind\u2019s non-secret settings such as token_endpoint, authorization_endpoint, redirect_uri, scopes, header_name - never a client id, secret, key, or token)',
    preview: {
      kind: 'createByName',
      target: 'providers',
      exists: (name) => `A provider named \u201c${name}\u201d already exists.`,
      create: (name) => `Would connect provider \u201c${name}\u201d.`,
    },
    outputs: ['provider_id'],
  },
  updateProvider: {
    id: 'updateProvider',
    title: 'Update a provider',
    summary:
      'Change the display name or non-secret settings of an upstream provider. The provider\u2019s kind and its credentials never change here: credential rotation goes through the console\u2019s secure prompt.',
    domain: 'provider',
    mutating: true,
    args: z
      .object({
        provider_id: IdRef,
        name: z.string().min(1).max(200).optional(),
        config: z.record(z.string().max(64), z.unknown()).optional(),
      })
      .strict()
      .superRefine((args, ctx) => {
        if (args.name === undefined && args.config === undefined) {
          ctx.addIssue({ code: 'custom', message: 'update requires name or config' })
          return
        }
        for (const key of Object.keys(args.config ?? {})) {
          if (PROVIDER_CREDENTIAL_KEYS.has(key)) {
            ctx.addIssue({
              code: 'custom',
              message: `config must not carry ${key}: credentials are entered through the console's secure prompt`,
              path: ['config'],
            })
          }
        }
      }),
    argsHint:
      'provider_id (string), name (string, optional), config (object, optional: the kind\u2019s non-secret settings - never a client id, secret, key, or token, and never the kind itself)',
    preview: {
      kind: 'mutateById',
      target: 'providers',
      idArg: 'provider_id',
      effect: 'update',
      live: (id) => `Would update provider ${id}.`,
      blocked: (id) => `Provider ${id} was not found in this zone.`,
    },
    outputs: ['provider_id'],
  },
  deleteProvider: {
    id: 'deleteProvider',
    title: 'Delete a provider',
    summary: 'Archive an upstream provider, removing it from active use in the zone; the record is retained for audit.',
    domain: 'provider',
    mutating: true,
    args: z.object({ provider_id: IdRef }).strict(),
    argsHint: 'provider_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'providers',
      idArg: 'provider_id',
      effect: 'delete',
      live: (id) => `Would delete provider ${id} from this zone.`,
      blocked: (id) => `Provider ${id} was not found in this zone.`,
    },
  },
  defineResource: {
    id: 'defineResource',
    title: 'Define a resource',
    summary:
      'Describe a protected resource, the scopes it exposes, and its Gateway routing: the upstream URL and the provider whose credential the Gateway attaches.',
    domain: 'resource',
    mutating: true,
    args: z
      .object({
        name: z.string().min(1).max(200),
        scopes: z.array(Scope).min(1).max(64),
        upstream_url: z.string().min(1).max(2048).url(),
        credential_provider_id: IdRef,
      })
      .strict(),
    argsHint:
      'name (string), scopes (array of scope strings), upstream_url (string: the upstream API base URL the Gateway forwards to), credential_provider_id (string: the id of an existing provider whose credential the Gateway attaches)',
    preview: {
      kind: 'requireLiveThenCreate',
      requires: [{ target: 'providers', idArg: 'credential_provider_id', blocked: (id) => `Provider ${id} was not found in this zone.` }],
      create: (args) =>
        `Would define resource “${String(args.name)}” exposing ${(Array.isArray(args.scopes) ? (args.scopes as string[]) : []).join(', ')}, routed to ${String(args.upstream_url)}.`,
    },
    outputs: ['resource_id'],
  },
  listResources: {
    id: 'listResources',
    title: 'List resources',
    summary: 'Read the protected resources defined in the zone and the scopes they expose.',
    domain: 'resource',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  updateResource: {
    id: 'updateResource',
    title: 'Update a resource',
    summary:
      'Change a protected resource\u2019s name, scopes, or Gateway routing: the upstream URL, the credential provider, or its operation routes.',
    domain: 'resource',
    mutating: true,
    args: z
      .object({
        resource_id: IdRef,
        name: z.string().min(1).max(200).optional(),
        scopes: z.array(Scope).min(1).max(64).optional(),
        upstream_url: z.string().min(1).max(2048).url().optional(),
        credential_provider_id: IdRef.optional(),
        operations: z.array(ResourceOperationArg).max(64).optional(),
        operation_enforcement: z.enum(['enforced', 'transport_uniform']).optional(),
      })
      .strict()
      .superRefine((args, ctx) => {
        if (Object.keys(args).length <= 1)
          ctx.addIssue({ code: 'custom', message: 'update requires at least one field beyond resource_id' })
      }),
    argsHint:
      'resource_id (string), then at least one of: name (string), scopes (array of scope strings), upstream_url (string), credential_provider_id (string), operations (array of {method, path, scope}), operation_enforcement (enforced or transport_uniform)',
    preview: {
      kind: 'mutateById',
      target: 'resources',
      idArg: 'resource_id',
      effect: 'update',
      live: (id) => `Would update resource ${id}.`,
      blocked: (id) => `Resource ${id} was not found in this zone.`,
    },
    outputs: ['resource_id'],
  },
  deleteResource: {
    id: 'deleteResource',
    title: 'Delete a resource',
    summary: 'Archive a protected resource, removing it from active use in the zone; the record is retained for audit.',
    domain: 'resource',
    mutating: true,
    args: z.object({ resource_id: IdRef }).strict(),
    argsHint: 'resource_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'resources',
      idArg: 'resource_id',
      effect: 'delete',
      live: (id) => `Would delete resource ${id} from this zone.`,
      blocked: (id) => `Resource ${id} was not found in this zone.`,
    },
  },
  listGrants: {
    id: 'listGrants',
    title: 'List grants',
    summary: 'Read the delegated grants binding applications and users to resource scopes in the zone.',
    domain: 'grant',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  grantAccess: {
    id: 'grantAccess',
    title: 'Grant access',
    summary: 'Authorize an application and user to use specific scopes on a resource.',
    domain: 'grant',
    mutating: true,
    args: z
      .object({
        application_id: IdRef,
        user_id: IdRef,
        resource_id: IdRef,
        scopes: z.array(Scope).min(1).max(64),
      })
      .strict(),
    argsHint: 'application_id (string), user_id (string), resource_id (string), scopes (array of scope strings)',
    preview: {
      kind: 'requireLiveThenCreate',
      requires: [
        { target: 'applications', idArg: 'application_id', blocked: (id) => `Application ${id} was not found in this zone.` },
        { target: 'resources', idArg: 'resource_id', blocked: (id) => `Resource ${id} was not found in this zone.` },
      ],
      create: (args) =>
        `Would grant ${(Array.isArray(args.scopes) ? (args.scopes as string[]) : []).join(', ')} to application ${String(
          args.application_id,
        )} on resource ${String(args.resource_id)}.`,
    },
    outputs: ['grant_id'],
  },
  revokeGrant: {
    id: 'revokeGrant',
    title: 'Revoke a grant',
    summary: 'Revoke a delegated grant and the active sessions it authorized.',
    domain: 'grant',
    mutating: true,
    args: z.object({ grant_id: IdRef }).strict(),
    argsHint: 'grant_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'grants',
      idArg: 'grant_id',
      effect: 'delete',
      live: (id) => `Would revoke grant ${id} in this zone.`,
      blocked: (id) => `Grant ${id} was not found in this zone.`,
    },
  },
  explainRequest: {
    id: 'explainRequest',
    title: 'Explain a request',
    summary:
      'Read the full decision trace for one request id: every recorded event, the final decision, and which policies determined any denial. Changes nothing.',
    domain: 'audit',
    mutating: false,
    args: z.object({ request_id: IdRef }).strict(),
    argsHint: 'request_id (string)',
    preview: { kind: 'read' },
  },
  listPolicies: {
    id: 'listPolicies',
    title: 'List policies',
    summary: 'Read the policies defined in the zone by name and description. Returns no policy source.',
    domain: 'policy',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  validatePolicy: {
    id: 'validatePolicy',
    title: 'Validate a policy document',
    summary: 'Check an authored Rego data document against the control plane\u2019s validator without creating anything. Changes nothing.',
    domain: 'policy',
    mutating: false,
    args: z.object({ content: PolicyContent }).strict(),
    argsHint: 'content (Rego data document)',
    preview: { kind: 'read' },
  },
  listPolicySets: {
    id: 'listPolicySets',
    title: 'List policy sets',
    summary: 'Read the policy sets composed in the zone and their activation state.',
    domain: 'policy',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  deletePolicy: {
    id: 'deletePolicy',
    title: 'Delete a policy',
    summary: 'Archive a policy, removing it from active use in the zone; the record is retained for audit.',
    domain: 'policy',
    mutating: true,
    args: z.object({ policy_id: IdRef }).strict(),
    argsHint: 'policy_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'policies',
      idArg: 'policy_id',
      effect: 'delete',
      live: (id) => `Would delete policy ${id} from this zone.`,
      blocked: (id) => `Policy ${id} was not found in this zone.`,
    },
  },
  createPolicy: {
    id: 'createPolicy',
    title: 'Create a policy',
    summary: 'Create a policy from an authored data document, sealing its first immutable version.',
    domain: 'policy',
    mutating: true,
    args: z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(500).optional(),
        content: PolicyContent,
      })
      .strict(),
    argsHint: 'name (string), description (string, optional), content (Rego data document)',
    preview: {
      kind: 'createByName',
      target: 'policies',
      exists: (name) => `A policy named “${name}” already exists.`,
      create: (name) => `Would create policy “${name}” and seal its first version.`,
    },
    outputs: ['policy_id', 'policy_version_id'],
  },
  versionPolicy: {
    id: 'versionPolicy',
    title: 'Version a policy',
    summary: 'Seal a new immutable version of an existing policy from an authored data document.',
    domain: 'policy',
    mutating: true,
    args: z.object({ policy_id: IdRef, content: PolicyContent }).strict(),
    argsHint: 'policy_id (string), content (Rego data document)',
    preview: {
      kind: 'mutateById',
      target: 'policies',
      idArg: 'policy_id',
      effect: 'update',
      live: (id) => `Would seal a new version of policy ${id}.`,
      blocked: (id) => `Policy ${id} was not found in this zone.`,
    },
    outputs: ['policy_id', 'policy_version_id'],
  },
  createPolicySet: {
    id: 'createPolicySet',
    title: 'Create a policy set',
    summary: 'Create a policy set that composes policy versions for activation in the zone.',
    domain: 'policy',
    mutating: true,
    args: z.object({ name: z.string().min(1).max(200), description: z.string().max(500).optional() }).strict(),
    argsHint: 'name (string), description (string, optional)',
    preview: {
      kind: 'createByName',
      target: 'policySets',
      exists: (name) => `A policy set named “${name}” already exists.`,
      create: (name) => `Would create policy set “${name}”.`,
    },
    outputs: ['policy_set_id'],
  },
  versionPolicySet: {
    id: 'versionPolicySet',
    title: 'Version a policy set',
    summary: 'Seal a new immutable version of a policy set from the policy versions it composes.',
    domain: 'policy',
    mutating: true,
    args: z.object({ policy_set_id: IdRef, policy_version_ids: z.array(IdRef).min(1).max(64) }).strict(),
    argsHint: 'policy_set_id (string), policy_version_ids (array of policy version id strings)',
    preview: {
      kind: 'mutateById',
      target: 'policySets',
      idArg: 'policy_set_id',
      effect: 'update',
      live: (id) => `Would seal a new version of policy set ${id}.`,
      blocked: (id) => `Policy set ${id} was not found in this zone.`,
    },
    outputs: ['policy_set_id', 'policy_set_version_id'],
  },
  activatePolicySet: {
    id: 'activatePolicySet',
    title: 'Activate a policy set',
    summary: 'Activate a policy set version so the zone evaluates authorization against it.',
    domain: 'policy',
    mutating: true,
    args: z.object({ policy_set_id: IdRef, policy_set_version_id: IdRef }).strict(),
    argsHint: 'policy_set_id (string), policy_set_version_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'policySets',
      idArg: 'policy_set_id',
      effect: 'update',
      live: (id) => `Would activate a version of policy set ${id} for the whole zone.`,
      blocked: (id) => `Policy set ${id} was not found in this zone.`,
    },
    outputs: ['policy_set_id', 'policy_set_version_id'],
  },
  simulatePolicySet: {
    id: 'simulatePolicySet',
    title: 'Simulate a policy set version',
    summary: 'Evaluate a policy set version against a hypothetical authorization input without activating it. Changes nothing.',
    domain: 'policy',
    mutating: false,
    args: z
      .object({
        policy_set_id: IdRef,
        policy_set_version_id: IdRef,
        input: z.record(z.string().max(128), z.unknown()).optional(),
      })
      .strict(),
    argsHint: 'policy_set_id (string), policy_set_version_id (string), input (object, optional: the authorization input to evaluate)',
    preview: { kind: 'read' },
  },
  deletePolicySet: {
    id: 'deletePolicySet',
    title: 'Delete a policy set',
    summary: 'Archive a policy set, removing it from active use in the zone; the record is retained for audit.',
    domain: 'policy',
    mutating: true,
    args: z.object({ policy_set_id: IdRef }).strict(),
    argsHint: 'policy_set_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'policySets',
      idArg: 'policy_set_id',
      effect: 'delete',
      live: (id) => `Would delete policy set ${id} from this zone.`,
      blocked: (id) => `Policy set ${id} was not found in this zone.`,
    },
  },
  // Runtime authority is governed here like everything else: suspending, resuming, or
  // terminating an agent session and revoking a delegation edge ride the same catalog,
  // preview, approval gate, and governed control-plane apply as zone-topology changes.
  // The one deliberate exception is deciding a step-up approval: the control plane's
  // credential carries write capability and never approve, so an agent structurally
  // cannot decide a challenge that exists to put a human in the loop. The Operator
  // reads approvals so it can reason about them, and stops there.
  listSessions: {
    id: 'listSessions',
    title: 'List sessions',
    summary: 'Read the authenticated sessions active in the zone with their subjects and expiry, optionally filtered by subject or status.',
    domain: 'session',
    mutating: false,
    args: z
      .object({
        subject: z.string().min(1).max(200).optional(),
        status: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    argsHint: 'subject (string, optional), status (string, optional), limit (number, optional)',
    preview: { kind: 'read' },
  },
  listAgents: {
    id: 'listAgents',
    title: 'List agent sessions',
    summary: 'Read the agent sessions running in the zone with their lifecycle and status.',
    domain: 'agent',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  suspendAgent: {
    id: 'suspendAgent',
    title: 'Suspend an agent session',
    summary: 'Pause a running agent session so it stops acting until resumed; its delegated authority is retained.',
    domain: 'agent',
    mutating: true,
    args: z.object({ agent_session_id: IdRef }).strict(),
    argsHint: 'agent_session_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'agentSessions',
      idArg: 'agent_session_id',
      effect: 'update',
      live: (id) => `Would suspend agent session ${id}.`,
      blocked: (id) => `Agent session ${id} is not live in this zone.`,
    },
    outputs: ['agent_session_id'],
  },
  resumeAgent: {
    id: 'resumeAgent',
    title: 'Resume an agent session',
    summary: 'Resume a suspended agent session so it can act again under its existing authority.',
    domain: 'agent',
    mutating: true,
    args: z.object({ agent_session_id: IdRef }).strict(),
    argsHint: 'agent_session_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'agentSessions',
      idArg: 'agent_session_id',
      effect: 'update',
      live: (id) => `Would resume agent session ${id}.`,
      blocked: (id) => `Agent session ${id} is not live in this zone.`,
    },
    outputs: ['agent_session_id'],
  },
  terminateAgent: {
    id: 'terminateAgent',
    title: 'Terminate an agent session',
    summary: 'Permanently end an agent session and its descendants, revoking the authority delegated to them.',
    domain: 'agent',
    mutating: true,
    args: z.object({ agent_session_id: IdRef }).strict(),
    argsHint: 'agent_session_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'agentSessions',
      idArg: 'agent_session_id',
      effect: 'delete',
      live: (id) => `Would terminate agent session ${id} and its descendants.`,
      blocked: (id) => `Agent session ${id} is not live in this zone.`,
    },
  },
  listDelegations: {
    id: 'listDelegations',
    title: 'List delegations',
    summary: 'Read the active delegation edges in the zone: who delegated which scopes to whom.',
    domain: 'delegation',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  revokeDelegation: {
    id: 'revokeDelegation',
    title: 'Revoke a delegation',
    summary: 'Revoke a delegation edge, withdrawing the scopes it conferred from the receiving agent and its descendants.',
    domain: 'delegation',
    mutating: true,
    args: z.object({ delegation_id: IdRef }).strict(),
    argsHint: 'delegation_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'delegations',
      idArg: 'delegation_id',
      effect: 'delete',
      live: (id) => `Would revoke delegation ${id}.`,
      blocked: (id) => `Delegation ${id} is not active in this zone.`,
    },
  },
  listAuditEvents: {
    id: 'listAuditEvents',
    title: 'List audit events',
    summary:
      'Read the most recent authorization decisions and control events recorded in the zone, optionally filtered by time window, decision, event type, or request id.',
    domain: 'audit',
    mutating: false,
    args: z
      .object({
        since: z.string().min(1).max(64).optional(),
        until: z.string().min(1).max(64).optional(),
        decision: z.string().min(1).max(32).optional(),
        event_type: z.string().min(1).max(128).optional(),
        request_id: IdRef.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    argsHint:
      'since (ISO timestamp, optional), until (ISO timestamp, optional), decision (string, optional), event_type (string, optional), request_id (string, optional), limit (number, optional)',
    preview: { kind: 'read' },
  },
  listAdminActivity: {
    id: 'listAdminActivity',
    title: 'List admin activity',
    summary: 'Read the most recent admin actions recorded in the zone: who changed what, when, and through which surface.',
    domain: 'audit',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  listWorkloads: {
    id: 'listWorkloads',
    title: 'List workloads',
    summary: 'Read the workload launcher identities defined in the zone and their credential bindings.',
    domain: 'workload',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
  createWorkload: {
    id: 'createWorkload',
    title: 'Create a workload',
    summary:
      'Create a workload launcher identity for caracal run. The one-time workload secret is issued at apply and never retrievable again.',
    domain: 'workload',
    mutating: true,
    args: z.object({ name: z.string().min(1).max(200) }).strict(),
    argsHint: 'name (string)',
    preview: {
      kind: 'createByName',
      target: 'workloads',
      exists: (name) => `A workload named \u201c${name}\u201d already exists.`,
      create: (name) => `Would create workload \u201c${name}\u201d and issue its one-time secret.`,
    },
    outputs: ['workload_id'],
  },
  updateWorkload: {
    id: 'updateWorkload',
    title: 'Update a workload',
    summary:
      'Change a workload\u2019s name or replace its credential bindings: which environment variables carry which governed resource credentials.',
    domain: 'workload',
    mutating: true,
    args: z
      .object({
        workload_id: IdRef,
        name: z.string().min(1).max(200).optional(),
        bindings: z.array(WorkloadBindingArg).max(64).optional(),
      })
      .strict()
      .superRefine((args, ctx) => {
        if (args.name === undefined && args.bindings === undefined)
          ctx.addIssue({ code: 'custom', message: 'update requires name or bindings' })
      }),
    argsHint:
      'workload_id (string), then at least one of: name (string), bindings (array of {env, resource, scopes (optional), optional (boolean, optional), on_failure (warn or error, optional)})',
    preview: {
      kind: 'mutateById',
      target: 'workloads',
      idArg: 'workload_id',
      effect: 'update',
      live: (id) => `Would update workload ${id}.`,
      blocked: (id) => `Workload ${id} was not found in this zone.`,
    },
    outputs: ['workload_id'],
  },
  rotateWorkloadSecret: {
    id: 'rotateWorkloadSecret',
    title: 'Rotate a workload secret',
    summary: 'Issue a fresh one-time secret for a workload and retire the old one.',
    domain: 'workload',
    mutating: true,
    args: z.object({ workload_id: IdRef }).strict(),
    argsHint: 'workload_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'workloads',
      idArg: 'workload_id',
      effect: 'update',
      live: (id) => `Would rotate the secret for workload ${id}.`,
      blocked: (id) => `Workload ${id} was not found in this zone.`,
    },
    outputs: ['workload_id'],
  },
  deleteWorkload: {
    id: 'deleteWorkload',
    title: 'Delete a workload',
    summary: 'Permanently delete a workload launcher identity and its credential bindings; its secret stops working immediately.',
    domain: 'workload',
    mutating: true,
    args: z.object({ workload_id: IdRef }).strict(),
    argsHint: 'workload_id (string)',
    preview: {
      kind: 'mutateById',
      target: 'workloads',
      idArg: 'workload_id',
      effect: 'delete',
      live: (id) => `Would delete workload ${id} from this zone.`,
      blocked: (id) => `Workload ${id} was not found in this zone.`,
    },
  },
  listApprovals: {
    id: 'listApprovals',
    title: 'List approvals',
    summary:
      'Read the step-up approval requests recorded in the zone and their state. Deciding an approval stays with humans: the Operator can never approve or reject.',
    domain: 'approval',
    mutating: false,
    args: NoArgs,
    argsHint: 'no arguments',
    preview: { kind: 'read' },
  },
}

// Renders the catalog as a compact, deterministic block for grounding the planner
// agent: one line per capability with its id, effect, argument shape, referencable
// outputs, and purpose.
export function describeCapabilitiesForPrompt(): string {
  return Object.values(CAPABILITIES)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const outputs = c.outputs && c.outputs.length > 0 ? ` outputs: ${c.outputs.join(', ')}` : ''
      return `- ${c.id} [${c.mutating ? 'changes state' : 'read-only'}] args: ${c.argsHint}${outputs} - ${c.summary}`
    })
    .join('\n')
}

export interface CapabilityDescriptor {
  id: string
  title: string
  summary: string
  domain: CapabilityDomain
  mutating: boolean
}

export function listCapabilities(): CapabilityDescriptor[] {
  return Object.values(CAPABILITIES)
    .map(({ id, title, summary, domain, mutating }) => ({ id, title, summary, domain, mutating }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

const PROPOSED_STEP_MAX = 50
const STEP_ID_PATTERN = /^[A-Za-z0-9_.\-:]{1,128}$/

// A step-output reference: a whole-string argument value of the form
// {{steps.<stepId>.outputs.<key>}} that binds a later step's argument to an identifier an
// earlier step produces at apply time. Whole-string only - a reference never embeds inside
// a longer string - so resolution is a typed value substitution, never text interpolation.
const STEP_REFERENCE_PATTERN = /^\{\{steps\.([A-Za-z0-9_.\-:]{1,128})\.outputs\.([a-z0-9_]{1,64})\}\}$/

export interface StepReference {
  stepId: string
  output: string
}

export function parseStepReference(value: unknown): StepReference | null {
  if (typeof value !== 'string') return null
  const match = STEP_REFERENCE_PATTERN.exec(value)
  return match ? { stepId: match[1], output: match[2] } : null
}

// Collects every step-output reference in a step's arguments, walking nested arrays and
// records so a reference is found wherever the argument schema allows a string.
export function collectStepReferences(args: Record<string, unknown>): StepReference[] {
  const refs: StepReference[] = []
  const walk = (value: unknown): void => {
    const ref = parseStepReference(value)
    if (ref) {
      refs.push(ref)
      return
    }
    if (Array.isArray(value)) for (const item of value) walk(item)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item)
  }
  for (const value of Object.values(args)) walk(value)
  return refs
}

// The per-step risk a planner may declare, ordered low→high. It is the planner's own honest
// assessment of how consequential a step is; the guardian and the human approver still decide.
export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type StepRisk = (typeof RISK_LEVELS)[number]

const ProposedStep = z
  .object({
    id: z.string().regex(STEP_ID_PATTERN),
    capability: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()).default({}),
    depends_on: z.array(z.string().regex(STEP_ID_PATTERN)).max(PROPOSED_STEP_MAX).optional(),
    risk: z.enum(RISK_LEVELS).optional(),
  })
  .strict()

export const ProposedPlan = z
  .object({
    summary: z.string().min(1).max(2000),
    steps: z.array(ProposedStep).min(1).max(PROPOSED_STEP_MAX),
  })
  .strict()

export type ProposedPlanInput = z.infer<typeof ProposedPlan>

export type DiagnosticCode =
  'unknown_capability' | 'invalid_args' | 'duplicate_step_id' | 'unknown_dependency' | 'unknown_reference' | 'dependency_cycle'

export interface PlanDiagnostic {
  step_id: string
  code: DiagnosticCode
  message: string
}

export interface ValidatedStep {
  id: string
  capability: string
  title: string
  domain: CapabilityDomain
  mutating: boolean
  args: Record<string, unknown>
  depends_on: string[]
  risk?: StepRisk
}

export interface PlanValidation {
  ok: boolean
  mutating: boolean
  mutating_step_count: number
  steps: ValidatedStep[]
  diagnostics: PlanDiagnostic[]
}

// Validates a proposed plan against the catalog. Pure and side-effect free: it
// resolves each step's capability, checks its arguments, resolves every step-output
// reference against the producing step's declared outputs, and stamps the
// authoritative mutating classification from the catalog so a downstream
// approval can never be granted against a mislabeled or unknown action. A
// reference implies a dependency, so referenced steps fold into depends_on and
// ride the same cycle check as declared dependencies.
export function validateProposedPlan(plan: ProposedPlanInput): PlanValidation {
  const diagnostics: PlanDiagnostic[] = []
  const steps: ValidatedStep[] = []
  const seen = new Set<string>()

  for (const step of plan.steps) {
    if (seen.has(step.id)) {
      diagnostics.push({
        step_id: step.id,
        code: 'duplicate_step_id',
        message: `duplicate step id '${step.id}'`,
      })
      continue
    }
    seen.add(step.id)

    const capability = CAPABILITIES[step.capability]
    if (!capability) {
      diagnostics.push({
        step_id: step.id,
        code: 'unknown_capability',
        message: `unknown capability '${step.capability}'`,
      })
      continue
    }

    const args = capability.args.safeParse(step.args)
    if (!args.success) {
      diagnostics.push({
        step_id: step.id,
        code: 'invalid_args',
        message: `arguments for '${capability.id}' failed validation`,
      })
      continue
    }

    const references = collectStepReferences(args.data)
    const referencedSteps: string[] = []
    for (const ref of references) {
      const producer = plan.steps.find((candidate) => candidate.id === ref.stepId)
      if (!producer) {
        diagnostics.push({
          step_id: step.id,
          code: 'unknown_reference',
          message: `step '${step.id}' references unknown step '${ref.stepId}'`,
        })
        continue
      }
      const outputs = CAPABILITIES[producer.capability]?.outputs ?? []
      if (!outputs.includes(ref.output)) {
        diagnostics.push({
          step_id: step.id,
          code: 'unknown_reference',
          message: `step '${step.id}' references output '${ref.output}' that step '${ref.stepId}' does not produce`,
        })
        continue
      }
      referencedSteps.push(ref.stepId)
    }

    steps.push({
      id: step.id,
      capability: capability.id,
      title: capability.title,
      domain: capability.domain,
      mutating: capability.mutating,
      args: args.data,
      depends_on: [...new Set([...(step.depends_on ?? []), ...referencedSteps])],
      risk: step.risk,
    })
  }

  validateDependencies(plan, steps, diagnostics)

  const mutatingCount = steps.filter((s) => s.mutating).length
  return {
    ok: diagnostics.length === 0,
    mutating: mutatingCount > 0,
    mutating_step_count: mutatingCount,
    steps,
    diagnostics,
  }
}

// Checks the step dependency graph: every declared dependency must reference a step in the plan,
// and the graph must be acyclic so a sequenced apply can satisfy each step's prerequisites. A
// dependency on an absent step is reported as unknown_dependency; a cycle (including a step that
// depends on itself) is reported as dependency_cycle naming a step on the cycle.
function validateDependencies(plan: ProposedPlanInput, steps: ValidatedStep[], diagnostics: PlanDiagnostic[]): void {
  const declaredIds = new Set(plan.steps.map((step) => step.id))
  const resolvedIds = new Set(steps.map((step) => step.id))
  const adjacency = new Map<string, string[]>()

  for (const step of steps) {
    const edges: string[] = []
    for (const dep of step.depends_on) {
      if (!declaredIds.has(dep)) {
        diagnostics.push({
          step_id: step.id,
          code: 'unknown_dependency',
          message: `step '${step.id}' depends on unknown step '${dep}'`,
        })
        continue
      }
      if (resolvedIds.has(dep)) edges.push(dep)
    }
    adjacency.set(step.id, edges)
  }

  const state = new Map<string, 'visiting' | 'done'>()
  let cycleNode: string | null = null
  const visit = (id: string): boolean => {
    state.set(id, 'visiting')
    for (const next of adjacency.get(id) ?? []) {
      const seen = state.get(next)
      if (seen === 'visiting') {
        cycleNode = id
        return true
      }
      if (!seen && visit(next)) return true
    }
    state.set(id, 'done')
    return false
  }

  for (const step of steps) {
    if (!state.has(step.id) && visit(step.id)) break
  }
  if (cycleNode) {
    diagnostics.push({
      step_id: cycleNode,
      code: 'dependency_cycle',
      message: `dependency cycle involving step '${cycleNode}'`,
    })
  }
}
