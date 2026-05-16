// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Canonical command catalog shared by every Caracal interface so CLI and TUI advertise identical names, groups, and subcommand surfaces.

export type CommandGroup =
  | 'shell'
  | 'stack'
  | 'runtime'
  | 'admin'
  | 'observability'
  | 'multiagent';

export interface FlagDescriptor {
  readonly name: string;
  readonly summary: string;
}

export interface CommandDescriptor {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly subcommands?: readonly string[];
  readonly requiresConfig?: boolean;
  readonly requiresZone?: boolean;
  readonly hidden?: boolean;
  /** Flags keyed by subcommand name; use '' for commands with no subcommands. */
  readonly flags?: { readonly [k: string]: readonly FlagDescriptor[] };
}

export const SHELL_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  { name: 'up', group: 'stack', summary: 'Build and start the local stack' },
  { name: 'down', group: 'stack', summary: 'Stop the stack; use -v to remove volumes' },
  { name: 'status', group: 'stack', summary: 'Check service health' },
  {
    name: 'purge',
    group: 'stack',
    summary: 'Clean stack artifacts and local state',
    subcommands: ['stack', 'volumes', 'logs', 'config', 'runtime', 'secrets', 'cache', 'all'],
  },
  { name: 'cli', group: 'shell', summary: 'Open the Caracal command shell' },
  { name: 'tui', group: 'shell', summary: 'Launch the Caracal TUI' },
]);

export const CLI_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  { name: 'run', group: 'runtime', summary: 'Run a command with RESOURCE_TOKEN', requiresConfig: true },
  { name: 'credential', group: 'runtime', summary: 'Read a resource credential', subcommands: ['read'], requiresConfig: true },

  {
    name: 'zone', group: 'admin', summary: 'Manage zones',
    subcommands: ['use', 'list', 'get', 'create', 'patch', 'delete'],
    flags: {
      create: [
        { name: '--name', summary: 'Zone display name (required)' },
        { name: '--slug', summary: 'URL-safe slug' },
        { name: '--org', summary: 'Organization ID' },
        { name: '--dcr', summary: 'Enable dynamic client registration' },
        { name: '--no-pkce', summary: 'Disable PKCE (on by default)' },
        { name: '--login-flow', summary: 'Login flow type' },
      ],
      patch: [
        { name: '--name', summary: 'Zone display name' },
        { name: '--slug', summary: 'URL-safe slug' },
        { name: '--org', summary: 'Organization ID' },
        { name: '--dcr', summary: 'Enable/disable DCR (=true|false)' },
        { name: '--pkce', summary: 'Require PKCE (=true|false)' },
        { name: '--login-flow', summary: 'Login flow type' },
      ],
    },
  },

  {
    name: 'app', group: 'admin', summary: 'Manage applications',
    subcommands: ['list', 'get', 'create', 'patch', 'delete', 'dcr'],
    flags: {
      create: [
        { name: '--name', summary: 'Application name' },
        { name: '--credential-type', summary: 'Credential type' },
        { name: '--client-secret', summary: 'Client secret' },
        { name: '--method', summary: 'Auth method' },
        { name: '--consent', summary: 'Require consent' },
        { name: '--expires-in', summary: 'Token expiry seconds' },
      ],
      patch: [
        { name: '--name', summary: 'Application name' },
        { name: '--consent', summary: 'Require consent (=true|false)' },
        { name: '--expires-in', summary: 'Token expiry seconds' },
      ],
      dcr: [{ name: '--client-secret', summary: 'Client secret to register' }],
    },
  },

  {
    name: 'resource', group: 'admin', summary: 'Manage protected resources',
    subcommands: ['list', 'get', 'create', 'patch', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Resource name' },
        { name: '--identifier', summary: 'Resource identifier' },
        { name: '--upstream-url', summary: 'Upstream URL' },
        { name: '--provider', summary: 'Provider ID' },
        { name: '--prefix', summary: 'Treat identifier as prefix' },
      ],
      patch: [
        { name: '--name', summary: 'Resource name' },
        { name: '--upstream-url', summary: 'Upstream URL' },
        { name: '--prefix', summary: 'Treat identifier as prefix (=true|false)' },
      ],
    },
  },

  {
    name: 'provider', group: 'admin', summary: 'Manage identity providers',
    subcommands: ['list', 'get', 'create', 'patch', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Provider name' },
        { name: '--identifier', summary: 'Provider identifier' },
        { name: '--kind', summary: 'Provider kind (oidc, …)' },
        { name: '--client-id', summary: 'Provider client ID' },
        { name: '--owner-type', summary: 'Owner type' },
        { name: '--config', summary: 'Inline config JSON or @file' },
      ],
      patch: [
        { name: '--name', summary: 'Provider name' },
        { name: '--client-id', summary: 'Provider client ID' },
        { name: '--config', summary: 'Inline config JSON or @file' },
      ],
    },
  },

  {
    name: 'policy', group: 'admin', summary: 'Manage policies',
    subcommands: ['list', 'get', 'create', 'version', 'delete'], requiresZone: true,
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
      version: [
        { name: '--version', summary: 'Version label' },
        { name: '--content', summary: 'Inline policy content' },
        { name: '--file', summary: 'Read content from file' },
      ],
    },
  },

  {
    name: 'policy-set', group: 'admin', summary: 'Manage policy sets',
    subcommands: ['list', 'get', 'create', 'version', 'activate', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--name', summary: 'Policy set name' },
        { name: '--description', summary: 'Description' },
      ],
    },
  },

  {
    name: 'grant', group: 'admin', summary: 'Manage grants',
    subcommands: ['list', 'get', 'create', 'revoke', 'delete'], requiresZone: true,
    flags: {
      create: [
        { name: '--app', summary: 'Application ID' },
        { name: '--resource', summary: 'Resource ID' },
        { name: '--user', summary: 'Subject (user) ID' },
      ],
    },
  },

  {
    name: 'session', group: 'admin', summary: 'List sessions',
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

  { name: 'explain', group: 'observability', summary: 'Explain an audit request', requiresZone: true },

  { name: 'agent', group: 'multiagent', summary: 'Manage agent sessions', subcommands: ['list', 'get', 'tree', 'children', 'suspend', 'resume', 'terminate'], requiresZone: true },
  { name: 'delegation', group: 'multiagent', summary: 'Manage delegation edges', subcommands: ['inbound', 'outbound', 'traverse', 'revoke'], requiresZone: true },

  {
    name: 'control', group: 'admin', summary: 'Manage control API credentials',
    subcommands: ['key', 'rotate', 'revoke'], requiresZone: true,
    flags: {
      key: [{ name: '--name', summary: 'Credential display name' }],
      rotate: [{ name: '--client-secret', summary: 'New client secret' }],
    },
  },

  { name: 'completion', group: 'shell', summary: 'Generate shell completions', subcommands: ['bash', 'zsh', 'fish', 'powershell'], hidden: true },
]);

export function findCommand(
  table: readonly CommandDescriptor[],
  name: string,
): CommandDescriptor | undefined {
  return table.find((c) => c.name === name);
}

export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
