#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Release-candidate workflow for production-like artifact validation.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateFileName = '.caracalRcState.json'

const npmPaths = [
  'packages/core/ts',
  'packages/oauth/ts',
  'packages/admin/ts',
  'packages/identity/ts',
  'packages/revocation/ts',
  'packages/sdk/ts',
  'packages/transport/mcp/ts',
  'packages/transport/a2a/ts',
  'packages/connectors/express/ts',
  'packages/connectors/fastmcp/ts',
  'packages/connectors/postgres/ts',
  'packages/connectors/redis/ts',
]

const pyPaths = [
  'packages/core/python',
  'packages/identity/python',
  'packages/revocation/python',
  'packages/sdk/python',
  'packages/transport/mcp/python',
  'packages/connectors/fastmcp/python',
  'packages/connectors/redis/python',
]

const containers = ['api', 'coordinator', 'audit', 'gateway', 'sts', 'postgres', 'redis']

function die(message) {
  process.stderr.write(`rc: ${message}\n`)
  process.exit(1)
}

function say(message = '') {
  process.stdout.write(`${message}\n`)
}

function parseArgs(argv) {
  const args = { command: argv[0], values: {}, flags: new Set() }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) die(`unexpected positional argument: ${arg}`)
    const key = arg.slice(2)
    if (['base-version', 'consumer', 'manifest', 'npm-registry', 'pypi-index', 'oci-registry', 'github-release-base', 'suffix'].includes(key)) {
      args.values[key] = argv[++i]
      if (!args.values[key]) die(`--${key} requires a value`)
    } else {
      args.flags.add(key)
    }
  }
  return args
}

function shortSha() {
  if (process.env.CARACAL_RC_SHA) return process.env.CARACAL_RC_SHA
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function dirtyTree() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function currentCalVer() {
  const date = new Date()
  return `${date.getUTCFullYear()}.${`${date.getUTCMonth() + 1}`.padStart(2, '0')}.${`${date.getUTCDate()}`.padStart(2, '0')}`
}

function cleanBase(version) {
  if (/([+-]dev\.|-dev\.sha|-rc\.|rc\d+)/i.test(version)) die(`base version is already suffixed: ${version}`)
  return version
}

function rcSuffix(options) {
  return options.suffix ?? process.env.CARACAL_RC_SUFFIX ?? `rc.sha${shortSha()}`
}

function npmRcVersion(version, suffix) {
  return `${cleanBase(version)}-${suffix}`
}

function pythonRcVersion(version, suffix) {
  const base = cleanBase(version)
  const numeric = suffix.match(/^rc\.([0-9]+)$/)?.[1]
  const sha = suffix.match(/^rc\.sha([A-Za-z0-9]+)$/)?.[1]
  if (numeric) return `${base}rc${numeric}`
  if (sha) return `${base}rc0+sha${sha}`
  die(`unsupported Python rc suffix: ${suffix}; use rc.<number> or rc.sha<gitsha>`)
}

function readPackageVersions(paths) {
  return Object.fromEntries(paths.map((path) => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8'))
    if (!pkg.name || !pkg.version) die(`missing name or version in ${path}/package.json`)
    return [pkg.name, cleanBase(pkg.version)]
  }))
}

function readPythonVersions(paths) {
  return Object.fromEntries(paths.map((path) => {
    const text = readFileSync(join(repoRoot, path, 'pyproject.toml'), 'utf8')
    const name = text.match(/^name = "([^"]+)"/m)?.[1]
    const version = text.match(/^version = "([^"]+)"/m)?.[1]
    if (!name || !version) die(`missing name or version in ${path}/pyproject.toml`)
    return [name, cleanBase(version)]
  }))
}

function registries(options) {
  return {
    npm: options['npm-registry'] ?? process.env.CARACAL_RC_NPM_REGISTRY ?? 'https://registry.npmjs.org/',
    pypi: options['pypi-index'] ?? process.env.CARACAL_RC_PYPI_INDEX ?? 'https://pypi.org/simple/',
    oci: options['oci-registry'] ?? process.env.CARACAL_RC_OCI_REGISTRY ?? 'ghcr.io/garudex-labs',
    githubReleases: options['github-release-base'] ?? process.env.CARACAL_RC_GITHUB_RELEASE_BASE ?? 'https://github.com/Garudex-Labs/caracal/releases/download',
  }
}

function makeManifest(options = {}) {
  const sha = shortSha()
  const suffix = rcSuffix(options)
  const baseVersion = cleanBase(options['base-version'] ?? process.env.CARACAL_RC_BASE_VERSION ?? currentCalVer())
  const version = `${baseVersion}-${suffix}`
  const tag = `v${version}`
  const npm = Object.fromEntries(Object.entries(readPackageVersions(npmPaths)).map(([name, base]) => [name, npmRcVersion(base, suffix)]))
  const pypi = Object.fromEntries(Object.entries(readPythonVersions(pyPaths)).map(([name, base]) => [name, pythonRcVersion(base, suffix)]))
  const reg = registries(options)
  return {
    release: tag,
    channel: 'rc',
    version,
    baseVersion,
    suffix,
    sha,
    generatedAt: new Date().toISOString(),
    source: {
      gitSha: sha,
      dirty: Boolean(dirtyTree()),
    },
    registries: reg,
    binaries: { cli: version, tui: version },
    containers: Object.fromEntries(containers.map((name) => [name, version])),
    images: Object.fromEntries(containers.map((name) => [name, `${reg.oci.replace(/\/$/, '')}/caracal-${name}:v${version}`])),
    npm,
    pypi,
    githubRelease: {
      prerelease: true,
      tag,
      assets: `${reg.githubReleases.replace(/\/$/, '')}/${tag}`,
    },
  }
}

function manifestPath(manifest) {
  return join(repoRoot, 'releases', manifest.release, 'manifest.json')
}

function writeManifest(manifest) {
  const path = manifestPath(manifest)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

function loadManifest(pathOrTag) {
  if (pathOrTag) {
    const path = pathOrTag.endsWith('.json') ? resolve(pathOrTag) : join(repoRoot, 'releases', pathOrTag, 'manifest.json')
    if (!existsSync(path)) die(`manifest not found: ${path}`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  const root = join(repoRoot, 'releases')
  if (!existsSync(root)) die('no rc manifest found; run scripts/rc.sh version first')
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /-rc\./.test(entry.name) && existsSync(join(root, entry.name, 'manifest.json')))
    .map((entry) => ({ name: entry.name, time: statSync(join(root, entry.name, 'manifest.json')).mtimeMs }))
    .sort((a, b) => a.time - b.time)
  if (!entries.length) die('no rc manifest found; run scripts/rc.sh version first')
  return JSON.parse(readFileSync(join(root, entries.at(-1).name, 'manifest.json'), 'utf8'))
}

function rewritePackageJson(path, versions) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  if (versions[pkg.name]) pkg.version = versions[pkg.name]
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    if (!pkg[field]) continue
    for (const name of Object.keys(pkg[field])) {
      if (versions[name]) pkg[field][name] = versions[name]
    }
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

function rewritePyproject(path, versions) {
  let text = readFileSync(path, 'utf8')
  const name = text.match(/^name = "([^"]+)"/m)?.[1]
  if (name && versions[name]) text = text.replace(/^version = "[^"]+"/m, `version = "${versions[name]}"`)
  text = text.replace(/"(?<name>caracalai-[a-z0-9-]+)(?<spec>[^"]*)"/g, (match, pkgName) => {
    if (!versions[pkgName]) return match
    return `"${pkgName}==${versions[pkgName]}"`
  })
  writeFileSync(path, text)
}

function updateConsumerPackageJson(path, versions) {
  if (!existsSync(path)) return false
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  let changed = false
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkg[field]) continue
    for (const [name, version] of Object.entries(versions)) {
      if (pkg[field][name]) {
        pkg[field][name] = version
        changed = true
      }
    }
  }
  if (changed) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  return changed
}

function updateConsumerPython(path, versions) {
  if (!existsSync(path)) return false
  let text = readFileSync(path, 'utf8')
  const original = text
  for (const [name, version] of Object.entries(versions)) {
    text = text.replace(new RegExp(`"${name}[^"]*"`, 'g'), `"${name}==${version}"`)
    text = text.replace(new RegExp(`^${name}[^\\s\\\\;]*(.*)$`, 'gm'), `${name}==${version}$1`)
  }
  if (text !== original) writeFileSync(path, text)
  return text !== original
}

function updateConsumerCompose(path, images) {
  if (!existsSync(path)) return false
  let text = readFileSync(path, 'utf8')
  const original = text
  for (const [name, image] of Object.entries(images)) {
    text = text.replace(new RegExp(`([\\w./:-]*/)?caracal-${name}:v?[A-Za-z0-9_.+-]+`, 'g'), image)
  }
  if (text !== original) writeFileSync(path, text)
  return text !== original
}

function replaceManagedBlock(text, name, body) {
  const start = `# caracal-rc:${name}:start`
  const end = `# caracal-rc:${name}:end`
  const block = body ? `${start}\n${body.trim()}\n${end}\n` : ''
  const pattern = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, 'm')
  if (pattern.test(text)) return text.replace(pattern, block ? `\n${block}` : '\n')
  return block ? `${text.replace(/\s*$/, '\n')}\n${block}` : text
}

function consumerFiles(consumer) {
  return [
    'package.json',
    '.npmrc',
    'pyproject.toml',
    'requirements.txt',
    'requirements.lock',
    'compose.yaml',
    'docker-compose.yml',
    'caracal.rc.env',
    '.gitignore',
  ].map((file) => join(consumer, file)).filter((file) => existsSync(file))
}

function touchGitignore(consumer) {
  const path = join(consumer, '.gitignore')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (text.split(/\r?\n/).includes(stateFileName)) return
  writeFileSync(path, `${text.replace(/\s*$/, '\n')}${stateFileName}\n`)
}

function writeConsumerEndpoints(consumer, manifest) {
  const npmrc = join(consumer, '.npmrc')
  const npmText = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : ''
  writeFileSync(npmrc, replaceManagedBlock(npmText, 'npm', `@caracalai:registry=${manifest.registries.npm}`))

  const envFile = join(consumer, 'caracal.rc.env')
  const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  const body = [
    `CARACAL_CHANNEL=rc`,
    `CARACAL_VERSION=${manifest.version}`,
    `CARACAL_REGISTRY=${manifest.registries.oci.replace(/\/?$/, '/')}`,
    `CARACAL_RC_NPM_REGISTRY=${manifest.registries.npm}`,
    `CARACAL_RC_PYPI_INDEX=${manifest.registries.pypi}`,
    `PIP_INDEX_URL=${manifest.registries.pypi}`,
    `UV_INDEX_URL=${manifest.registries.pypi}`,
    `CARACAL_RC_GITHUB_RELEASE=${manifest.githubRelease.assets}`,
  ].join('\n')
  writeFileSync(envFile, replaceManagedBlock(envText, 'env', body))
}

function commandExists(name) {
  return spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0
}

function runConsumerCommand(consumer, command, args, manifest) {
  if (!commandExists(command)) die(`${command} is required to refresh lockfiles in ${consumer}`)
  const result = spawnSync(command, args, {
    cwd: consumer,
    stdio: 'inherit',
    env: {
      ...process.env,
      PIP_INDEX_URL: manifest.registries.pypi,
      UV_INDEX_URL: manifest.registries.pypi,
    },
  })
  if (result.status !== 0) die(`${command} ${args.join(' ')} failed in ${consumer}`)
}

function refreshConsumerLocks(consumer, manifest) {
  if (existsSync(join(consumer, 'pnpm-lock.yaml'))) {
    runConsumerCommand(consumer, 'pnpm', ['install', '--lockfile-only', '--ignore-scripts'], manifest)
  } else if (existsSync(join(consumer, 'package-lock.json'))) {
    runConsumerCommand(consumer, 'npm', ['install', '--package-lock-only', '--ignore-scripts'], manifest)
  }

  if (existsSync(join(consumer, 'uv.lock'))) {
    runConsumerCommand(consumer, 'uv', ['lock'], manifest)
  } else if (existsSync(join(consumer, 'poetry.lock'))) {
    runConsumerCommand(consumer, 'poetry', ['lock'], manifest)
  }
}

function selectConsumer(options, local) {
  const consumer = options.consumer ? resolve(options.consumer) : die('--consumer is required')
  if (!existsSync(consumer)) die(`consumer path not found: ${consumer}`)
  const stateFile = join(consumer, stateFileName)
  if (!local) {
    if (!existsSync(stateFile)) die(`no saved rc state found in ${consumer}`)
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    for (const [file, body] of Object.entries(state.files ?? {})) writeFileSync(join(consumer, file), body)
    for (const file of state.createdFiles ?? []) rmSync(join(consumer, file), { force: true })
    rmSync(stateFile, { force: true })
    say(`reverted ${consumer} from saved rc state`)
    return
  }
  if (existsSync(stateFile)) die(`rc state already exists in ${consumer}; run revert before selecting another rc`)

  const manifest = loadManifest(options.manifest)
  const managedFiles = ['.npmrc', 'caracal.rc.env', '.gitignore']
  const backup = Object.fromEntries(consumerFiles(consumer).map((file) => [relative(consumer, file), readFileSync(file, 'utf8')]))
  const createdFiles = managedFiles.filter((file) => !existsSync(join(consumer, file)))
  writeFileSync(stateFile, `${JSON.stringify({ manifestId: manifest.release, createdAt: new Date().toISOString(), createdFiles, files: backup }, null, 2)}\n`)
  touchGitignore(consumer)

  const npmChanged = updateConsumerPackageJson(join(consumer, 'package.json'), manifest.npm)
  const pyChanged = updateConsumerPython(join(consumer, 'pyproject.toml'), manifest.pypi)
  updateConsumerPython(join(consumer, 'requirements.txt'), manifest.pypi)
  updateConsumerPython(join(consumer, 'requirements.lock'), manifest.pypi)
  updateConsumerCompose(join(consumer, 'compose.yaml'), manifest.images)
  updateConsumerCompose(join(consumer, 'docker-compose.yml'), manifest.images)
  writeConsumerEndpoints(consumer, manifest)
  if (!options['skip-lock-refresh']) refreshConsumerLocks(consumer, manifest)
  say(`selected Caracal ${manifest.release} for ${consumer}`)
  if (!npmChanged && !pyChanged) say('no npm or Python dependency declarations referenced Caracal packages')
}

function prepare(options) {
  if (dirtyTree() && !options.flags.has('allow-dirty')) die('working tree is dirty; commit/stash first or pass --allow-dirty')
  const manifest = makeManifest(options.values)
  const path = writeManifest(manifest)
  for (const pkgPath of npmPaths) rewritePackageJson(join(repoRoot, pkgPath, 'package.json'), manifest.npm)
  for (const pyPath of pyPaths) rewritePyproject(join(repoRoot, pyPath, 'pyproject.toml'), manifest.pypi)
  say(`prepared ${manifest.release}`)
  say(path)
}

function printVersion(options) {
  const manifest = makeManifest(options.values)
  const path = writeManifest(manifest)
  say(JSON.stringify({ manifest: path, ...manifest }, null, 2))
}

function clean(options) {
  const manifest = loadManifest(options.values.manifest)
  rmSync(dirname(manifestPath(manifest)), { recursive: true, force: true })
  say(`cleaned ${manifest.release}`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  switch (options.command) {
    case 'version':
      printVersion(options)
      break
    case 'prepare':
      prepare(options)
      break
    case 'select':
      selectConsumer(options.values, true)
      break
    case 'revert':
      selectConsumer(options.values, false)
      break
    case 'clean':
      clean(options)
      break
    case '-h':
    case '--help':
    case undefined:
      say(`Usage: scripts/rc.sh <command> [options]

Commands:
  version                 Generate an rc manifest under releases/<tag>/manifest.json.
  prepare [--allow-dirty] Generate the manifest and stamp package metadata to rc versions.
  select --consumer PATH  Switch a downstream repo to rc package/image versions.
  revert --consumer PATH  Restore downstream files saved by select.
  clean --manifest PATH   Remove an rc manifest directory.

Options:
  --base-version VER      Base runtime version; default UTC CalVer.
  --suffix VALUE          rc suffix; default rc.sha<gitsha>. Also supports rc.<number>.
  --manifest PATH|TAG     rc manifest path or tag for select/revert/clean.
  --consumer PATH         Downstream repository path.
  --npm-registry URL      npm registry endpoint; default https://registry.npmjs.org/.
  --pypi-index URL        Python simple index endpoint; default https://pypi.org/simple/.
  --oci-registry HOST     OCI registry namespace; default ghcr.io/garudex-labs.
  --github-release-base   GitHub Releases download base URL.
  --skip-lock-refresh     Update manifests without running package-manager lock refresh.`)
      break
    default:
      die(`unknown command: ${options.command}`)
  }
}

main()
