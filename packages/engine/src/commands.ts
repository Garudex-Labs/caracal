// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Canonical command catalog shared by the Caracal runtime CLI and Control automation surfaces.

export type CommandGroup = 'stack' | 'runtime' | 'admin' | 'observability' | 'multiagent'

export interface FlagDescriptor {
  readonly name: string
  readonly summary: string
}

export type ScopeVerb = 'read' | 'write' | 'delete'

export interface CommandDescriptor {
  readonly name: string
  readonly group: CommandGroup
  readonly summary: string
  readonly subcommands?: readonly string[]
  readonly requiresConfig?: boolean
  readonly requiresArgs?: boolean
  readonly requiresZone?: boolean
  readonly hidden?: boolean
  /**
   * Command performs its own per-object scope checks instead of carrying a single static scope.
   * The declarative surface (state, ensure) asserts each touched noun's scope at runtime, so a
   * key already holding control:resource:write can apply resources without a separate state scope.
   */
  readonly delegatesScope?: boolean
  /** Flags keyed by subcommand name; use '' for commands with no subcommands. */
  readonly flags?: { readonly [k: string]: readonly FlagDescriptor[] | undefined }
  /** Required scope verb per subcommand. Used by the Control API to gate per-resource access. */
  readonly scopes?: { readonly [k: string]: ScopeVerb | undefined }
}

const READ_VERBS = new Set(['list', 'get', 'tree', 'tail', 'active', 'inbound', 'outbound', 'traverse', 'validate', 'simulate'])

const DELETE_VERBS = new Set(['delete', 'terminate', 'revoke'])

/** Derive a default scope verb for a subcommand using verb conventions. Explicit `scopes` map wins. */
export function scopeFor(desc: CommandDescriptor, sub: string): ScopeVerb {
  const explicit = desc.scopes?.[sub]
  if (explicit) return explicit
  if (READ_VERBS.has(sub)) return 'read'
  if (DELETE_VERBS.has(sub)) return 'delete'
  return 'write'
}

/** Format the full scope string a token must carry for the (command, subcommand) pair. */
export function scopeName(desc: CommandDescriptor, sub: string): string {
  return `control:${desc.name}:${scopeFor(desc, sub)}`
}

export const SHELL_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  { name: 'up', group: 'stack', summary: 'Build and start the Caracal platform' },
  { name: 'down', group: 'stack', summary: 'Stop the platform (-v removes volumes)' },
  {
    name: 'status',
    group: 'stack',
    summary: 'Show platform health',
    flags: {
      '': [
        { name: '--ready', summary: 'Probe dependency readiness instead of liveness' },
        { name: '--json', summary: 'Emit machine-readable result' },
      ],
    },
  },
  {
    name: 'purge',
    group: 'stack',
    summary: 'Remove platform state',
    subcommands: ['stack', 'volumes', 'logs', 'config', 'runtime', 'secrets', 'cache', 'all'],
  },
  {
    name: 'upgrade',
    group: 'stack',
    summary: 'Upgrade the platform in place',
    flags: {
      '': [{ name: '--no-pull', summary: 'Reuse local images instead of pulling the pinned release' }],
    },
  },
  {
    name: 'allowlist',
    group: 'stack',
    summary: 'Manage Console sign-in access',
    subcommands: ['add', 'remove', 'lock', 'unlock', 'list'],
    requiresArgs: true,
  },
  {
    name: 'run',
    group: 'runtime',
    summary: 'Execute a workload with scoped runtime credentials',
    requiresConfig: true,
    requiresArgs: true,
  },
  {
    name: 'web',
    group: 'runtime',
    summary: 'Open the Caracal Console',
    flags: {
      '': [
        { name: '--web-port', summary: 'Port for the web UI (default 3001)' },
        { name: '--auth-port', summary: 'Port for the backend-for-frontend (default 3002)' },
        { name: '--build', summary: 'Serve the production build instead of the dev server' },
      ],
    },
  },
])

export const MANAGEMENT_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  {
    name: 'app',
    group: 'admin',
    summary: 'Manage applications',
    requiresZone: true,
    subcommands: ['list', 'get', 'create', 'patch', 'rotate-secret', 'delete', 'dcr'],
    flags: {
      create: [{ name: '--name', summary: 'Application name' }],
      patch: [{ name: '--name', summary: 'Application name' }],
      'rotate-secret': [{ name: '--id', summary: 'Application ID' }],
      dcr: [
        { name: '--name', summary: 'Application name' },
        { name: '--expires-in', summary: 'Client lifetime seconds (1-3600)' },
      ],
    },
  },

  {
    name: 'resource',
    group: 'admin',
    summary: 'Manage protected resources',
    subcommands: ['list', 'get', 'create', 'patch', 'delete'],
    requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Resource name' },
        { name: '--identifier', summary: 'Resource identifier; generated from name when omitted' },
        { name: '--scopes', summary: 'Comma-separated resource scopes' },
        { name: '--upstream-url', summary: 'Upstream URL' },
        { name: '--credential-provider-id', summary: 'Upstream credential provider ID' },
        { name: '--operations', summary: 'JSON array of {method, path, scope} operations the Gateway authorizes' },
        { name: '--operation-enforcement', summary: 'enforced (deny undeclared operations) or transport_uniform' },
      ],
      patch: [
        { name: '--identifier', summary: 'Resource identifier' },
        { name: '--name', summary: 'Resource name' },
        { name: '--scopes', summary: 'Comma-separated resource scopes' },
        { name: '--upstream-url', summary: 'Upstream URL' },
        { name: '--credential-provider-id', summary: 'Upstream credential provider ID' },
        { name: '--operations', summary: 'JSON array of {method, path, scope} operations the Gateway authorizes' },
        { name: '--operation-enforcement', summary: 'enforced (deny undeclared operations) or transport_uniform' },
      ],
    },
  },

  {
    name: 'identity-provider',
    group: 'admin',
    summary: 'Manage identity providers',
    subcommands: ['list', 'get', 'create', 'patch', 'delete'],
    requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Provider name' },
        { name: '--identifier', summary: 'Provider identifier' },
        {
          name: '--kind',
          summary:
            'Provider kind (none, caracal_mandate, oauth2_authorization_code, oauth2_client_credentials, api_key, bearer_token, http_basic)',
        },
        { name: '--config', summary: 'Inline config JSON' },
      ],
      patch: [
        { name: '--identifier', summary: 'Provider identifier' },
        { name: '--name', summary: 'Provider name' },
        {
          name: '--kind',
          summary:
            'Provider kind (none, caracal_mandate, oauth2_authorization_code, oauth2_client_credentials, api_key, bearer_token, http_basic)',
        },
        { name: '--config', summary: 'Inline config JSON' },
      ],
    },
  },

  {
    name: 'policy',
    group: 'admin',
    summary: 'Manage policies',
    subcommands: ['list', 'get', 'create', 'validate', 'version', 'delete'],
    requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Policy name' },
        { name: '--description', summary: 'Policy description' },
        { name: '--content', summary: 'Inline policy content' },
        { name: '--file', summary: 'Read content from file' },
      ],
      validate: [
        { name: '--file', summary: 'Read Rego from file' },
        { name: '--content', summary: 'Inline Rego content' },
      ],
      version: [
        { name: '--content', summary: 'Inline policy content' },
        { name: '--file', summary: 'Read content from file' },
      ],
    },
  },

  {
    name: 'policy-set',
    group: 'admin',
    summary: 'Manage policy sets',
    subcommands: ['list', 'get', 'create', 'version', 'activate', 'simulate', 'delete'],
    requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Policy set name' },
        { name: '--description', summary: 'Description' },
      ],
      version: [{ name: '--policy-versions', summary: 'Comma-separated policy version IDs' }],
      activate: [{ name: '--version', summary: 'Policy set version ID' }],
      simulate: [
        { name: '--version', summary: 'Policy set version ID' },
        { name: '--input', summary: 'Inline OPA input fixture JSON' },
        { name: '--input-file', summary: 'OPA input fixture file' },
      ],
    },
  },

  {
    name: 'state',
    group: 'admin',
    summary: 'Reconcile a zone toward a declarative desired-state document',
    subcommands: ['apply', 'plan', 'verify'],
    requiresZone: true,
    delegatesScope: true,
    flags: {
      apply: [
        { name: '--document', summary: 'Desired-state JSON: { objects: [{ kind, spec }], prune? }' },
        { name: '--prune', summary: 'Delete managed objects of declared kinds absent from the document' },
        { name: '--dry-run', summary: 'Compute the plan without writing' },
        { name: '--idempotency-key', summary: 'Caller correlation key recorded in the audit trail' },
      ],
      plan: [
        { name: '--document', summary: 'Desired-state JSON to diff against the live zone' },
        { name: '--prune', summary: 'Include prune actions in the plan' },
      ],
      verify: [
        { name: '--document', summary: 'Desired-state JSON to compare against the live zone' },
        { name: '--prune', summary: 'Treat managed objects absent from the document as drift' },
      ],
    },
  },

  {
    name: 'ensure',
    group: 'admin',
    summary: 'Idempotently create-or-patch one object to match a spec',
    subcommands: ['application', 'identity-provider', 'resource', 'policy', 'policy-set'],
    requiresZone: true,
    delegatesScope: true,
    flags: Object.fromEntries(
      ['application', 'identity-provider', 'resource', 'policy', 'policy-set'].map((kind) => [
        kind,
        [
          { name: '--spec', summary: 'Object spec JSON keyed by its stable identity field' },
          { name: '--dry-run', summary: 'Compute the plan without writing' },
          { name: '--idempotency-key', summary: 'Caller correlation key recorded in the audit trail' },
        ],
      ]),
    ),
  },

  {
    name: 'catalog',
    group: 'admin',
    summary: 'Describe the Control surface: commands, scopes, flags, and declarative kinds',
    subcommands: ['describe'],
    requiresZone: true,
    delegatesScope: true,
  },

  {
    name: 'session',
    group: 'admin',
    summary: 'List authority sessions',
    subcommands: ['list'],
    requiresZone: true,
    flags: {
      list: [
        { name: '--subject', summary: 'Filter by subject ID' },
        { name: '--status', summary: 'Filter by status' },
        { name: '--limit', summary: 'Maximum rows to return' },
      ],
    },
  },

  {
    name: 'audit',
    group: 'observability',
    summary: 'Search audit events',
    subcommands: ['tail'],
    requiresZone: true,
    flags: {
      tail: [
        { name: '--since', summary: 'Start of time window' },
        { name: '--until', summary: 'End of time window' },
        { name: '--decision', summary: 'Filter by decision' },
        { name: '--event-type', summary: 'Filter by event type' },
        { name: '--request-id', summary: 'Filter by request ID' },
        { name: '--limit', summary: 'Maximum rows to return' },
      ],
    },
  },

  {
    name: 'explain',
    group: 'observability',
    summary: 'Explain one audit request',
    requiresZone: true,
    flags: {
      '': [
        { name: '--request-id', summary: 'Request ID from an audit event' },
        { name: '--format', summary: 'Output format: text or mermaid' },
        { name: '--flow', summary: 'Render the authority path as Mermaid' },
      ],
    },
    scopes: { '': 'read' },
  },

  {
    name: 'agent',
    group: 'multiagent',
    summary: 'Manage agent sessions',
    subcommands: ['list', 'get', 'tree', 'suspend', 'resume', 'terminate'],
    requiresZone: true,
  },
  {
    name: 'delegation',
    group: 'multiagent',
    summary: 'Manage delegation edges',
    subcommands: ['active', 'inbound', 'outbound', 'traverse', 'revoke'],
    requiresZone: true,
  },

  {
    name: 'grant',
    group: 'admin',
    summary: 'Manage delegated grants binding an application and user to resource scopes',
    subcommands: ['list', 'get', 'create', 'revoke'],
    requiresZone: true,
  },
])

export function findCommand(table: readonly CommandDescriptor[], name: string): CommandDescriptor | undefined {
  return table.find((c) => c.name === name)
}

export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
