// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime env loader: resolves the declared schema against build pins, mode defaults, override files, and process.env, with _FILE secret resolution and pinned-var enforcement.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_SCHEMA, envEntries, isPinned, resolveDefault, type EnvKey, type EnvSpec, type StackMode } from './envSchema.js'

export type EnvValues = Readonly<Record<EnvKey, string | undefined>>

export interface LoadEnvOpts {
  mode: StackMode
  // Build-time pinned constants (CARACAL_MODE, CARACAL_VERSION, CARACAL_REGISTRY,
  // optionally CARACAL_DEV_SHA). Authoritative in rc/stable; cannot be shadowed.
  pins?: Partial<Record<EnvKey, string>>
  // Operator override file (e.g. $CARACAL_HOME/caracal.env or infra/docker/local.env).
  overrideFile?: string
  // Override of process.env for tests.
  processEnv?: Record<string, string | undefined>
}

export function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

export class SecretFileError extends Error {
  constructor(
    public readonly key: string,
    public readonly path: string,
  ) {
    super(`secret file empty: ${key}_FILE=${path}`)
    this.name = 'SecretFileError'
  }
}

function readSecret(key: EnvKey, path: string): string {
  const value = readFileSync(path, 'utf8').trim()
  if (!value) throw new SecretFileError(key, path)
  return value
}

function resolveSecret(key: EnvKey, spec: EnvSpec, env: Record<string, string | undefined>): string | undefined {
  // Honour the *_FILE convention: services and the loader prefer file material
  // and never carry secret strings through env files.
  const filePath = env[`${key}_FILE`]
  if (filePath && existsSync(filePath)) return readSecret(key, filePath)
  const direct = env[key]
  if (direct) return direct
  // Resolve from the schema-declared secret basename when a per-spec file is set
  // and CARACAL_SECRETS_DIR is in scope (engine sets it during bootstrap).
  const dir = env.CARACAL_SECRETS_DIR
  if (spec.file && dir) {
    const candidate = join(dir, spec.file)
    if (existsSync(candidate)) return readSecret(key, candidate)
  }
  return undefined
}

export class PinnedVarError extends Error {
  constructor(
    public readonly key: string,
    public readonly mode: StackMode,
  ) {
    super(`pinned env var ${key} cannot be overridden in ${mode} mode`)
    this.name = 'PinnedVarError'
  }
}

export function loadEnv(opts: LoadEnvOpts): EnvValues {
  const mode = opts.mode
  const pins = opts.pins ?? {}
  const overrides = opts.overrideFile ? readDotenv(opts.overrideFile) : {}
  const proc = opts.processEnv ?? process.env

  const resolved: Record<string, string | undefined> = {}
  for (const [key, spec] of envEntries()) {
    if (spec.secret) {
      resolved[key] = resolveSecret(key, spec, proc)
      continue
    }
    if (isPinned(spec, mode)) {
      const pin = pins[key]
      const fromOverride = overrides[key]
      const fromProc = proc[key]
      if (fromOverride !== undefined && fromOverride !== pin) {
        throw new PinnedVarError(key, mode)
      }
      if (fromProc !== undefined && fromProc !== pin) {
        throw new PinnedVarError(key, mode)
      }
      resolved[key] = pin ?? resolveDefault(spec, mode)
      continue
    }
    resolved[key] = proc[key] ?? overrides[key] ?? pins[key] ?? resolveDefault(spec, mode)
  }
  return Object.freeze(resolved) as EnvValues
}

// Returns the subset of the schema that materialises into compose `--env-file`
// substitutions. Secrets and pinned values not exposed to compose are omitted.
export function composeSubstitutions(values: EnvValues): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, spec] of envEntries()) {
    if (spec.secret) continue
    const v = values[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

export { ENV_SCHEMA }
