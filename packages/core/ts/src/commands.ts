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
  | 'multiagent'
  | 'control';

export interface CommandDescriptor {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly subcommands?: readonly string[];
  readonly requiresConfig?: boolean;
  readonly requiresZone?: boolean;
  readonly hidden?: boolean;
}

export const SHELL_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  { name: 'up', group: 'stack', summary: 'Build and start the local stack' },
  { name: 'down', group: 'stack', summary: 'Stop the stack; -v also removes volumes' },
  { name: 'status', group: 'stack', summary: 'Probe /health on every service' },
  {
    name: 'purge',
    group: 'stack',
    summary: 'Centralized cleanup (stack, volumes, logs, config, runtime, secrets, cache, all)',
    subcommands: ['stack', 'volumes', 'logs', 'config', 'runtime', 'secrets', 'cache', 'all'],
  },
  { name: 'cli', group: 'shell', summary: 'Run the optional Caracal CLI (separate binary)' },
  { name: 'tui', group: 'shell', summary: 'Launch the optional Caracal TUI (separate binary)' },
]);

export const CLI_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  { name: 'run', group: 'runtime', summary: 'Run a command with RESOURCE_TOKEN injected into env', requiresConfig: true },
  { name: 'credential', group: 'runtime', summary: 'Print the resolved credential for a resource', subcommands: ['read'], requiresConfig: true },

  { name: 'zone', group: 'admin', summary: 'list|get|create|patch|delete', subcommands: ['list', 'get', 'create', 'patch', 'delete'] },
  { name: 'app', group: 'admin', summary: 'list|get|create|patch|delete|dcr', subcommands: ['list', 'get', 'create', 'patch', 'delete', 'dcr'] },
  { name: 'resource', group: 'admin', summary: 'list|get|create|patch|delete', subcommands: ['list', 'get', 'create', 'patch', 'delete'], requiresZone: true },
  { name: 'provider', group: 'admin', summary: 'list|get|create|patch|delete', subcommands: ['list', 'get', 'create', 'patch', 'delete'], requiresZone: true },
  { name: 'policy', group: 'admin', summary: 'list|get|create|version|delete', subcommands: ['list', 'get', 'create', 'version', 'delete'], requiresZone: true },
  { name: 'policy-set', group: 'admin', summary: 'list|get|create|version|activate|delete', subcommands: ['list', 'get', 'create', 'version', 'activate', 'delete'], requiresZone: true },
  { name: 'grant', group: 'admin', summary: 'list|get|create|revoke', subcommands: ['list', 'get', 'create', 'revoke', 'delete'], requiresZone: true },
  { name: 'session', group: 'admin', summary: 'list', subcommands: ['list'], requiresZone: true },

  { name: 'audit', group: 'observability', summary: 'tail [--decision …] [--request-id …] [--since …] [--limit N]', subcommands: ['tail'], requiresZone: true },
  { name: 'explain', group: 'observability', summary: 'Show audit row + determining policies + diagnostics', requiresZone: true },

  { name: 'agent', group: 'multiagent', summary: 'list|get|tree|suspend|resume|terminate', subcommands: ['list', 'get', 'tree', 'children', 'suspend', 'resume', 'terminate'], requiresZone: true },
  { name: 'delegation', group: 'multiagent', summary: 'inbound|outbound|traverse|revoke', subcommands: ['inbound', 'outbound', 'traverse', 'revoke'], requiresZone: true },

  { name: 'control', group: 'control', summary: 'token|revoke (issue or revoke an agent control token)', subcommands: ['token', 'revoke'] },

  { name: 'completion', group: 'shell', summary: 'Emit shell completion script (bash|zsh|fish|powershell)', subcommands: ['bash', 'zsh', 'fish', 'powershell'], hidden: true },
]);

export function findCommand(
  table: readonly CommandDescriptor[],
  name: string,
): CommandDescriptor | undefined {
  return table.find((c) => c.name === name);
}

export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
