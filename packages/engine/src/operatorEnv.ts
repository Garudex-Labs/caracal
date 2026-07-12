// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Loads the operator env file so every `caracal` command reads one centralized configuration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
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
// `caracal up` share one configuration source. Node's loadEnvFile never overwrites a
// variable that is already set, so a real process environment - exported shell variables,
// secret-manager injection, or CI - always wins over the file. Absent or unreadable files
// are skipped. Returns the paths that were applied.
export function loadOperatorEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = []
  const seen = new Set<string>()
  for (const file of operatorEnvFiles(env)) {
    if (seen.has(file)) continue
    seen.add(file)
    if (!existsSync(file)) continue
    try {
      loadEnvFile(file)
      applied.push(file)
    } catch {
      // A malformed operator file must not brick the CLI; commands continue with the
      // environment they already have.
    }
  }
  return applied
}

// The single file `caracal config` reads and writes: an explicit CARACAL_ENV_FILE, the
// repo-root `.env` in dev, or $CARACAL_HOME/caracal.env on an installed stack. This is the
// highest-precedence writable file in the same chain loadOperatorEnv reads.
export function operatorEnvTarget(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CARACAL_ENV_FILE) return resolve(env.CARACAL_ENV_FILE)
  if (isDevMode(env) && env.CARACAL_REPO_ROOT) return join(env.CARACAL_REPO_ROOT, '.env')
  return runtimePaths().overrideEnvFile
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function quoteIfNeeded(value: string): string {
  return /[\s"'#]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

// Reads the file's effective KEY=VALUE entries, ignoring comments and blank lines; the last
// assignment of a key wins. Returns an empty map when the file is absent.
export function readEnvEntries(path: string): Map<string, string> {
  const entries = new Map<string, string>()
  if (!existsSync(path)) return entries
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (match) entries.set(match[1], unquote(match[2]))
  }
  return entries
}

// Sets KEY=value in the file, preserving comments and order: an existing active assignment is
// replaced in place, otherwise the entry is appended. Creates the file owner-only if absent.
export function setEnvEntry(path: string, key: string, value: string): void {
  const line = `${key}=${quoteIfNeeded(value)}`
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${line}\n`, { mode: 0o600 })
    return
  }
  const lines = readFileSync(path, 'utf8').split('\n')
  const active = new RegExp(`^\\s*${key}\\s*=`)
  const index = lines.findIndex((entry) => !entry.trimStart().startsWith('#') && active.test(entry))
  if (index >= 0) lines[index] = line
  else if (lines.length > 0 && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line)
  else lines.push(line)
  writeFileSync(path, lines.join('\n'))
}

// Removes any active assignment of KEY, leaving comments intact. Returns true when a line was
// removed.
export function removeEnvEntry(path: string, key: string): boolean {
  if (!existsSync(path)) return false
  const active = new RegExp(`^\\s*${key}\\s*=`)
  const lines = readFileSync(path, 'utf8').split('\n')
  const kept = lines.filter((entry) => entry.trimStart().startsWith('#') || !active.test(entry))
  if (kept.length === lines.length) return false
  writeFileSync(path, kept.join('\n'))
  return true
}
