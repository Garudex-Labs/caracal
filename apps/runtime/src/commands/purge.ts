// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal purge`: centralized cleanup for selectable targets across dev and runtime installs.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, relative } from 'node:path'
import pg from 'pg'
import { devSecretsHome } from '@caracalai/server-core'
import { authMaintenanceUrl, configuredAuthDatabaseName } from './authStore.ts'
import { defaultCaracalConfigDir } from '@caracalai/engine/runtime-config'
import {
  caracalBinaries as caracalBinariesCore,
  composeRun,
  installRuntimeAssets,
  listCaracalImages,
  removeFsPath,
  removeImages,
} from '@caracalai/engine'
import { CARACAL_REGISTRY, CARACAL_VERSION } from '../runtime/version.gen.ts'
import { runtimePaths } from '@caracalai/engine'
import { composeUnavailableReason, dockerComposeAvailable, resolvePaths } from './stack.ts'
import { showHelp } from './shared.ts'
import { style, SYMBOL, printError, printWarn, printStep, printSuccess, printHeader } from '../style.ts'

type TargetId = 'stack' | 'volumes' | 'logs' | 'config' | 'runtime' | 'secrets' | 'web' | 'cache' | 'images' | 'binary'

type GroupId = 'services' | 'state' | 'dev' | 'artifacts'

const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'services', label: 'Runtime services & data' },
  { id: 'state', label: 'Local install & operator state' },
  { id: 'dev', label: 'Developer artifacts (dev only)' },
  { id: 'artifacts', label: 'Cached images & binaries' },
]

const TARGET_GROUP: Record<TargetId, GroupId> = {
  stack: 'services',
  volumes: 'services',
  logs: 'services',
  config: 'state',
  runtime: 'state',
  secrets: 'state',
  web: 'state',
  cache: 'dev',
  images: 'artifacts',
  binary: 'artifacts',
}

interface Target {
  id: TargetId
  label: string
  describe: (ctx: PurgeContext) => string
  available: (ctx: PurgeContext) => boolean
  run: (ctx: PurgeContext) => Promise<void>
}

interface ComposeStack {
  label: string
  composeFile: string
  envFiles: string[]
  cwd: string
  secretsDir: string
}

interface PurgeContext {
  mode: 'dev' | 'rc' | 'stable'
  composeFile: string
  envFiles: string[]
  cwd: string
  stacks: ComposeStack[]
  configPath: string | undefined
  credentialDir: string | undefined
  runtimeHome: string
  repoRoot: string | undefined
  composeAvailable: boolean
  dryRun: boolean
}

interface SecretCleanupTarget {
  label: string
  path: string
}

function uniqueSecretTargets(ctx: PurgeContext): SecretCleanupTarget[] {
  const targets: SecretCleanupTarget[] = []
  const seen = new Set<string>()
  const add = (label: string, path: string | undefined) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    targets.push({ label, path })
  }
  for (const stack of ctx.stacks) {
    add(`${stack.label} operator secrets`, stack.secretsDir)
  }
  if (ctx.repoRoot) {
    add('dev operator secrets', devSecretsHome())
    add('legacy workspace secrets', join(ctx.repoRoot, 'infra/secrets/files'))
  }
  return targets
}

// The web console keeps its operator accounts and sessions in a dedicated PostgreSQL
// database owned by the auth backend-for-frontend. Purging the web console means dropping
// that database so no operator identity survives. The name is derived from an explicit
// CARACAL_AUTH_DATABASE_URL when configured, otherwise the dev default (caracal_auth).
function authDatabaseTarget(): { name: string; maintenanceUrl: string } | undefined {
  const maintenanceUrl = authMaintenanceUrl()
  if (!maintenanceUrl) return undefined
  return { name: configuredAuthDatabaseName(), maintenanceUrl }
}

// Dropping the database (rather than truncating tables) guarantees a clean slate even while
// `caracal web` is running: WITH FORCE terminates the auth service's live connections so the
// operator is logged out immediately, and the next launch recreates an empty database.
async function dropAuthDatabase(target: { name: string; maintenanceUrl: string }, ctx: PurgeContext, label: string): Promise<void> {
  if (ctx.dryRun) {
    process.stdout.write(`  ${style.label('[dry-run]')} drop database ${style.code(label)}: ${target.name}\n`)
    return
  }
  const client = new pg.Client({ connectionString: target.maintenanceUrl })
  try {
    await client.connect()
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target.name])
    if (existing.rowCount === 0) {
      process.stdout.write(`  ${style.label(`(skip) ${label}:`)} database ${target.name} not present\n`)
      return
    }
    await client.query(`DROP DATABASE "${target.name.replace(/"/g, '""')}" WITH (FORCE)`)
    process.stdout.write(`  ${style.success(SYMBOL.ok)} dropped ${style.code(label)}: database ${target.name}\n`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stdout.write(`  ${style.label(`(skip) ${label}:`)} ${message}\n`)
  } finally {
    await client.end().catch(() => {})
  }
}

function purgeHelp(): never {
  return showHelp([
    'Usage: caracal purge [targets...] [options]',
    '',
    'Centralized cleanup for selectable resources. Without targets, prompts interactively.',
    'Pass individual target names, a group name (selects the whole group), or "all".',
    '',
    'Runtime services & data (services):',
    '  stack       Stop and remove containers + network (compose down)',
    '  volumes     Remove data volumes: DESTROYS Postgres and Redis state',
    '  logs        Truncate container log files via `compose down` + recreate',
    '',
    'Local install & operator state (state):',
    '  config      Remove local SDK profile (caracal.toml) and stored workload client secrets',
    '  runtime     Remove runtime assets at $CARACAL_HOME (.env, compose.yml)',
    '  secrets     Remove operator overrides and generated secret files',
    '  web         Drop the web console operator database (PostgreSQL caracal_auth)',
    '',
    'Developer artifacts (dev) - dev only:',
    '  cache       Remove build artifacts: apps/*/dist, coverage/, node_modules/.cache',
    '',
    'Cached images & binaries (artifacts):',
    '  images      Remove cached Caracal docker images (caracal/*, ghcr.io/garudex-labs/caracal-*)',
    '  binary      Uninstall Caracal runtime and web console binaries from $CARACAL_INSTALL_DIR (default ~/.local/bin)',
    '',
    'Aggregate:',
    '  all         Purge every applicable target (destructive: wipes volumes, runtime, config, web, images, binary)',
    '',
    'Options:',
    '  --yes, -y                Skip confirmation prompt',
    '  --dry-run                Show what would be removed without doing it',
    '  --safe                   With `all`, skip destructive targets (volumes, runtime, secrets, web, …)',
    '  --help, -h               Show this help',
    '',
  ])
}

function buildContext(dryRun: boolean): PurgeContext {
  const paths = resolvePaths()
  const runtime = runtimePaths()
  const configDir = defaultCaracalConfigDir()
  const tomlPath = process.env.CARACAL_CONFIG ?? join(configDir, 'caracal.toml')
  const configPath = existsSync(tomlPath) ? tomlPath : undefined
  const storedSecretsDir = join(configDir, 'runtime')
  const credentialDir = existsSync(storedSecretsDir) ? storedSecretsDir : undefined
  const repoRoot = paths.mode === 'dev' ? paths.cwd : undefined
  const stacks: ComposeStack[] = [
    { label: paths.mode, composeFile: paths.composeFile, envFiles: paths.envFiles, cwd: paths.cwd, secretsDir: paths.secretsDir },
  ]
  if (paths.mode === 'dev' && existsSync(runtime.composeFile)) {
    stacks.push({
      label: 'runtime',
      composeFile: runtime.composeFile,
      envFiles: existsSync(runtime.overrideEnvFile) ? [runtime.overrideEnvFile] : paths.envFiles,
      cwd: runtime.home,
      secretsDir: runtime.secretsDir,
    })
  }
  return {
    mode: paths.mode,
    composeFile: paths.composeFile,
    envFiles: paths.envFiles,
    cwd: paths.cwd,
    stacks,
    configPath,
    credentialDir,
    runtimeHome: runtime.home,
    repoRoot,
    composeAvailable: dryRun || dockerComposeAvailable(),
    dryRun,
  }
}

async function runCompose(args: string[], ctx: PurgeContext, stack?: ComposeStack): Promise<number> {
  const s = stack ?? ctx.stacks[0]!
  if (ctx.dryRun) {
    process.stdout.write(`  ${style.label('[dry-run]')} docker compose ${style.code(`-f ${s.composeFile} ${args.join(' ')}`)}\n`)
    return 0
  }
  const env: Record<string, string | undefined> = {}
  if (!process.env.CARACAL_VERSION) env.CARACAL_VERSION = CARACAL_VERSION
  if (!process.env.CARACAL_REGISTRY) env.CARACAL_REGISTRY = CARACAL_REGISTRY
  const handle = composeRun({
    paths: { composeFile: s.composeFile, envFiles: s.envFiles, cwd: s.cwd, mode: ctx.mode, secretsDir: s.secretsDir },
    args,
    env,
  })
  return handle.exitCode
}

async function removeImagesStep(images: string[], ctx: PurgeContext): Promise<number> {
  if (ctx.dryRun) {
    for (const img of images) {
      process.stdout.write(`  ${style.label('[dry-run]')} docker image rm ${style.code(img)}\n`)
    }
    return 0
  }
  return removeImages(images)
}

async function runComposeAll(args: string[], ctx: PurgeContext): Promise<void> {
  for (const stack of ctx.stacks) {
    if (ctx.stacks.length > 1) {
      process.stdout.write(`  ${style.label(`[${stack.label}]`)} ${stack.composeFile}\n`)
    }
    const code = await runCompose(args, ctx, stack)
    if (code === 127) {
      throw new Error(`docker executable not found on PATH while running compose ${args.join(' ')} for ${stack.label} stack`)
    }
    if (code !== 0) throw new Error(`compose ${args.join(' ')} exited ${code} for ${stack.label} stack`)
  }
}

function removePath(path: string, ctx: PurgeContext, label: string): void {
  if (!existsSync(path)) {
    process.stdout.write(`  ${style.label(`(skip) ${label}:`)} ${path} ${style.label('- not present')}\n`)
    return
  }
  if (ctx.dryRun) {
    process.stdout.write(`  ${style.label('[dry-run]')} remove ${style.code(label)}: ${path}\n`)
    return
  }
  removeFsPath(path)
  process.stdout.write(`  ${style.success(SYMBOL.ok)} removed ${style.code(label)}: ${path}\n`)
}

function caracalBinariesPaths(): string[] {
  const installDir = process.env.CARACAL_INSTALL_DIR ?? join(homedir(), '.local', 'bin')
  const extra: string[] = []
  const pnpmGlobal = spawnSync('pnpm', ['bin', '-g'], { encoding: 'utf8' })
  if (pnpmGlobal.status === 0 && typeof pnpmGlobal.stdout === 'string') {
    const dir = pnpmGlobal.stdout.trim()
    if (dir) extra.push(dir)
  }
  return caracalBinariesCore(installDir, extra)
}

const TARGETS: Target[] = [
  {
    id: 'stack',
    label: 'Stop & remove containers',
    describe: (ctx) =>
      ctx.stacks.length > 1
        ? `compose down --remove-orphans across ${ctx.stacks.length} projects (${ctx.stacks.map((s) => s.label).join(', ')})`
        : `compose down --remove-orphans (${ctx.stacks[0]!.label} stack)`,
    available: (ctx) => ctx.composeAvailable,
    run: async (ctx) => {
      await runComposeAll(['down', '--remove-orphans'], ctx)
    },
  },
  {
    id: 'volumes',
    label: 'Remove data volumes (DESTRUCTIVE)',
    describe: (ctx) =>
      ctx.stacks.length > 1
        ? `compose down -v --remove-orphans across ${ctx.stacks.length} projects: wipes all Caracal data`
        : 'compose down -v --remove-orphans: wipes Postgres and Redis volumes',
    available: (ctx) => ctx.composeAvailable,
    run: async (ctx) => {
      await runComposeAll(['down', '-v', '--remove-orphans'], ctx)
    },
  },
  {
    id: 'logs',
    label: 'Truncate container logs',
    describe: () => 'compose down (without -v) drops log files; restart with `caracal up`',
    available: (ctx) => ctx.composeAvailable,
    run: async (ctx) => {
      await runComposeAll(['down', '--remove-orphans'], ctx)
    },
  },
  {
    id: 'config',
    label: 'Remove local config and workload client secrets',
    describe: (ctx) => [ctx.configPath, ctx.credentialDir].filter(Boolean).join(', ') || '(no local config found)',
    available: (ctx) => ctx.configPath !== undefined || ctx.credentialDir !== undefined,
    run: async (ctx) => {
      if (ctx.configPath) removePath(ctx.configPath, ctx, 'config')
      if (ctx.credentialDir) removePath(ctx.credentialDir, ctx, 'config')
    },
  },
  {
    id: 'runtime',
    label: 'Remove runtime assets (DESTRUCTIVE)',
    describe: (ctx) => `${ctx.runtimeHome}: bundled compose.yml, .env, provision script`,
    available: (ctx) => existsSync(ctx.runtimeHome),
    run: async (ctx) => {
      removePath(ctx.runtimeHome, ctx, 'runtime')
    },
  },
  {
    id: 'secrets',
    label: 'Remove operator overrides and secret files (DESTRUCTIVE)',
    describe: (ctx) => {
      const paths = uniqueSecretTargets(ctx).map((target) => target.path)
      if (ctx.repoRoot) paths.unshift(join(ctx.repoRoot, 'infra/docker/local.env'))
      return paths.length > 0 ? paths.join(', ') : '(no operator secret paths resolved)'
    },
    available: (ctx) => uniqueSecretTargets(ctx).length > 0 || ctx.repoRoot !== undefined,
    run: async (ctx) => {
      if (ctx.repoRoot) removePath(join(ctx.repoRoot, 'infra/docker/local.env'), ctx, 'infra/docker/local.env')
      for (const target of uniqueSecretTargets(ctx)) {
        removePath(target.path, ctx, target.label)
      }
    },
  },
  {
    id: 'web',
    label: 'Remove web console accounts & sessions (DESTRUCTIVE)',
    describe: () => {
      const target = authDatabaseTarget()
      return target
        ? `Drop PostgreSQL database "${target.name}": web console operator accounts and sessions`
        : '(no web console database reachable)'
    },
    available: () => authDatabaseTarget() !== undefined,
    run: async (ctx) => {
      const target = authDatabaseTarget()
      if (target) await dropAuthDatabase(target, ctx, 'web/auth')
    },
  },
  {
    id: 'cache',
    label: 'Remove build artifacts (dev only)',
    describe: (ctx) => (ctx.repoRoot ? `all dist/ under apps/ and packages/, coverage/, node_modules/.cache` : '(dev mode only)'),
    available: (ctx) => ctx.repoRoot !== undefined,
    run: async (ctx) => {
      if (!ctx.repoRoot) return
      const root = ctx.repoRoot
      for (const sub of ['coverage', 'node_modules/.cache', '.turbo']) {
        removePath(join(root, sub), ctx, sub)
      }
      const findDist = (dir: string, depth: number): string[] => {
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return []
        }
        const found: string[] = []
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === 'node_modules') continue
          const child = join(dir, entry.name)
          if (entry.name === 'dist') found.push(child)
          else if (depth > 1) found.push(...findDist(child, depth - 1))
        }
        return found
      }
      for (const group of ['apps', 'packages']) {
        const base = join(root, group)
        for (const dist of findDist(base, 4)) {
          removePath(dist, ctx, relative(root, dist))
        }
      }
    },
  },
  {
    id: 'images',
    label: 'Remove Caracal docker images (DESTRUCTIVE)',
    describe: () => {
      const imgs = listCaracalImages()
      if (imgs.length === 0) return '(no caracal images cached)'
      return `${imgs.length} image(s): ${imgs.slice(0, 3).join(', ')}${imgs.length > 3 ? ', …' : ''}`
    },
    available: () => listCaracalImages().length > 0,
    run: async (ctx) => {
      const imgs = listCaracalImages()
      if (imgs.length === 0) {
        process.stdout.write(`  ${style.label('(skip) images: none cached')}\n`)
        return
      }
      const code = await removeImagesStep(imgs, ctx)
      if (code !== 0) throw new Error(`docker image rm exited ${code}`)
    },
  },
  {
    id: 'binary',
    label: 'Uninstall Caracal binaries (DESTRUCTIVE)',
    describe: () => {
      const found = caracalBinariesPaths()
      if (found.length === 0) return '(no caracal binaries on $PATH)'
      return found.join(', ')
    },
    available: () => caracalBinariesPaths().length > 0,
    run: async (ctx) => {
      for (const bin of caracalBinariesPaths()) {
        removePath(bin, ctx, `bin/${bin.split('/').pop()}`)
      }
    },
  },
]

function targetById(id: string): Target | undefined {
  return TARGETS.find((t) => t.id === id)
}

function requiresCompose(t: Target): boolean {
  return t.id === 'stack' || t.id === 'volumes' || t.id === 'logs'
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolveAnswer) => {
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      rl.close()
      resolveAnswer(value)
    }
    rl.question(question, (answer) => finish(answer.trim()))
    rl.once('close', () => finish(''))
  })
}

async function selectInteractively(ctx: PurgeContext): Promise<Target[]> {
  const usable = TARGETS.filter((t) => t.available(ctx))
  printHeader('Select purge targets')
  if (!ctx.composeAvailable) {
    printWarn(`Docker Compose unavailable; stack, volumes, and logs are hidden. ${composeUnavailableReason()}.`)
  }
  process.stdout.write(
    style.label(
      'Enter comma-separated numbers (e.g. "1,4"), a group name to select it whole, "all" for full reset, "safe" to skip destructive, or "q" to quit.\n',
    ),
  )
  // Render targets grouped by component area, preserving the flat selection
  // index so a typed number always maps to usable[n - 1].
  for (const group of GROUPS) {
    const inGroup = usable.filter((t) => TARGET_GROUP[t.id] === group.id)
    if (inGroup.length === 0) continue
    process.stdout.write(`\n${style.header(group.label)} ${style.label(`(${group.id})`)}\n`)
    for (const t of inGroup) {
      const i = usable.indexOf(t)
      const labelStr = isDestructive(t) ? style.warn(t.label) : t.label
      process.stdout.write(`  ${style.title(`${i + 1}.`)} ${labelStr} ${style.label(`- ${t.describe(ctx)}`)}\n`)
    }
  }
  const answer = (await prompt(`\n${style.prompt('> ')}`)).toLowerCase()
  if (answer === '' || answer === 'q') return []
  if (answer === 'all') return usable
  if (answer === 'safe') return usable.filter((t) => !isDestructive(t))

  const selected: Target[] = []
  const seen = new Set<TargetId>()
  const addTarget = (t: Target) => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    selected.push(t)
  }
  for (const raw of answer.split(',')) {
    const token = raw.trim()
    if (!token) continue
    const group = GROUPS.find((g) => g.id === token)
    if (group) {
      const inGroup = usable.filter((t) => TARGET_GROUP[t.id] === group.id)
      if (inGroup.length === 0) {
        printError(`no available targets in group "${token}"`)
        process.exit(1)
      }
      inGroup.forEach(addTarget)
      continue
    }
    const n = parseInt(token, 10)
    if (!Number.isInteger(n) || n < 1 || n > usable.length) {
      printError(`invalid selection: ${token}`)
      process.exit(1)
    }
    addTarget(usable[n - 1]!)
  }
  return selected
}

function isDestructive(t: Target): boolean {
  return (
    t.id === 'volumes' ||
    t.id === 'runtime' ||
    t.id === 'secrets' ||
    t.id === 'web' ||
    t.id === 'config' ||
    t.id === 'images' ||
    t.id === 'binary'
  )
}

function expandAll(safe: boolean): Target[] {
  if (safe) return TARGETS.filter((t) => !isDestructive(t))
  return [...TARGETS]
}

export async function purgeCommand(argv: string[]): Promise<void> {
  let yes = false
  let dryRun = false
  let safe = false
  const requested: string[] = []

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') purgeHelp()
    else if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--safe') safe = true
    else if (arg.startsWith('--')) {
      printError(`unknown flag ${arg}`)
      process.exit(1)
    } else {
      requested.push(arg)
    }
  }

  const ctx = buildContext(dryRun)

  let targets: Target[]
  if (requested.length === 0) {
    targets = await selectInteractively(ctx)
    if (targets.length === 0) {
      process.stdout.write(style.label('Nothing selected.\n'))
      return
    }
  } else if (requested.includes('all')) {
    targets = expandAll(safe).filter((t) => t.available(ctx))
    if (!ctx.composeAvailable) {
      printWarn(`Docker Compose unavailable; skipping stack, volumes, and logs. ${composeUnavailableReason()}.`)
    }
  } else {
    targets = []
    for (const name of requested) {
      const t = targetById(name)
      if (!t) {
        printError(`unknown target "${name}"; run \`caracal purge --help\``)
        process.exit(1)
      }
      if (!t.available(ctx) && requiresCompose(t)) {
        printError(`${t.id} unavailable: ${composeUnavailableReason()}`)
        process.exit(1)
      } else if (!t.available(ctx)) {
        process.stdout.write(`  ${style.label(`(skip) ${t.id}: not applicable in ${ctx.mode} mode`)}\n`)
        continue
      }
      targets.push(t)
    }
    if (targets.length === 0) {
      process.stdout.write(style.label('Nothing to purge.\n'))
      return
    }
  }

  printHeader(`Caracal purge: ${ctx.mode} mode${dryRun ? ' (dry-run)' : ''}`)
  process.stdout.write(style.label('Will purge:\n'))
  for (const t of targets) {
    const labelStr = isDestructive(t) ? style.warn(t.label) : t.label
    process.stdout.write(`  ${style.label(SYMBOL.bullet)} ${labelStr} ${style.label(`- ${t.describe(ctx)}`)}\n`)
  }
  const destructive = targets.some(isDestructive)
  if (destructive && !dryRun) {
    process.stdout.write('\n')
    printWarn('Destructive targets selected: data WILL be lost.')
  }

  if (!yes && !dryRun) {
    const q = destructive ? `\n${style.prompt('Type "yes" to confirm:')} ` : `\n${style.prompt('Proceed?')} ${style.label('[y/N]')} `
    const answer = await prompt(q)
    const ok = destructive ? answer === 'yes' : /^y(es)?$/i.test(answer)
    if (!ok) {
      printWarn('Aborted.')
      return
    }
  }

  const targetIds = new Set(targets.map((t) => t.id))
  if (
    !dryRun &&
    targetIds.has('runtime') &&
    (targetIds.has('stack') || targetIds.has('volumes') || targetIds.has('logs')) &&
    ctx.stacks.some((s) => s.label === 'runtime')
  ) {
    installRuntimeAssets(runtimePaths(ctx.runtimeHome), 'stable')
  }

  for (const t of targets) {
    process.stdout.write('\n')
    printStep(t.label)
    try {
      await t.run(ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      printError(`${t.id} failed: ${msg}`)
      process.exit(1)
    }
  }
  process.stdout.write('\n')
  if (dryRun) {
    printSuccess('Dry-run complete.')
  } else {
    printSuccess('Purge complete.')
  }
}
