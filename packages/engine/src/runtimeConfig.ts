// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared runtime helpers: workload identity loading, credential validation, and service URL resolution.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { CaracalError } from '@caracalai/core'

export const DEFAULT_API_URL = 'http://localhost:3000'
export const DEFAULT_COORDINATOR_URL = 'http://localhost:4000'
export const DEFAULT_STS_URL = 'http://localhost:8080'
export const DEFAULT_GATEWAY_URL = 'http://localhost:8081'
export const DEFAULT_ZONE_URL = DEFAULT_STS_URL

// RuntimeIdentity is everything a workload carries locally: who it is and where STS lives.
// The credential bindings themselves are authored in the web console and served by STS.
export interface RuntimeIdentity {
  sts_url: string
  workload_id: string
  workload_secret: string
}

// RuntimeConfig is the application credential profile the Console BFF exchanges Control
// tokens with.
export interface RuntimeConfig {
  zone_url: string
  zone_id: string
  application_id: string
  app_client_secret: string
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BLOCKED_CREDENTIAL_ENV = new Set([
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
])

const CONFIG_MISSING_MESSAGE =
  'workload identity not found; set CARACAL_WORKLOAD_ID and provide its secret via CARACAL_WORKLOAD_SECRET, CARACAL_WORKLOAD_SECRET_FILE, or the owner-only default file. Create the launcher workload and its bindings in the web console.'

export class RuntimeConfigValidationError extends CaracalError {
  readonly source: string
  constructor(source: string, message: string) {
    super('config_invalid', `${source}: ${message}`, { details: { source } })
    this.name = 'RuntimeConfigValidationError'
    this.source = source
  }
}

export class RuntimeConfigMissingError extends CaracalError {
  readonly userMessage = CONFIG_MISSING_MESSAGE
  constructor() {
    super('config_missing', CONFIG_MISSING_MESSAGE)
    this.name = 'RuntimeConfigMissingError'
  }
}

export function defaultCaracalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CARACAL_CONFIG_HOME && env.CARACAL_CONFIG_HOME.length > 0) return env.CARACAL_CONFIG_HOME
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : undefined
  if (xdg) return join(xdg, 'caracal')
  if (platform() === 'win32') {
    const base = env.APPDATA || env.LOCALAPPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(base, 'Caracal')
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Caracal')
  return join(homedir(), '.config', 'caracal')
}

export function defaultRuntimeCredentialDir(workloadId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultCaracalConfigDir(env), 'runtime', safePathSegment(workloadId))
}

export function defaultWorkloadSecretFilePath(workloadId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultRuntimeCredentialDir(workloadId, env), 'secret')
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_')
  let start = 0
  let end = segment.length
  while (start < end && segment[start] === '_') start += 1
  while (end > start && segment[end - 1] === '_') end -= 1
  return segment.slice(start, end) || 'default'
}

export function assertCredentialEnvName(name: string): void {
  if (!ENV_NAME.test(name)) throw new RuntimeConfigValidationError('runtime config', `invalid credential env '${name}'`)
  // Case-insensitive: Windows environments fold case, so 'ld_preload' must be as blocked as 'LD_PRELOAD'.
  if (BLOCKED_CREDENTIAL_ENV.has(name.toUpperCase()))
    throw new RuntimeConfigValidationError('runtime config', `blocked credential env '${name}'`)
}

// Resolves the workload identity from the environment. The workload id names the
// launcher; the secret comes from CARACAL_WORKLOAD_SECRET, an explicit secret-file
// path, or the owner-only default file in non-production environments.
export function loadRuntimeIdentity(required = false, env: NodeJS.ProcessEnv = process.env): RuntimeIdentity | undefined {
  const workloadId = env.CARACAL_WORKLOAD_ID
  if (!workloadId) {
    if (required) throw new RuntimeConfigMissingError()
    return undefined
  }
  return {
    sts_url: validateEndpointUrl(resolveStsUrl(env), 'sts_url', 'environment', env),
    workload_id: workloadId,
    workload_secret: resolveWorkloadSecret(workloadId, env),
  }
}

function resolveWorkloadSecret(workloadId: string, env: NodeJS.ProcessEnv): string {
  const value = env.CARACAL_WORKLOAD_SECRET
  const file = env.CARACAL_WORKLOAD_SECRET_FILE
  if (value && file) failConfig('environment', 'set only one of CARACAL_WORKLOAD_SECRET or CARACAL_WORKLOAD_SECRET_FILE')
  if (file) return readSecretFile(file, 'environment')
  if (value) return value
  const localFile = existingLocalFile(defaultWorkloadSecretFilePath(workloadId, env), env)
  if (localFile) return readSecretFile(localFile, 'environment')
  failConfig(
    'environment',
    `workload secret is required; set CARACAL_WORKLOAD_SECRET, point CARACAL_WORKLOAD_SECRET_FILE at an owner-only file, or store the secret at ${defaultWorkloadSecretFilePath(workloadId, env)}`,
  )
}

function formatMode(mode: number): string {
  return '0o' + mode.toString(8).padStart(3, '0')
}

function failConfig(source: string, message: string): never {
  throw new RuntimeConfigValidationError(source, message)
}

export function validateEndpointUrl(value: string, key: string, source: string, env: NodeJS.ProcessEnv): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    failConfig(source, `${key} must be an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    failConfig(source, `${key} must use http or https`)
  }
  if (url.protocol === 'http:' && !isLocalHostname(url.hostname) && env.CARACAL_ALLOW_INSECURE_CONFIG_URLS !== 'true') {
    failConfig(
      source,
      `${key} must use https for non-local hosts; set CARACAL_ALLOW_INSECURE_CONFIG_URLS=true only on a trusted private network`,
    )
  }
  return value
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function readSecretFile(path: string, source: string): string {
  if (path.startsWith('ws_')) {
    failConfig(
      source,
      `secret file path looks like a workload secret; write the secret to the local auto-detected owner-only file or configure an explicit secret-file path for cloud/custom deployments`,
    )
  }
  if (!existsSync(path)) failConfig(source, `secret file does not exist: ${path}`)
  assertSecretFileSecure(path, source)
  const value = readFileSync(path, 'utf8').trim()
  if (!value) failConfig(source, `secret file is empty: ${path}`)
  return value
}

function assertSecretFileSecure(path: string, source: string): void {
  if (process.platform === 'win32') return
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) {
    failConfig(source, `secret file permissions are too broad: ${path} is ${formatMode(mode)}; make it owner-only (chmod 600)`)
  }
}

// CARACAL_ENV names the deployment environment explicitly and wins over NODE_ENV,
// matching the SDK's gate so one convention covers every Caracal surface.
function isProductionRuntime(env: NodeJS.ProcessEnv): boolean {
  if (env.CARACAL_ENV) return env.CARACAL_ENV === 'production'
  return env.NODE_ENV === 'production'
}

function existingLocalFile(path: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isProductionRuntime(env)) return undefined
  return existsSync(path) ? path : undefined
}

export class ServiceUrlMissingError extends CaracalError {
  readonly envKey: string
  readonly runtimeEnv: string
  constructor(envKey: string, runtimeEnv: string) {
    super('config_missing', `${envKey} is required when the runtime environment is ${runtimeEnv}`, {
      details: { envKey, runtimeEnv },
    })
    this.name = 'ServiceUrlMissingError'
    this.envKey = envKey
    this.runtimeEnv = runtimeEnv
  }
}

// Returns the env-var override or the dev default. Throws ServiceUrlMissingError
// outside development so misconfigured production management never silently hits
// localhost. CARACAL_ENV wins over NODE_ENV, matching isProductionRuntime.
export function resolveServiceUrl(envKey: string, devDefault: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[envKey]
  if (v) return v
  const runtimeEnv = env.CARACAL_ENV ?? env.NODE_ENV ?? 'development'
  if (runtimeEnv !== 'development') {
    throw new ServiceUrlMissingError(envKey, runtimeEnv)
  }
  return devDefault
}

export function resolveStsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.CARACAL_STS_URL ?? env.CARACAL_ZONE_URL ?? resolveServiceUrl('CARACAL_STS_URL', DEFAULT_STS_URL, env)
}
