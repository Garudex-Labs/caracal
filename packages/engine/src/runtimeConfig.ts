// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared CLI/TUI helpers: caracal.toml discovery and service URL resolution.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CaracalError } from '@caracalai/core';

export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_COORDINATOR_URL = 'http://localhost:4000';
export const DEFAULT_ZONE_URL = 'http://localhost:8080';

export interface Credential {
  env: string;
  resource: string;
}

export interface OptionalCredential extends Credential {
  on_failure: 'warn' | 'error';
}

export interface McpGovernance {
  mode: 'block' | 'log';
}

export interface CliConfig {
  zone_url: string;
  zone_id: string;
  application_id: string;
  app_client_secret: string;
  continue_on_failure?: boolean;
  credentials?: Credential[];
  optional_credentials?: OptionalCredential[];
  mcp_governance?: McpGovernance;
}

export function defaultCliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  return join(xdg, 'caracal', 'caracal.toml');
}

// Resolves the path to caracal.toml using the documented precedence:
//   $CARACAL_CONFIG → ./caracal.toml (cwd / $PWD / $INIT_CWD) → $XDG_CONFIG_HOME/caracal/caracal.toml
// Returns undefined when no candidate exists on disk.
export function resolveCliConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (env.CARACAL_CONFIG) candidates.push(env.CARACAL_CONFIG);
  for (const dir of [process.cwd(), env.PWD, env.INIT_CWD]) {
    if (dir) candidates.push(join(dir, 'caracal.toml'));
  }
  candidates.push(defaultCliConfigPath(env));
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

export class ServiceUrlMissingError extends CaracalError {
  readonly envKey: string;
  readonly nodeEnv: string;
  constructor(envKey: string, nodeEnv: string) {
    super('config_missing', `${envKey} is required when NODE_ENV=${nodeEnv}`, {
      details: { envKey, nodeEnv },
    });
    this.name = 'ServiceUrlMissingError';
    this.envKey = envKey;
    this.nodeEnv = nodeEnv;
  }
}

// Returns the env-var override or the dev default. Throws ServiceUrlMissingError
// in non-development so a misconfigured production CLI never silently hits localhost.
export function resolveServiceUrl(envKey: string, devDefault: string): string {
  const v = process.env[envKey];
  if (v) return v;
  const env = process.env.NODE_ENV ?? 'development';
  if (env !== 'development') {
    throw new ServiceUrlMissingError(envKey, env);
  }
  return devDefault;
}
