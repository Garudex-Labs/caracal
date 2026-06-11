// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// `caracal purge`: centralized cleanup for selectable targets across dev and runtime installs.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join, relative } from 'node:path'
import { devSecretsHome } from '@caracalai/core'
import { resolveRuntimeConfigPath } from '@caracalai/engine/runtime-config'
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
import {
  style,
  SYMBOL,
  printError,
  printWarn,
  printStep,
  printSuccess,
  printHeader,
} from '../style.ts'

type TargetId = 'stack' | 'volumes' | 'logs' | 'config' | 'runtime' | 'secrets' | 'cache' | 'examples' | 'images' | 'binary'

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
  includeControlProfile?: boolean
}

interface PurgeContext {
  mode: 'dev' | 'rc' | 'stable'
  composeFile: string
  envFiles: string[]
  cwd: string
  stacks: ComposeStack[]
  configPath: string | undefined
  runtimeHome: string
  repoRoot: string | undefined
  composeAvailable: boolean
  dryRun: boolean
}

interface SecretCleanupTarget {
  label: string
  path: string
}

const EXAMPLE_COMPOSE_FILES = new Set(['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'])
const EXAMPLE_COMPOSE_IGNORED_DIRS = new Set(['node_modules', '.venv', 'dist', 'coverage'])

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

function purgeHelp(): never {
  return showHelp(
    [
      'Usage: caracal purge [targets...] [options]',
      '',
      'Centralized cleanup for selectable resources. Without targets, prompts interactively.',
      '',
      'Targets:',
      '  stack       Stop and remove containers + network (compose down)',
      '  volumes     Remove data volumes: DESTROYS Postgres and Redis state',
      '  logs        Truncate container log files via `compose down` + recreate',
      '  config      Remove caracal.toml (zone client secret and config)',
      '  runtime     Remove runtime assets at $CARACAL_HOME (.env, compose.yml)',
      '  secrets     Remove operator overrides and generated secret files',
      '  cache       Remove build artifacts: apps/*/dist, coverage/, node_modules/.cache (dev only)',
      '  examples    Remove example containers, volumes, networks, and example-built images (dev only)',
      '  images      Remove cached Caracal docker images (caracal/*, ghcr.io/garudex-labs/caracal-*)',
      '  binary      Uninstall Caracal runtime and Console binaries from $CARACAL_INSTALL_DIR (default ~/.local/bin)',
      '  all         Purge every applicable target (destructive: wipes volumes, runtime, config, examples, images, binary)',
      '',
      'Options:',
      '  --yes, -y                Skip confirmation prompt',
      '  --dry-run                Show what would be removed without doing it',
      '  --safe                   With `all`, skip destructive targets (volumes, runtime)',
      '  --help, -h               Show this help',
      '',
    ],
  )
}

function buildContext(dryRun: boolean): PurgeContext {
  const paths = resolvePaths()
  const runtime = runtimePaths()
  const configPath = resolveRuntimeConfigPath()
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
    runtimeHome: runtime.home,
    repoRoot,
    composeAvailable: dryRun || dockerComposeAvailable(),
    dryRun,
  }
}

function collectExampleComposeFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && !EXAMPLE_COMPOSE_IGNORED_DIRS.has(entry.name)) {
      found.push(...collectExampleComposeFiles(path))
    } else if (entry.isFile() && EXAMPLE_COMPOSE_FILES.has(entry.name)) {
      found.push(path)
    }
  }
  return found
}

function exampleComposeStacks(ctx: PurgeContext): ComposeStack[] {
  if (!ctx.repoRoot) return []
  const repoRoot = ctx.repoRoot
  const root = join(ctx.repoRoot, 'examples')
  if (!existsSync(root)) return []
  return collectExampleComposeFiles(root).map((composeFile) => ({
    label: relative(repoRoot, composeFile),
    composeFile,
    envFiles: [],
    cwd: dirname(composeFile),
    secretsDir: ctx.cwd,
    includeControlProfile: false,
  }))
}

function exampleBuiltImagesFromCompose(composeFile: string): string[] {
  const images: string[] = []
  let image: string | undefined
  let build = false
  const flush = () => {
    if (build && image) images.push(image)
    image = undefined
    build = false
  }
  for (const line of readFileSync(composeFile, 'utf8').split(/\r?\n/)) {
    if (/^  [A-Za-z0-9_.-]+:\s*(?:#.*)?$/.test(line)) {
      flush()
      continue
    }
    const imageMatch = line.match(/^\s{4}image:\s*['"]?([^'"\s#]+)['"]?/)
    if (imageMatch) image = imageMatch[1]
    if (/^\s{4}build:\s*/.test(line)) build = true
  }
  flush()
  return images
}

function exampleImageNames(ctx: PurgeContext): string[] {
  return Array.from(new Set(exampleComposeStacks(ctx).flatMap((stack) => exampleBuiltImagesFromCompose(stack.composeFile))))
}

function listDockerImagesByName(names: readonly string[]): string[] {
  const wanted = new Set(names)
  const out = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
  if (out.status !== 0 || typeof out.stdout !== 'string') return []
  return out.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => wanted.has(s))
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
    includeControlProfile: s.includeControlProfile,
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

async function runComposeAll(args: string[], ctx: PurgeContext, stacks = ctx.stacks): Promise<void> {
  for (const stack of stacks) {
    if (stacks.length > 1) {
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
    label: 'Remove caracal.toml',
    describe: (ctx) => ctx.configPath ?? '(no caracal.toml found)',
    available: (ctx) => ctx.configPath !== undefined,
    run: async (ctx) => {
      if (ctx.configPath) removePath(ctx.configPath, ctx, 'config')
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
    id: 'cache',
    label: 'Remove build artifacts (dev only)',
    describe: (ctx) =>
      ctx.repoRoot ? `apps/*/dist, packages/*/dist, coverage/, node_modules/.cache` : '(dev mode only)',
    available: (ctx) => ctx.repoRoot !== undefined,
    run: async (ctx) => {
      if (!ctx.repoRoot) return
      const root = ctx.repoRoot
      for (const sub of ['coverage', 'node_modules/.cache', '.turbo']) {
        removePath(join(root, sub), ctx, sub)
      }
      for (const group of ['apps', 'packages']) {
        const base = join(root, group)
        if (!existsSync(base)) continue
        for (const name of readdirSync(base)) {
          const child = join(base, name)
          try {
            if (!statSync(child).isDirectory()) continue
          } catch {
            continue
          }
          removePath(join(child, 'dist'), ctx, `${group}/${name}/dist`)
        }
      }
    },
  },
  {
    id: 'examples',
    label: 'Remove example containers, volumes, and images (DESTRUCTIVE)',
    describe: (ctx) => {
      const stacks = exampleComposeStacks(ctx)
      const imgs = listDockerImagesByName(exampleImageNames(ctx))
      const imageSummary = imgs.length > 0 ? `; ${imgs.length} example image(s)` : ''
      return stacks.length > 0
        ? `${stacks.length} compose project(s) under examples/${imageSummary}`
        : '(dev mode only; no example compose projects found)'
    },
    available: (ctx) => ctx.composeAvailable && exampleComposeStacks(ctx).length > 0,
    run: async (ctx) => {
      const stacks = exampleComposeStacks(ctx)
      await runComposeAll(['down', '-v', '--remove-orphans'], ctx, stacks)
      const imgs = listDockerImagesByName(exampleImageNames(ctx))
      if (imgs.length === 0) {
        process.stdout.write(`  ${style.label('(skip) example images: none cached')}\n`)
        return
      }
      const code = await removeImagesStep(imgs, ctx)
      if (code !== 0) throw new Error(`docker image rm exited ${code}`)
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
  return t.id === 'stack' || t.id === 'volumes' || t.id === 'logs' || t.id === 'examples'
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
    printWarn(`Docker Compose unavailable; stack, volumes, logs, and examples are hidden. ${composeUnavailableReason()}.`)
  }
  process.stdout.write(style.label('Enter comma-separated numbers, "all" for full reset, "safe" to skip destructive, or "q" to quit.\n'))
  usable.forEach((t, i) => {
    const destructive = isDestructive(t)
    const labelStr = destructive ? style.warn(t.label) : t.label
    process.stdout.write(`  ${style.title(`${i + 1}.`)} ${labelStr} ${style.label(`- ${t.describe(ctx)}`)}\n`)
  })
  const answer = (await prompt(style.prompt('> '))).toLowerCase()
  if (answer === '' || answer === 'q') return []
  if (answer === 'all') return usable
  if (answer === 'safe') return usable.filter((t) => !isDestructive(t))
  const picks = answer.split(',').map((s) => parseInt(s.trim(), 10))
  const selected: Target[] = []
  for (const n of picks) {
    if (!Number.isInteger(n) || n < 1 || n > usable.length) {
      printError(`invalid selection: ${n}`)
      process.exit(1)
    }
    selected.push(usable[n - 1]!)
  }
  return selected
}

function isDestructive(t: Target): boolean {
  return t.id === 'volumes' || t.id === 'runtime' || t.id === 'secrets' || t.id === 'config' || t.id === 'examples' || t.id === 'images' || t.id === 'binary'
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
      printWarn(`Docker Compose unavailable; skipping stack, volumes, logs, and examples. ${composeUnavailableReason()}.`)
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
    const q = destructive
      ? `\n${style.prompt('Type "yes" to confirm:')} `
      : `\n${style.prompt('Proceed?')} ${style.label('[y/N]')} `
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
