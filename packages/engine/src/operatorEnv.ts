// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Loads the operator env file so every `caracal` command reads one centralized configuration.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { runtimePaths } from './runtime.js'

// Dev is signalled by CARACAL_MODE=dev or, as the workspace launcher does, by the presence
// of CARACAL_REPO_ROOT. This mirrors resolveStackPaths so the CLI and stack agree on mode.
function isDevMode(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return false
  if (env.CARACAL_MODE) return env.CARACAL_MODE === 'dev'
  return Boolean(env.CARACAL_REPO_ROOT)
}

// Resolves the operator env files the CLI loads, in decreasing precedence. An explicit
// CARACAL_ENV_FILE always applies; dev resolves the repo-root `.env` then the stack files;
// an installed stack resolves $CARACAL_HOME/caracal.env. Mirrors the API service so the CLI
// and services agree.
function operatorEnvFiles(env: NodeJS.ProcessEnv): string[] {
  const files: string[] = []
  if (env.CARACAL_ENV_FILE) files.push(resolve(env.CARACAL_ENV_FILE))
  if (isDevMode(env) && env.CARACAL_REPO_ROOT) {
    files.push(join(env.CARACAL_REPO_ROOT, '.env'))
    files.push(join(env.CARACAL_REPO_ROOT, 'infra', 'docker', 'local.env'))
    files.push(join(env.CARACAL_REPO_ROOT, 'infra', 'docker', 'dev.env'))
  }
  if (!isDevMode(env)) files.push(runtimePaths().overrideEnvFile)
  return files
}

// Loads the operator env file(s) into process.env so `caracal run`, `caracal web`, and
// `caracal up` share one configuration source. Parsed file values fill only variables that
// are unset, so a real process environment - exported shell variables, secret-manager
// injection, or CI - always wins over the file. Absent or unreadable files are skipped.
// Returns the paths that were applied.
export function loadOperatorEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = []
  const seen = new Set<string>()
  for (const file of operatorEnvFiles(env)) {
    if (seen.has(file)) continue
    seen.add(file)
    if (!existsSync(file)) continue
    try {
      const parsed = parseEnv(readFileSync(file, 'utf8'))
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value
      }
      applied.push(file)
    } catch {
      // A malformed operator file must not brick the CLI; commands continue with the
      // environment they already have.
    }
  }
  return applied
}
