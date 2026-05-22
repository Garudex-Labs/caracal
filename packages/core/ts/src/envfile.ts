// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Helpers for reading dotenv files and discovering the Caracal admin token.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Resolve the installed home written to by `caracal up`.
 * Mirrors the layout in packages/engine/src/runtime.ts.
 */
export function installedHome(): string {
  if (process.env.CARACAL_HOME) return process.env.CARACAL_HOME;
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'caracal');
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'caracal');
}

function readSecretFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, 'utf8').trim();
  return value.length > 0 ? value : undefined;
}

export function discoverAdminToken(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.CARACAL_ADMIN_TOKEN) return process.env.CARACAL_ADMIN_TOKEN;
  if (process.env.CARACAL_ADMIN_TOKEN_FILE) {
    const value = readSecretFile(process.env.CARACAL_ADMIN_TOKEN_FILE);
    if (value) return value;
  }
  const installed = readSecretFile(join(installedHome(), 'secrets', 'caracalAdminToken'));
  if (installed) return installed;
  if (process.env.CARACAL_REPO_ROOT) {
    const dev = readSecretFile(join(process.env.CARACAL_REPO_ROOT, 'infra', 'secrets', 'files', 'caracalAdminToken'));
    if (dev) return dev;
  }
  if (process.env.CARACAL_ENV_FILE) {
    const env = readEnvFile(process.env.CARACAL_ENV_FILE);
    if (env.CARACAL_ADMIN_TOKEN) return env.CARACAL_ADMIN_TOKEN;
  }
  return undefined;
}

export function discoverCoordinatorToken(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.CARACAL_COORDINATOR_TOKEN) return process.env.CARACAL_COORDINATOR_TOKEN;
  if (process.env.CARACAL_COORDINATOR_TOKEN_FILE) {
    const value = readSecretFile(process.env.CARACAL_COORDINATOR_TOKEN_FILE);
    if (value) return value;
  }
  const installed = readSecretFile(join(installedHome(), 'secrets', 'caracalCoordinatorToken'));
  if (installed) return installed;
  if (process.env.CARACAL_REPO_ROOT) {
    const dev = readSecretFile(join(process.env.CARACAL_REPO_ROOT, 'infra', 'secrets', 'files', 'caracalCoordinatorToken'));
    if (dev) return dev;
  }
  if (process.env.CARACAL_ENV_FILE) {
    const env = readEnvFile(process.env.CARACAL_ENV_FILE);
    if (env.CARACAL_COORDINATOR_TOKEN) return env.CARACAL_COORDINATOR_TOKEN;
  }
  return undefined;
}
