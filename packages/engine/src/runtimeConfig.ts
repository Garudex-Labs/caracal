// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared runtime helpers: runtime config loading, validation, and service URL resolution.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CaracalError } from '@caracalai/core';
import { parse } from 'smol-toml';

export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_COORDINATOR_URL = 'http://localhost:4000';
export const DEFAULT_ZONE_URL = 'http://localhost:8080';

export interface Credential {
  env: string;
  resource: string;
  upstream_prefix?: string;
}

export interface OptionalCredential extends Credential {
  on_failure: 'warn' | 'error';
}

export interface McpGovernance {
  mode: 'block' | 'log';
}

export interface RuntimeConfig {
  zone_url: string;
  sts_url?: string;
  coordinator_url?: string;
  gateway_url?: string;
  zone_id: string;
  application_id: string;
  app_client_secret: string;
  continue_on_failure?: boolean;
  credentials?: Credential[];
  optional_credentials?: OptionalCredential[];
  mcp_governance?: McpGovernance;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_CREDENTIAL_ENV = new Set([
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

const CONFIG_MISSING_MESSAGE = 'runtime config not found; caracal run needs workload identity from env/secret files. Create or select a zone, application, resource, and policy in caracal console; store the one-time client secret in a 0600 secret file; set CARACAL_STS_URL, CARACAL_ZONE_ID, CARACAL_APPLICATION_ID, CARACAL_APP_CLIENT_SECRET_FILE, and CARACAL_RUN_CREDENTIALS_FILE. Use CARACAL_CONFIG only for an explicit runtime profile.';

const RUNTIME_CONFIG_KEYS = new Set([
  'zone_url',
  'sts_url',
  'coordinator_url',
  'gateway_url',
  'zone_id',
  'application_id',
  'app_client_secret',
  'app_client_secret_file',
  'continue_on_failure',
  'credentials',
  'optional_credentials',
  'mcp_governance',
]);

const CREDENTIAL_KEYS = new Set(['env', 'resource', 'upstream_prefix']);
const OPTIONAL_CREDENTIAL_KEYS = new Set(['env', 'resource', 'upstream_prefix', 'on_failure']);
const CREDENTIAL_MANIFEST_KEYS = new Set(['credentials', 'optional_credentials', 'continue_on_failure', 'mcp_governance']);

type UnknownRecord = Record<string, unknown>;

export class RuntimeConfigPermissionError extends CaracalError {
  readonly path: string;
  readonly mode: number;
  constructor(path: string, mode: number, advice: string) {
    super('config_permissions', `caracal.toml permissions are too broad: ${path} is ${formatMode(mode)}; ${advice}`, {
      details: { path, mode: formatMode(mode) },
    });
    this.name = 'RuntimeConfigPermissionError';
    this.path = path;
    this.mode = mode;
  }
}

export class RuntimeConfigValidationError extends CaracalError {
  readonly source: string;
  constructor(source: string, message: string) {
    super('config_invalid', `${source}: ${message}`, { details: { source } });
    this.name = 'RuntimeConfigValidationError';
    this.source = source;
  }
}

export class RuntimeConfigMissingError extends CaracalError {
  readonly userMessage = CONFIG_MISSING_MESSAGE;
  constructor() {
    super('config_missing', CONFIG_MISSING_MESSAGE);
    this.name = 'RuntimeConfigMissingError';
  }
}

export function defaultRuntimeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  return join(xdg, 'caracal', 'caracal.toml');
}

// Resolves the path to caracal.toml using the documented precedence:
//   $CARACAL_CONFIG → $XDG_CONFIG_HOME/caracal/caracal.toml
// Returns undefined when no candidate exists on disk.
export function resolveRuntimeConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CARACAL_CONFIG) return existsSync(env.CARACAL_CONFIG) ? env.CARACAL_CONFIG : undefined;
  const path = defaultRuntimeConfigPath(env);
  return existsSync(path) ? path : undefined;
}

export function assertRuntimeConfigFileSecure(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if (env.CARACAL_CONFIG === path) {
    if ((mode & 0o022) !== 0) {
      throw new RuntimeConfigPermissionError(path, mode, `remove group/world write bits from ${path}`);
    }
    return;
  }
  if ((mode & 0o077) !== 0) {
    throw new RuntimeConfigPermissionError(path, mode, `run chmod 600 ${path}`);
  }
}

export function assertCredentialEnvName(name: string): void {
  if (!ENV_NAME.test(name)) throw new RuntimeConfigValidationError('runtime config', `invalid credential env '${name}'`);
  if (BLOCKED_CREDENTIAL_ENV.has(name)) throw new RuntimeConfigValidationError('runtime config', `blocked credential env '${name}'`);
}

export function loadRuntimeConfig(required = false, env: NodeJS.ProcessEnv = process.env): RuntimeConfig | undefined {
  const path = resolveRuntimeConfigPath(env);
  if (env.CARACAL_CONFIG && path) {
    assertRuntimeConfigFileSecure(path, env);
    return normalizeRuntimeConfig(parseRuntimeConfigFile(path), path, env);
  }
  if (env.CARACAL_CONFIG) {
    if (required) throw new RuntimeConfigMissingError();
    return undefined;
  }
  const cfg = runtimeConfigFromEnv(env);
  if (cfg) return normalizeRuntimeConfig(cfg, 'environment', env);
  if (path) {
    assertRuntimeConfigFileSecure(path, env);
    return normalizeRuntimeConfig(parseRuntimeConfigFile(path), path, env);
  }
  if (required) throw new RuntimeConfigMissingError();
  return undefined;
}

function formatMode(mode: number): string {
  return '0o' + mode.toString(8).padStart(3, '0');
}

function parseRuntimeConfigFile(path: string): unknown {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RuntimeConfigValidationError(path, `failed to parse TOML: ${reason}`);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failConfig(source: string, message: string): never {
  throw new RuntimeConfigValidationError(source, message);
}

function assertNoUnknownKeys(record: UnknownRecord, allowed: Set<string>, source: string, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) failConfig(source, `unknown ${label} field '${key}'`);
  }
}

function stringField(record: UnknownRecord, key: string, source: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) failConfig(source, `${key} must be a non-empty string`);
  return value;
}

function requiredStringField(record: UnknownRecord, key: string, source: string): string {
  const value = stringField(record, key, source);
  if (!value) failConfig(source, `${key} is required`);
  return value;
}

function booleanField(record: UnknownRecord, key: string, source: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') failConfig(source, `${key} must be a boolean`);
  return value;
}

function validateEndpointUrl(value: string, key: string, source: string, env: NodeJS.ProcessEnv): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failConfig(source, `${key} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    failConfig(source, `${key} must use http or https`);
  }
  if (
    url.protocol === 'http:' &&
    !isLocalHostname(url.hostname) &&
    (env.NODE_ENV ?? 'development') !== 'development' &&
    env.CARACAL_ALLOW_INSECURE_CONFIG_URLS !== 'true'
  ) {
    failConfig(source, `${key} must use https outside local development`);
  }
  return value;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function readSecretFile(path: string, source: string): string {
  if (path.startsWith('cs_')) {
    failConfig(source, `secret file path looks like a client secret; write the secret to a 0600 file and set CARACAL_APP_CLIENT_SECRET_FILE to that path, or use CARACAL_APP_CLIENT_SECRET for inline local development`);
  }
  if (!existsSync(path)) failConfig(source, `secret file does not exist: ${path}`);
  assertSecretFileSecure(path, source);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) failConfig(source, `secret file is empty: ${path}`);
  return value;
}

function assertSecretFileSecure(path: string, source: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o022) !== 0) {
    failConfig(source, `secret file permissions are too broad: ${path} is ${formatMode(mode)}; remove group/world write bits`);
  }
}

function clientSecret(record: UnknownRecord, source: string): string {
  const value = stringField(record, 'app_client_secret', source);
  const file = stringField(record, 'app_client_secret_file', source);
  if (value && file) failConfig(source, 'set only one of app_client_secret or app_client_secret_file');
  if (file) return readSecretFile(file, source);
  if (value) return value;
  failConfig(source, 'app_client_secret or app_client_secret_file is required');
}

function normalizeCredential(value: unknown, source: string, index: number, optional: false): Credential;
function normalizeCredential(value: unknown, source: string, index: number, optional: true): OptionalCredential;
function normalizeCredential(value: unknown, source: string, index: number, optional: boolean): Credential | OptionalCredential {
  if (!isRecord(value)) failConfig(source, `${optional ? 'optional_credentials' : 'credentials'}[${index}] must be a table`);
  assertNoUnknownKeys(value, optional ? OPTIONAL_CREDENTIAL_KEYS : CREDENTIAL_KEYS, source, `${optional ? 'optional credential' : 'credential'}[${index}]`);
  const env = requiredStringField(value, 'env', source);
  try {
    assertCredentialEnvName(env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failConfig(source, reason.replace(/^runtime config: /, ''));
  }
  const resource = requiredStringField(value, 'resource', source);
  const upstreamPrefix = stringField(value, 'upstream_prefix', source);
  if (upstreamPrefix) validateEndpointUrl(upstreamPrefix, `credentials[${index}].upstream_prefix`, source, { ...process.env, NODE_ENV: 'development' });
  if (!optional) return upstreamPrefix ? { env, resource, upstream_prefix: upstreamPrefix } : { env, resource };
  const onFailure = stringField(value, 'on_failure', source) ?? 'warn';
  if (onFailure !== 'warn' && onFailure !== 'error') failConfig(source, `optional_credentials[${index}].on_failure must be 'warn' or 'error'`);
  return upstreamPrefix ? { env, resource, upstream_prefix: upstreamPrefix, on_failure: onFailure } : { env, resource, on_failure: onFailure };
}

function normalizeCredentials(record: UnknownRecord, key: 'credentials', source: string): Credential[] | undefined;
function normalizeCredentials(record: UnknownRecord, key: 'optional_credentials', source: string): OptionalCredential[] | undefined;
function normalizeCredentials(record: UnknownRecord, key: 'credentials' | 'optional_credentials', source: string): Credential[] | OptionalCredential[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) failConfig(source, `${key} must be an array`);
  const used = new Set<string>();
  return value.map((entry, index) => {
    const cred = key === 'optional_credentials'
      ? normalizeCredential(entry, source, index, true)
      : normalizeCredential(entry, source, index, false);
    if (used.has(cred.env)) failConfig(source, `duplicate credential env '${cred.env}'`);
    used.add(cred.env);
    return cred;
  });
}

function normalizeMcpGovernance(record: UnknownRecord, source: string, env: NodeJS.ProcessEnv): McpGovernance | undefined {
  const override = env.CARACAL_MCP_GOVERNANCE_MODE;
  if (override !== undefined) {
    if (override !== 'block' && override !== 'log') failConfig(source, 'CARACAL_MCP_GOVERNANCE_MODE must be block or log');
    assertMcpGovernanceModeAllowed(override, source, env);
    return { mode: override };
  }
  const value = record.mcp_governance;
  if (value === undefined) return undefined;
  if (!isRecord(value)) failConfig(source, 'mcp_governance must be a table');
  assertNoUnknownKeys(value, new Set(['mode']), source, 'mcp_governance');
  const mode = requiredStringField(value, 'mode', source);
  if (mode !== 'block' && mode !== 'log') failConfig(source, 'mcp_governance.mode must be block or log');
  assertMcpGovernanceModeAllowed(mode, source, env);
  return { mode };
}

function normalizeRuntimeConfig(value: unknown, source: string, env: NodeJS.ProcessEnv): RuntimeConfig {
  if (!isRecord(value)) failConfig(source, 'runtime config must be a table');
  assertNoUnknownKeys(value, RUNTIME_CONFIG_KEYS, source, 'runtime config');
  const zoneUrl = stringField(value, 'zone_url', source) ?? stringField(value, 'sts_url', source);
  if (!zoneUrl) failConfig(source, 'zone_url or sts_url is required');
  const cfg: RuntimeConfig = {
    zone_url: validateEndpointUrl(zoneUrl, 'zone_url', source, env),
    zone_id: requiredStringField(value, 'zone_id', source),
    application_id: requiredStringField(value, 'application_id', source),
    app_client_secret: clientSecret(value, source),
  };
  const stsUrl = stringField(value, 'sts_url', source);
  if (stsUrl) cfg.sts_url = validateEndpointUrl(stsUrl, 'sts_url', source, env);
  const coordinatorUrl = stringField(value, 'coordinator_url', source);
  if (coordinatorUrl) cfg.coordinator_url = validateEndpointUrl(coordinatorUrl, 'coordinator_url', source, env);
  const gatewayUrl = stringField(value, 'gateway_url', source);
  if (gatewayUrl) cfg.gateway_url = validateEndpointUrl(gatewayUrl, 'gateway_url', source, env);
  const continueOnFailure = booleanField(value, 'continue_on_failure', source);
  if (
    continueOnFailure === true &&
    (env.NODE_ENV ?? 'development') !== 'development' &&
    env.CARACAL_ALLOW_REQUIRED_CREDENTIAL_FAILURE !== 'true'
  ) {
    failConfig(source, 'continue_on_failure=true is not allowed outside development');
  }
  if (continueOnFailure !== undefined) cfg.continue_on_failure = continueOnFailure;
  const credentials = normalizeCredentials(value, 'credentials', source);
  if (credentials) cfg.credentials = credentials;
  const optionalCredentials = normalizeCredentials(value, 'optional_credentials', source);
  if (optionalCredentials) cfg.optional_credentials = optionalCredentials;
  assertUniqueCredentialEnv(cfg.credentials, cfg.optional_credentials, source);
  const governance = normalizeMcpGovernance(value, source, env);
  if (governance) cfg.mcp_governance = governance;
  return cfg;
}

function assertMcpGovernanceModeAllowed(mode: 'block' | 'log', source: string, env: NodeJS.ProcessEnv): void {
  if (
    mode === 'log' &&
    (env.NODE_ENV ?? 'development') !== 'development' &&
    env.CARACAL_ALLOW_MCP_GOVERNANCE_LOG !== 'true'
  ) {
    failConfig(source, 'mcp_governance.mode=log is not allowed outside development');
  }
}

function assertUniqueCredentialEnv(credentials: readonly Credential[] | undefined, optionalCredentials: readonly OptionalCredential[] | undefined, source: string): void {
  const used = new Set<string>();
  for (const cred of [...(credentials ?? []), ...(optionalCredentials ?? [])]) {
    if (used.has(cred.env)) failConfig(source, `duplicate credential env '${cred.env}'`);
    used.add(cred.env);
  }
}

function runtimeConfigFromEnv(env: NodeJS.ProcessEnv): UnknownRecord | undefined {
  if (!hasEnvRuntimeConfig(env)) return undefined;
  const manifest = credentialManifestFromEnv(env);
  const cfg: UnknownRecord = {
    ...manifest,
    zone_url: env.CARACAL_STS_URL ?? env.CARACAL_ZONE_URL,
    coordinator_url: env.CARACAL_COORDINATOR_URL,
    gateway_url: env.CARACAL_GATEWAY_URL,
    zone_id: env.CARACAL_ZONE_ID,
    application_id: env.CARACAL_APPLICATION_ID,
    app_client_secret: env.CARACAL_APP_CLIENT_SECRET,
    app_client_secret_file: env.CARACAL_APP_CLIENT_SECRET_FILE,
  };
  const continueOnFailure = parseBooleanEnv(env.CARACAL_RUN_CONTINUE_ON_FAILURE, 'CARACAL_RUN_CONTINUE_ON_FAILURE');
  if (continueOnFailure !== undefined) cfg.continue_on_failure = continueOnFailure;
  return cfg;
}

function hasEnvRuntimeConfig(env: NodeJS.ProcessEnv): boolean {
  return [
    'CARACAL_APPLICATION_ID',
    'CARACAL_APP_CLIENT_SECRET',
    'CARACAL_APP_CLIENT_SECRET_FILE',
    'CARACAL_RUN_CREDENTIALS',
    'CARACAL_RUN_CREDENTIALS_FILE',
  ].some((key) => env[key] !== undefined && env[key] !== '');
}

function parseBooleanEnv(value: string | undefined, key: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  failConfig('environment', `${key} must be true or false`);
}

function credentialManifestFromEnv(env: NodeJS.ProcessEnv): UnknownRecord {
  const file = env.CARACAL_RUN_CREDENTIALS_FILE;
  const inline = env.CARACAL_RUN_CREDENTIALS;
  if (file && inline) failConfig('environment', 'set only one of CARACAL_RUN_CREDENTIALS or CARACAL_RUN_CREDENTIALS_FILE');
  const raw = file ? readSecretFile(file, 'environment') : inline;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failConfig('environment', `failed to parse credential manifest JSON: ${reason}`);
  }
  const manifest = Array.isArray(parsed) ? { credentials: parsed } : parsed;
  if (!isRecord(manifest)) failConfig('environment', 'credential manifest must be an array or object');
  assertNoUnknownKeys(manifest, CREDENTIAL_MANIFEST_KEYS, 'environment', 'credential manifest');
  return manifest;
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
// in non-development so misconfigured production management never silently hits localhost.
export function resolveServiceUrl(envKey: string, devDefault: string): string {
  const v = process.env[envKey];
  if (v) return v;
  const env = process.env.NODE_ENV ?? 'development';
  if (env !== 'development') {
    throw new ServiceUrlMissingError(envKey, env);
  }
  return devDefault;
}
