// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Canonical command catalog shared by Caracal runtime, console management, and Control automation surfaces.

export type CommandGroup =
  | 'stack'
  | 'runtime'
  | 'admin'
  | 'observability'
  | 'multiagent';

export interface FlagDescriptor {
  readonly name: string;
  readonly summary: string;
}

export type ScopeVerb = 'read' | 'write' | 'delete';

export interface CommandDescriptor {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly subcommands?: readonly string[];
  readonly requiresConfig?: boolean;
  readonly requiresArgs?: boolean;
  readonly requiresZone?: boolean;
  readonly hidden?: boolean;
  readonly localOnly?: boolean;
  /** Flags keyed by subcommand name; use '' for commands with no subcommands. */
  readonly flags?: { readonly [k: string]: readonly FlagDescriptor[] | undefined };
  /** Required scope verb per subcommand. Used by the Control API to gate per-resource access. */
  readonly scopes?: { readonly [k: string]: ScopeVerb | undefined };
}

const READ_VERBS = new Set([
  'list', 'get', 'tree', 'tail', 'active', 'inbound', 'outbound', 'traverse', 'read', 'inspect', 'use', 'validate', 'simulate',
]);

const DELETE_VERBS = new Set(['delete', 'terminate', 'revoke', 'purge']);

/** Derive a default scope verb for a subcommand using verb conventions. Explicit `scopes` map wins. */
export function scopeFor(desc: CommandDescriptor, sub: string): ScopeVerb {
  const explicit = desc.scopes?.[sub];
  if (explicit) return explicit;
  if (READ_VERBS.has(sub)) return 'read';
  if (DELETE_VERBS.has(sub)) return 'delete';
  return 'write';
}

/** Format the full scope string a token must carry for the (command, subcommand) pair. */
export function scopeName(desc: CommandDescriptor, sub: string): string {
  return `control:${desc.name}:${scopeFor(desc, sub)}`;
}

export const SHELL_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  { name: 'up', group: 'stack', summary: 'Build and start the local stack' },
  { name: 'down', group: 'stack', summary: 'Stop the stack; use -v to remove volumes' },
  {
    name: 'status',
    group: 'stack',
    summary: 'Check service health',
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
    summary: 'Clean stack artifacts and local state',
    subcommands: ['stack', 'volumes', 'logs', 'config', 'runtime', 'secrets', 'cache', 'all'],
  },
  { name: 'run', group: 'runtime', summary: 'Run a command with just-in-time injected credentials', requiresConfig: true, requiresArgs: true },
  { name: 'console', group: 'runtime', summary: 'Launch the Caracal Console' },
]);

export const MANAGEMENT_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  {
    name: 'doctor',
    group: 'admin',
    summary: 'Run operator diagnostics for the local control plane',
    flags: {
      '': [
        { name: '--preflight', summary: 'Run local deployment preflight checks only' },
        { name: '--ready', summary: 'Treat warnings as not ready for automation gates' },
        { name: '--zone', summary: 'Inspect one zone instead of every visible zone' },
        { name: '--json', summary: 'Emit structured machine-readable diagnostics' },
      ],
    },
  },
  {
    name: 'manifest',
    group: 'admin',
    summary: 'Validate interoperability extension manifests',
    subcommands: ['validate'],
    hidden: true,
    flags: {
      validate: [
        { name: '--file', summary: 'Manifest JSON file' },
        { name: '--kind', summary: 'Manifest kind override' },
        { name: '--json', summary: 'Emit machine-readable result' },
      ],
    },
    scopes: { validate: 'read' },
  },
  {
    name: 'zone', group: 'admin', summary: 'Manage zones',
    subcommands: ['use', 'list', 'get', 'create', 'patch', 'delete'],
    flags: {
      create: [
        { name: '--name', summary: 'Zone display name (required)' },
        { name: '--slug', summary: 'URL-safe slug' },
        { name: '--dcr', summary: 'Enable dynamic client registration' },
      ],
      patch: [
        { name: '--name', summary: 'Zone display name' },
        { name: '--slug', summary: 'URL-safe slug' },
        { name: '--dcr', summary: 'Enable/disable DCR (=true|false)' },
        { name: '--dcr-shutdown', summary: 'When disabling DCR with live apps: keep_live or revoke_live' },
      ],
    },
  },

  {
    name: 'app', group: 'admin', summary: 'Manage applications', requiresZone: true,
    subcommands: ['list', 'get', 'create', 'patch', 'delete', 'dcr'],
    flags: {
      create: [
        { name: '--name', summary: 'Application name' },
      ],
      patch: [
        { name: '--name', summary: 'Application name' },
        { name: '--client-secret', summary: 'Client secret' },
      ],
      dcr: [
        { name: '--name', summary: 'Application name' },
        { name: '--expires-in', summary: 'Client lifetime seconds (1-3600)' },
      ],
    },
  },

  {
    name: 'resource', group: 'admin', summary: 'Manage protected resources',
    subcommands: ['list', 'get', 'create', 'patch', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Resource name' },
        { name: '--identifier', summary: 'Resource identifier; generated from name when omitted' },
        { name: '--scopes', summary: 'Comma-separated resource scopes' },
        { name: '--upstream-url', summary: 'Upstream URL' },
        { name: '--gateway-application-id', summary: 'Gateway application for upstream routing' },
        { name: '--credential-provider-id', summary: 'Upstream credential provider ID' },
      ],
      patch: [
        { name: '--identifier', summary: 'Resource identifier' },
        { name: '--name', summary: 'Resource name' },
        { name: '--scopes', summary: 'Comma-separated resource scopes' },
        { name: '--upstream-url', summary: 'Upstream URL' },
        { name: '--gateway-application-id', summary: 'Gateway application for upstream routing' },
        { name: '--credential-provider-id', summary: 'Upstream credential provider ID' },
      ],
    },
  },

  {
    name: 'identity-provider', group: 'admin', summary: 'Manage identity providers',
    subcommands: ['list', 'get', 'create', 'patch', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Provider name' },
        { name: '--identifier', summary: 'Provider identifier' },
        { name: '--kind', summary: 'Provider kind (caracal_mandate, oauth2_authorization_code, oauth2_client_credentials, api_key, bearer_token)' },
        { name: '--config', summary: 'Inline config JSON' },
      ],
      patch: [
        { name: '--identifier', summary: 'Provider identifier' },
        { name: '--name', summary: 'Provider name' },
        { name: '--kind', summary: 'Provider kind (caracal_mandate, oauth2_authorization_code, oauth2_client_credentials, api_key, bearer_token)' },
        { name: '--config', summary: 'Inline config JSON' },
      ],
    },
  },

  {
    name: 'policy', group: 'admin', summary: 'Manage policies',
    subcommands: ['list', 'get', 'create', 'validate', 'version', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Policy name' },
        { name: '--description', summary: 'Policy description' },
        { name: '--content', summary: 'Inline policy content' },
        { name: '--file', summary: 'Read content from file' },
        { name: '--schema-version', summary: 'Policy schema version' },
        { name: '--owner-type', summary: 'Owner type' },
        { name: '--shadow', summary: 'Shadow policy mode' },
      ],
      validate: [
        { name: '--file', summary: 'Read Rego from file' },
        { name: '--content', summary: 'Inline Rego content' },
        { name: '--schema-version', summary: 'Policy schema version' },
      ],
      version: [
        { name: '--version', summary: 'Version label' },
        { name: '--content', summary: 'Inline policy content' },
        { name: '--file', summary: 'Read content from file' },
        { name: '--schema-version', summary: 'Policy schema version' },
      ],
    },
  },

  {
    name: 'policy-set', group: 'admin', summary: 'Manage policy sets',
    subcommands: ['list', 'get', 'create', 'version', 'activate', 'simulate', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Policy set name' },
        { name: '--description', summary: 'Description' },
      ],
      version: [
        { name: '--policy-versions', summary: 'Comma-separated policy version IDs' },
      ],
      activate: [
        { name: '--version', summary: 'Policy set version ID' },
        { name: '--shadow', summary: 'Shadow policy set version ID' },
      ],
      simulate: [
        { name: '--version', summary: 'Policy set version ID' },
        { name: '--input', summary: 'Inline OPA input fixture JSON' },
        { name: '--input-file', summary: 'OPA input fixture file' },
      ],
    },
  },

  {
    name: 'grant', group: 'admin', summary: 'Manage grants',
    subcommands: ['list', 'get', 'create', 'revoke'], requiresZone: true,
    flags: {
      create: [
        { name: '--app', summary: 'Application ID' },
        { name: '--resource', summary: 'Resource ID' },
        { name: '--user', summary: 'Subject (user) ID' },
        { name: '--scopes', summary: 'Comma-separated scopes' },
      ],
    },
  },

  {
    name: 'session', group: 'admin', summary: 'List authority sessions',
    subcommands: ['list'], requiresZone: true,
    flags: {
      list: [
        { name: '--subject', summary: 'Filter by subject ID' },
        { name: '--status', summary: 'Filter by status' },
        { name: '--limit', summary: 'Maximum rows to return' },
      ],
    },
  },

  {
    name: 'audit', group: 'observability', summary: 'Search audit events',
    subcommands: ['tail'], requiresZone: true,
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
    name: 'debug',
    group: 'observability',
    summary: 'Trace one request through decisions and diagnostics',
    subcommands: ['request'],
    requiresZone: true,
    hidden: true,
    flags: {
      request: [
        { name: '--request-id', summary: 'Request ID from an audit event' },
        { name: '--json', summary: 'Emit machine-readable DecisionTrace JSON' },
        { name: '--flow', summary: 'Render the authority path as Mermaid' },
      ],
    },
    scopes: { request: 'read' },
  },

  { name: 'agent', group: 'multiagent', summary: 'Manage agent sessions', subcommands: ['list', 'get', 'tree', 'suspend', 'resume', 'terminate'], requiresZone: true },
  { name: 'delegation', group: 'multiagent', summary: 'Manage delegation edges', subcommands: ['active', 'inbound', 'outbound', 'traverse', 'revoke'], requiresZone: true },

  {
    name: 'control', group: 'admin', summary: 'Manage the optional engine-owned Control automation service',
    subcommands: ['mount', 'enable', 'disable', 'unmount', 'status', 'key', 'rotate', 'revoke'],
    localOnly: true,
    flags: {
      key: [
        { name: '--name', summary: 'Credential display name' },
        { name: '--audience', summary: 'Control resource audience' },
      ],
      rotate: [{ name: '--client-secret', summary: 'New client secret' }],
    },
  },

  { name: 'completion', group: 'runtime', summary: 'Generate shell completions', subcommands: ['bash', 'zsh', 'fish', 'powershell'], hidden: true },
]);

export function findCommand(
  table: readonly CommandDescriptor[],
  name: string,
): CommandDescriptor | undefined {
  return table.find((c) => c.name === name);
}

export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
