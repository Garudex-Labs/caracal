#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// rc workflow for versioning and manifests.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
    if (['base-version', 'manifest', 'npm-registry', 'pypi-index', 'oci-registry', 'github-release-base', 'suffix'].includes(key)) {
      args.values[key] = argv[++i]
      if (!args.values[key]) die(`--${key} requires a value`)
    } else {
      args.flags.add(key)
    }
  }
  return args
}

function shortSha() {
  if (process.env.CARACAL_SHA) return process.env.CARACAL_SHA
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
  return options.suffix ?? process.env.CARACAL_SUFFIX ?? `rc.sha${shortSha()}`
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
    npm: options['npm-registry'] ?? process.env.CARACAL_NPM_REGISTRY ?? 'https://registry.npmjs.org/',
    pypi: options['pypi-index'] ?? process.env.CARACAL_PYPI_INDEX ?? 'https://pypi.org/simple/',
    oci: options['oci-registry'] ?? process.env.CARACAL_OCI_REGISTRY ?? 'ghcr.io/garudex-labs',
    githubReleases: options['github-release-base'] ?? process.env.CARACAL_GITHUB_RELEASE_BASE ?? 'https://github.com/Garudex-Labs/caracal/releases/download',
  }
}

function makeManifest(options = {}) {
  const sha = shortSha()
  const suffix = rcSuffix(options)
  const baseVersion = cleanBase(options['base-version'] ?? process.env.CARACAL_BASE_VERSION ?? currentCalVer())
  const version = `${baseVersion}-${suffix}`
  const tag = `v${version}`
  const npm = Object.fromEntries(Object.entries(readPackageVersions(npmPaths)).map(([name, base]) => [name, npmRcVersion(base, suffix)]))
  const pypi = Object.fromEntries(Object.entries(readPythonVersions(pyPaths)).map(([name, base]) => [name, pythonRcVersion(base, suffix)]))
  const reg = registries(options)
  return {
    release: tag,
    mode: 'rc',
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
    binaries: { shell: version, terminal: version },
    containers: Object.fromEntries(containers.map((name) => [name, version])),
    images: Object.fromEntries(containers.map((name) => [name, `${reg.oci.replace(/\/$/, '')}/caracal-${name}:v${version}`])),
    npm,
    pypi,
    githubRelease: {
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
  clean --manifest PATH   Remove an rc manifest directory.

Options:
  --base-version VER      Base version; default UTC CalVer.
  --suffix VALUE          rc suffix; default rc.sha<gitsha>. Also supports rc.<number>.
  --manifest PATH|TAG     rc manifest path or tag for clean.
  --npm-registry URL      npm registry endpoint; default https://registry.npmjs.org/.
  --pypi-index URL        Python simple index endpoint; default https://pypi.org/simple/.
  --oci-registry HOST     OCI registry namespace; default ghcr.io/garudex-labs.
  --github-release-base   GitHub Releases download base URL.`)
      break
    default:
      die(`unknown command: ${options.command}`)
  }
}

main()
