// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Installed stack helpers: locate $CARACAL_HOME, install bundled assets, and guard the runtime version lifecycle.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { COMPOSE_YML } from './embedded.js'
import { bootstrapSecrets, runtimeBootstrapPaths } from './secrets.js'
import { renderOperatorTemplate } from './envRender.js'
import type { StackMode } from './stackPaths.js'

export interface RuntimePaths {
  home: string
  composeFile: string
  secretsDir: string
  // Operator override file. Generated as a fully commented template on first
  // install and never overwritten if it already exists.
  overrideEnvFile: string
}

function defaultRuntimeHome(): string {
  if (process.env.CARACAL_HOME) return process.env.CARACAL_HOME
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.length > 0) return join(xdg, 'caracal')
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'caracal')
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'caracal')
  return join(homedir(), '.local', 'share', 'caracal')
}

export function runtimePaths(home: string = defaultRuntimeHome()): RuntimePaths {
  return {
    home,
    composeFile: join(home, 'compose.yml'),
    secretsDir: process.env.CARACAL_SECRETS_DIR ?? join(home, 'secrets'),
    overrideEnvFile: join(home, 'caracal.env'),
  }
}

export interface InstallReport {
  created: boolean
  filesCreated: string[]
}

const STATE_FILE = 'runtime.json'
const LOCK_FILE = '.lock'
const UPGRADE_LOG = 'upgrade.log'

// Orders Caracal release versions: dot-separated numeric parts with an optional
// `-rc.N` suffix, where a stable release outranks its release candidates.
export function compareCaracalVersions(a: string, b: string): number {
  const parse = (value: string): { core: number[]; rc: number } => {
    const [core, rc] = value.replace(/^v/, '').split('-rc.')
    return {
      core: core.split('.').map((part) => Number(part) || 0),
      rc: rc === undefined ? Number.POSITIVE_INFINITY : Number(rc) || 0,
    }
  }
  const va = parse(a)
  const vb = parse(b)
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const diff = (va.core[i] ?? 0) - (vb.core[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (va.rc === vb.rc) return 0
  return va.rc < vb.rc ? -1 : 1
}

export class RuntimeDowngradeError extends Error {
  constructor(
    public readonly home: string,
    public readonly installed: string,
    public readonly binary: string,
  ) {
    super(
      `runtime assets at ${home} belong to Caracal ${installed}; this binary is ${binary} (older). ` +
        `Install the ${installed} or newer release, or remove ${join(home, STATE_FILE)} to roll back deliberately.`,
    )
    this.name = 'RuntimeDowngradeError'
  }
}

// The version that last installed runtime assets under this home. A missing or
// unreadable marker disables the guard rather than blocking the stack.
export function readRuntimeVersion(home: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(home, STATE_FILE), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined
  } catch {
    return undefined
  }
}

export function installRuntimeAssets(paths: RuntimePaths = runtimePaths(), mode: StackMode = 'stable', version?: string): InstallReport {
  const installed = version === undefined ? undefined : readRuntimeVersion(paths.home)
  if (version !== undefined && installed !== undefined && compareCaracalVersions(version, installed) < 0) {
    throw new RuntimeDowngradeError(paths.home, installed, version)
  }
  mkdirSync(paths.home, { recursive: true })
  // Operator trust directory for the STS extra-CA mount: dropping a PEM at
  // ca/extra-ca.pem lets the stack trust internal-PKI Federated user issuers and
  // provider endpoints. It ships empty; an absent bundle changes nothing.
  mkdirSync(join(paths.home, 'ca'), { recursive: true })
  let created = false

  let existingCompose: string | null = null
  try {
    existingCompose = readFileSync(paths.composeFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (existingCompose !== COMPOSE_YML) {
    writeFileSync(paths.composeFile, COMPOSE_YML, { mode: 0o644 })
    created = true
  }

  // Only seed the override template if missing; never clobber operator edits.
  try {
    writeFileSync(paths.overrideEnvFile, renderOperatorTemplate(mode), { mode: 0o600, flag: 'wx' })
    created = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    try {
      chmodSync(paths.overrideEnvFile, 0o600)
    } catch {
      /* perms may be unsupported */
    }
  }

  const report = bootstrapSecrets({ ...runtimeBootstrapPaths(paths.home), secretsDir: paths.secretsDir })
  if (report.filesCreated.length > 0) created = true

  if (version !== undefined && installed !== version) {
    const state = JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2)
    writeFileSync(join(paths.home, STATE_FILE), `${state}\n`, { mode: 0o644 })
  }

  return { created, filesCreated: report.filesCreated }
}

export class StackLockError extends Error {
  constructor(
    public readonly home: string,
    public readonly pid: number,
  ) {
    super(
      `another caracal stack command is already running (pid ${pid}); ` +
        `wait for it to finish, or remove ${join(home, LOCK_FILE)} if it crashed`,
    )
    this.name = 'StackLockError'
  }
}

function lockHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Serializes stack mutations (up, down, upgrade) on one host. A lock whose
// holder no longer runs is stale (crash or power loss) and is taken over.
export function acquireStackLock(home: string): () => void {
  mkdirSync(home, { recursive: true })
  const path = join(home, LOCK_FILE)
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const holder = lockHolder(path)
    if (holder !== undefined && pidAlive(holder)) {
      throw new StackLockError(home, holder)
    }
    writeFileSync(path, `${process.pid}\n`)
  }
  return () => {
    try {
      rmSync(path, { force: true })
    } catch {
      /* lock removal must never mask the command result */
    }
  }
}

export type UpgradeOutcome = 'success' | 'stageFailed' | 'migrationFailed' | 'rollFailed' | 'readinessFailed'

export interface UpgradeRecord {
  at: string
  from?: string
  to: string
  outcome: UpgradeOutcome
}

// Appends a durable upgrade record to $CARACAL_HOME/upgrade.log (JSON lines).
export function appendUpgradeRecord(home: string, record: Omit<UpgradeRecord, 'at'>): void {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, UPGRADE_LOG), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
  } catch {
    /* the journal must never block an upgrade */
  }
}
