#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Prerelease channel implementation for production-shaped downstream consumption.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prereleaseRoot = join(repoRoot, '.prereleases')
const stateFileName = '.caracalPrereleaseState.json'

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

const binaryApps = {
  cli: 'apps/cli',
  tui: 'apps/tui',
}

const containerServices = ['api', 'coordinator', 'audit', 'gateway', 'sts', 'redis']

const binaryTargets = [
  ['shell', 'linux', 'amd64', 'x64'],
  ['shell', 'linux', 'arm64', 'arm64'],
  ['shell', 'darwin', 'amd64', 'x64'],
  ['shell', 'darwin', 'arm64', 'arm64'],
  ['shell', 'windows', 'amd64', 'x64'],
  ['cli', 'linux', 'amd64', 'x64'],
  ['cli', 'linux', 'arm64', 'arm64'],
  ['cli', 'darwin', 'amd64', 'x64'],
  ['cli', 'darwin', 'arm64', 'arm64'],
  ['cli', 'windows', 'amd64', 'x64'],
  ['tui', 'linux', 'amd64', 'x64'],
  ['tui', 'linux', 'arm64', 'arm64'],
  ['tui', 'darwin', 'amd64', 'x64'],
  ['tui', 'darwin', 'arm64', 'arm64'],
  ['tui', 'windows', 'amd64', 'x64'],
]

function die(message) {
  process.stderr.write(`prerelease: ${message}\n`)
  process.exit(1)
}

function say(message = '') {
  process.stdout.write(`${message}\n`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    text: true,
  })
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : ''
    die(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`)
  }
  return result.stdout?.trim() ?? ''
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    text: true,
  })
  return result
}

function shortSha() {
  if (process.env.CARACAL_DEV_SHA) return process.env.CARACAL_DEV_SHA
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return 'nogit'
  }
}

function dirtyTree() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function parseArgs(argv) {
  const args = { command: argv[0], values: {}, flags: new Set() }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) die(`unexpected positional argument: ${arg}`)
    const key = arg.slice(2)
    if (['consumer', 'manifest', 'runtime-version', 'npm-registry', 'pypi-repository', 'pypi-simple', 'oci-registry', 'binary-channel', 'binary-dir'].includes(key)) {
      args.values[key] = argv[++i]
      if (!args.values[key]) die(`--${key} requires a value`)
    } else {
      args.flags.add(key)
    }
  }
  return args
}

function rcVersion(version, suffix) {
  if (/\+dev\.|-dev\.|-rc\./.test(version)) die(`base version is already suffixed: ${version}`)
  return `${version}-${suffix}`
}

function pythonRcVersion(version, sha) {
  if (/\+dev\.|-dev\.|-rc\.|rc\d+/i.test(version)) die(`base Python version is already suffixed: ${version}`)
  return `${version}rc0+sha${sha}`
}

function registries(options = {}) {
  const pypiRepository = options['pypi-repository'] ?? process.env.CARACAL_PRERELEASE_PYPI_REPOSITORY ?? 'http://localhost:3141/root/caracal-prerelease/'
  const binaryDir = options['binary-dir'] ?? process.env.CARACAL_PRERELEASE_BINARY_DIR ?? join(prereleaseRoot, 'binaryChannel')
  return {
    npm: options['npm-registry'] ?? process.env.CARACAL_PRERELEASE_NPM_REGISTRY ?? 'http://localhost:4873',
    pypiRepository,
    pypiSimple: options['pypi-simple'] ?? process.env.CARACAL_PRERELEASE_PYPI_SIMPLE ?? `${pypiRepository.replace(/\/$/, '')}/+simple/`,
    oci: options['oci-registry'] ?? process.env.CARACAL_PRERELEASE_OCI_REGISTRY ?? 'localhost:5000',
    binaries: options['binary-channel'] ?? process.env.CARACAL_PRERELEASE_BINARY_CHANNEL ?? 'http://localhost:8765/caracal',
    binaryDir,
  }
}

function endpointHost(value) {
  if (!value) return ''
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return ''
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`http://${value}`)
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return value.split('/')[0].split(':')[0].toLowerCase()
  }
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

function isLocalEndpoint(value) {
  if (!value) return false
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true
  const host = endpointHost(value)
  if (!host) return false
  if (host === 'localhost' || host === '::1') return true
  if (isPrivateIpv4(host)) return true
  if (host.endsWith('.local')) return true
  return !host.includes('.')
}

function assertStagingEndpoint(label, value) {
  if (isLocalEndpoint(value)) return
  die(`${label} must be a loopback, RFC1918, .local, or single-label staging endpoint; refusing internet endpoint: ${value}`)
}

function assertStagingDirectory(label, value) {
  if (!value || value.includes('://')) die(`${label} must be a local filesystem path; refusing remote artifact store: ${value}`)
}

function assertStagingTargets(manifest) {
  assertStagingEndpoint('npm registry', manifest.registries.npm)
  assertStagingEndpoint('PyPI repository', manifest.registries.pypiRepository)
  assertStagingEndpoint('PyPI simple index', manifest.registries.pypiSimple)
  assertStagingEndpoint('OCI registry', manifest.registries.oci)
  assertStagingEndpoint('binary channel', manifest.registries.binaries)
  assertStagingDirectory('binary staging directory', manifest.registries.binaryDir)
}

function currentCalVer() {
  const date = new Date()
  const year = date.getUTCFullYear()
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${date.getUTCDate()}`.padStart(2, '0')
  return `${year}.${month}.${day}`
}

function readPackageJsonVersions(paths) {
  return Object.fromEntries(paths.map((path) => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8'))
    if (!pkg.name || !pkg.version) die(`missing name or version in ${path}/package.json`)
    return [pkg.name, pkg.version]
  }))
}

function readPyprojectVersions(paths) {
  return Object.fromEntries(paths.map((path) => {
    const text = readFileSync(join(repoRoot, path, 'pyproject.toml'), 'utf8')
    const name = text.match(/^name = "([^"]+)"/m)?.[1]
    const version = text.match(/^version = "([^"]+)"/m)?.[1]
    if (!name || !version) die(`missing project name or version in ${path}/pyproject.toml`)
    return [name, version]
  }))
}

function baseVersions(options = {}) {
  const runtime = options['runtime-version'] ?? process.env.CARACAL_PRERELEASE_RUNTIME_VERSION ?? currentCalVer()
  return {
    runtime,
    binaries: Object.fromEntries(Object.keys(binaryApps).map((name) => [name, runtime])),
    containers: Object.fromEntries(containerServices.map((name) => [name, runtime])),
    npm: readPackageJsonVersions(npmPaths),
    pypi: readPyprojectVersions(pyPaths),
  }
}

function manifestDir(manifest) {
  return join(prereleaseRoot, manifest.id)
}

function makeManifest(options = {}) {
  const base = baseVersions(options)
  const sha = shortSha()
  const suffix = `rc.sha${sha}`
  const id = `v${rcVersion(base.runtime, suffix)}`
  const reg = registries(options)
  const npm = Object.fromEntries(Object.entries(base.npm).map(([name, version]) => [name, rcVersion(version, suffix)]))
  const pypi = Object.fromEntries(Object.entries(base.pypi).map(([name, version]) => [name, pythonRcVersion(version, sha)]))
  const binaryVersions = Object.fromEntries(Object.entries(base.binaries).map(([name, version]) => [name, rcVersion(version, suffix)]))
  const containerVersions = Object.fromEntries(Object.entries(base.containers).map(([name, version]) => [name, rcVersion(version, suffix)]))
  const containers = Object.fromEntries(Object.entries(containerVersions).map(([name, version]) => [
    name,
    `${reg.oci.replace(/\/$/, '')}/caracal-${name}:v${version}`,
  ]))
  const manifest = {
    kind: 'prerelease',
    channel: 'rc',
    id,
    sha,
    suffix,
    source: {
      type: 'workspace',
      sha,
      dirty: Boolean(dirtyTree()),
    },
    baseVersions: base,
    versionFormat: {
      npm: '<base>-rc.sha<gitsha>',
      pypi: '<base>rc0+sha<gitsha>',
      containers: '<base>-rc.sha<gitsha>',
      binaries: '<base>-rc.sha<gitsha>',
    },
    dirty: Boolean(dirtyTree()),
    generatedAt: new Date().toISOString(),
    registries: {
      npm: reg.npm,
      pypiRepository: reg.pypiRepository,
      pypiSimple: reg.pypiSimple,
      oci: reg.oci,
      binaries: reg.binaries,
      binaryDir: reg.binaryDir,
    },
    versions: {
      binaries: binaryVersions,
      containers: containerVersions,
      npm,
      pypi,
    },
    artifacts: {
      binaries: {},
      containers,
      npm: {},
      pypi: {},
    },
  }
  assertStagingTargets(manifest)
  return manifest
}

function writeManifest(manifest) {
  const dir = manifestDir(manifest)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function loadManifest(pathOrId) {
  if (pathOrId) {
    const path = pathOrId.endsWith('.json') ? resolve(pathOrId) : join(prereleaseRoot, pathOrId, 'manifest.json')
    if (!existsSync(path)) die(`manifest not found: ${path}`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  if (!existsSync(prereleaseRoot)) die('no prereleases found; run scripts/prerelease.sh build first')
  const dirs = readdirSync(prereleaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(prereleaseRoot, entry.name, 'manifest.json')))
    .map((entry) => ({ name: entry.name, time: statSync(join(prereleaseRoot, entry.name, 'manifest.json')).mtimeMs }))
    .sort((a, b) => a.time - b.time)
  if (!dirs.length) die('no prerelease manifest found; run scripts/prerelease.sh build first')
  return JSON.parse(readFileSync(join(prereleaseRoot, dirs.at(-1).name, 'manifest.json'), 'utf8'))
}

function backupFiles(paths) {
  return Object.fromEntries(paths.filter((path) => existsSync(path)).map((path) => [path, readFileSync(path, 'utf8')]))
}

function restoreFiles(files) {
  for (const [path, body] of Object.entries(files)) writeFileSync(path, body)
}

function copyTree(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name)
    const dst = join(target, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else copyFileSync(src, dst)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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

async function withStampedPackages(manifest, callback) {
  const files = [
    ...npmPaths.map((path) => join(repoRoot, path, 'package.json')),
    ...pyPaths.map((path) => join(repoRoot, path, 'pyproject.toml')),
  ]
  const backup = backupFiles(files)
  try {
    for (const path of npmPaths) rewritePackageJson(join(repoRoot, path, 'package.json'), manifest.versions.npm)
    for (const path of pyPaths) rewritePyproject(join(repoRoot, path, 'pyproject.toml'), manifest.versions.pypi)
    await callback()
  } finally {
    restoreFiles(backup)
  }
}

function buildNpm(manifest) {
  say('building npm packages')
  const out = join(manifestDir(manifest), 'npm')
  mkdirSync(out, { recursive: true })
  run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'])
  run('pnpm', ['run', 'build:typescript'])
  for (const path of npmPaths) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8'))
    const output = run('npm', ['pack', '--pack-destination', out, '--json'], { cwd: join(repoRoot, path), capture: true })
    const packed = JSON.parse(output)[0]
    manifest.artifacts.npm[pkg.name] = {
      version: manifest.versions.npm[pkg.name],
      tarball: relative(repoRoot, join(out, packed.filename)),
    }
  }
}

function buildPypi(manifest) {
  say('building PyPI packages')
  const out = join(manifestDir(manifest), 'pypi')
  const venv = join(manifestDir(manifest), 'buildVenv')
  mkdirSync(out, { recursive: true })
  run('python3', ['-m', 'venv', venv])
  const python = join(venv, 'bin', 'python')
  run(python, ['-m', 'pip', 'install', '--quiet', '--require-hashes', '--requirement', 'scripts/publishPypiRequirements.lock'])
  for (const path of pyPaths) {
    const root = join(repoRoot, path)
    const text = readFileSync(join(root, 'pyproject.toml'), 'utf8')
    const name = text.match(/^name = "([^"]+)"/m)?.[1]
    if (!name) die(`missing project name in ${path}/pyproject.toml`)
    rmSync(join(root, 'dist'), { recursive: true, force: true })
    rmSync(join(root, 'build'), { recursive: true, force: true })
    run(python, ['-m', 'build'], { cwd: root })
    const files = readdirSync(join(root, 'dist')).map((file) => join(root, 'dist', file))
    run(join(venv, 'bin', 'twine'), ['check', ...files])
    manifest.artifacts.pypi[name] = {
      version: manifest.versions.pypi[name],
      files: files.map((file) => {
        const target = join(out, basename(file))
        copyFileSync(file, target)
        return relative(repoRoot, target)
      }),
    }
    rmSync(join(root, 'dist'), { recursive: true, force: true })
    rmSync(join(root, 'build'), { recursive: true, force: true })
  }
}

function buildContainers(manifest) {
  say('building OCI images')
  const services = Object.keys(manifest.versions.containers)
  if (!services.length) return
  const composeFile = join(repoRoot, 'infra/docker/docker-compose.yml')
  const envFile = join(repoRoot, 'infra/docker/.env')
  const args = ['compose']
  if (existsSync(envFile)) args.push('--env-file', envFile)
  args.push('-f', composeFile, 'build', ...services)
  run('docker', args, { env: { CARACAL_DEV_SHA: manifest.sha, CARACAL_MODE: 'dev' } })
  for (const service of services) {
    const source = `localhost/caracal-${service}:dev-${manifest.sha}`
    const target = manifest.artifacts.containers[service]
    run('docker', ['tag', source, target])
  }
}

function buildBinaries(manifest) {
  say('building CLI/TUI binaries')
  const out = join(manifestDir(manifest), 'binaries')
  const releaseDist = join(out, manifest.id)
  mkdirSync(out, { recursive: true })
  mkdirSync(releaseDist, { recursive: true })
  const registry = `${manifest.registries.oci.replace(/\/$/, '')}/`
  const env = {
    CARACAL_PRERELEASE: '1',
    CARACAL_RELEASE_REGISTRY: registry,
  }
  for (const [name, appPath] of Object.entries(binaryApps)) {
    run('pnpm', ['--dir', appPath, 'build:release'], {
      env: { ...env, CARACAL_RELEASE_VERSION: manifest.versions.binaries[name] },
    })
    const source = join(repoRoot, appPath, 'dist')
    const target = join(out, name)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    for (const file of readdirSync(source)) {
      copyFileSync(join(source, file), join(target, file))
    }
    manifest.artifacts.binaries[name] = {
      version: manifest.versions.binaries[name],
      dir: relative(repoRoot, target),
    }
  }
  const tag = manifest.id
  const archives = []
  for (const [kind, os, arch, bunArch] of binaryTargets) {
    const windows = os === 'windows'
    const ext = windows ? '.exe' : ''
    const srcDir = kind === 'tui' ? join(repoRoot, binaryApps.tui, 'dist') : join(repoRoot, binaryApps.cli, 'dist')
    const srcBase = kind === 'shell' ? 'caracal' : `caracal-${kind}`
    const binName = kind === 'shell' ? 'caracal' : `caracal-${kind}`
    const source = join(srcDir, `${srcBase}-${os}-${bunArch}${ext}`)
    if (!existsSync(source)) die(`missing source binary: ${source}`)
    const stage = mkdtempSync(join(tmpdir(), 'caracal-prerelease-'))
    const staged = join(stage, `${binName}${ext}`)
    copyFileSync(source, staged)
    try { chmodSync(staged, 0o755) } catch {}
    const archive = `caracal-${kind}-${os}-${arch}-${tag}.${windows ? 'zip' : 'tar.gz'}`
    if (windows) run('zip', ['-q', join(releaseDist, archive), `${binName}${ext}`], { cwd: stage })
    else run('tar', ['-czf', join(releaseDist, archive), '-C', stage, binName])
    archives.push(archive)
    rmSync(stage, { recursive: true, force: true })
  }
  const sums = archives.map((archive) => `${sha256(join(releaseDist, archive))}  ${archive}`).join('\n')
  writeFileSync(join(releaseDist, 'SHA256SUMS'), `${sums}\n`)
  manifest.artifacts.binaryChannel = {
    version: tag,
    dir: relative(repoRoot, releaseDist),
    files: [...archives, 'SHA256SUMS'].map((file) => relative(repoRoot, join(releaseDist, file))),
  }
}

async function build(options) {
  const manifest = makeManifest(options.values)
  if (manifest.dirty && !options.flags.has('allow-dirty') && process.env.CARACAL_PRERELEASE_ALLOW_DIRTY !== '1') {
    die('working tree is dirty; commit/stash first or pass --allow-dirty')
  }
  rmSync(manifestDir(manifest), { recursive: true, force: true })
  writeManifest(manifest)
  await withStampedPackages(manifest, async () => {
    buildNpm(manifest)
    buildPypi(manifest)
  })
  buildContainers(manifest)
  buildBinaries(manifest)
  writeManifest(manifest)
  say(`prerelease built: ${manifest.id}`)
  say(join(manifestDir(manifest), 'manifest.json'))
}

function stage(options) {
  const manifest = loadManifest(options.values.manifest)
  assertStagingTargets(manifest)
  say(`staging prerelease: ${manifest.id}`)
  for (const artifact of Object.values(manifest.artifacts.npm ?? {})) {
    run('npm', ['publish', join(repoRoot, artifact.tarball), '--registry', manifest.registries.npm, '--tag', 'rc'])
  }
  const pypiFiles = Object.values(manifest.artifacts.pypi ?? {}).flatMap((artifact) => artifact.files.map((file) => join(repoRoot, file)))
  if (pypiFiles.length) {
    const venv = join(manifestDir(manifest), 'publishVenv')
    run('python3', ['-m', 'venv', venv])
    const python = join(venv, 'bin', 'python')
    run(python, ['-m', 'pip', 'install', '--quiet', '--require-hashes', '--requirement', 'scripts/publishPypiRequirements.lock'])
    run(join(venv, 'bin', 'twine'), ['upload', '--repository-url', manifest.registries.pypiRepository, ...pypiFiles])
  }
  for (const image of Object.values(manifest.artifacts.containers ?? {})) {
    run('docker', ['push', image])
  }
  const binaryChannelRoot = manifest.registries.binaryDir
  const binaryRoot = join(manifest.registries.binaryDir, manifest.id)
  mkdirSync(binaryChannelRoot, { recursive: true })
  rmSync(binaryRoot, { recursive: true, force: true })
  if (manifest.artifacts.binaryChannel?.dir) {
    copyTree(join(repoRoot, manifest.artifacts.binaryChannel.dir), binaryRoot)
  }
  for (const installer of ['install-cli.sh', 'install-tui.sh']) {
    const target = join(binaryChannelRoot, installer)
    copyFileSync(join(repoRoot, installer), target)
    chmodSync(target, 0o755)
  }
  writeFileSync(join(binaryRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  say(`staged binaries at ${binaryRoot}`)
}

function packageManager(consumer) {
  if (existsSync(join(consumer, 'pnpm-lock.yaml'))) return ['pnpm', ['install', '--lockfile-only']]
  if (existsSync(join(consumer, 'package-lock.json'))) return ['npm', ['install', '--package-lock-only']]
  if (existsSync(join(consumer, 'yarn.lock'))) return ['yarn', ['install']]
  return null
}

function replaceManagedBlock(text, name, body) {
  const start = `# caracal-prerelease:${name}:start`
  const end = `# caracal-prerelease:${name}:end`
  const block = body ? `${start}\n${body.trim()}\n${end}\n` : ''
  const pattern = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, 'm')
  if (pattern.test(text)) return text.replace(pattern, block ? `\n${block}` : '\n')
  return block ? `${text.replace(/\s*$/, '\n')}\n${block}` : text
}

function touchGitignore(consumer) {
  const path = join(consumer, '.gitignore')
  const entry = stateFileName
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (text.split(/\r?\n/).includes(entry)) return
  writeFileSync(path, `${text.replace(/\s*$/, '\n')}${entry}\n`)
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

function updateConsumerPython(path, versions, local) {
  if (!existsSync(path)) return false
  let text = readFileSync(path, 'utf8')
  const original = text
  for (const [name, version] of Object.entries(versions)) {
    const spec = local ? `${name}==${version}` : `${name}>=${version}`
    text = text.replace(new RegExp(`"${name}[^"]*"`, 'g'), `"${spec}"`)
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

function consumerFiles(consumer) {
  return [
    'package.json',
    '.npmrc',
    'pyproject.toml',
    'requirements.txt',
    'requirements.lock',
    'compose.yaml',
    'docker-compose.yml',
    'caracal.prerelease.env',
    '.gitignore',
  ].map((file) => join(consumer, file)).filter((file) => existsSync(file))
}

function writeConsumerEndpoints(consumer, manifest, local) {
  const npmrc = join(consumer, '.npmrc')
  const npmText = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : ''
  writeFileSync(npmrc, replaceManagedBlock(npmText, 'npm', local ? `@caracalai:registry=${manifest.registries.npm}` : ''))

  const envFile = join(consumer, 'caracal.prerelease.env')
  const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  const body = local
    ? [
        `CARACAL_PRERELEASE_NPM_REGISTRY=${manifest.registries.npm}`,
        `CARACAL_PRERELEASE_PYPI_INDEX=${manifest.registries.pypiSimple}`,
        `PIP_INDEX_URL=${manifest.registries.pypiSimple}`,
        `UV_INDEX_URL=${manifest.registries.pypiSimple}`,
        `CARACAL_REGISTRY=${manifest.registries.oci.replace(/\/?$/, '/')}`,
        `CARACAL_VERSION=${Object.values(manifest.versions.containers)[0] ?? ''}`,
        `CARACAL_IMAGE_VERSION=${Object.values(manifest.versions.containers)[0] ?? ''}`,
        `CARACAL_PRERELEASE_BINARY_CHANNEL=${manifest.registries.binaries}`,
      ].join('\n')
    : ''
  writeFileSync(envFile, replaceManagedBlock(envText, 'env', body))
}

function refreshConsumerLocks(consumer, manifest, local, noLockfile) {
  if (noLockfile) return
  const manager = packageManager(consumer)
  if (manager && existsSync(join(consumer, 'package.json'))) {
    run(manager[0], manager[1], { cwd: consumer })
  }
  if (existsSync(join(consumer, 'uv.lock'))) {
    const args = local ? ['lock', '--index-url', manifest.registries.pypiSimple] : ['lock']
    run('uv', args, { cwd: consumer })
  }
}

function selectConsumer(options, local) {
  const consumer = options.values.consumer ? resolve(options.values.consumer) : die('--consumer is required')
  if (!existsSync(consumer)) die(`consumer path not found: ${consumer}`)
  const stateFile = join(consumer, stateFileName)
  if (!local) {
    if (!existsSync(stateFile)) die(`no saved prerelease state found in ${consumer}`)
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    for (const [file, body] of Object.entries(state.files ?? {})) {
      writeFileSync(join(consumer, file), body)
    }
    for (const file of state.createdFiles ?? []) {
      rmSync(join(consumer, file), { force: true })
    }
    rmSync(stateFile, { force: true })
    refreshConsumerLocks(consumer, null, false, options.flags.has('no-lockfile'))
    say(`reverted ${consumer} from saved prerelease state`)
    return
  }

  const manifest = loadManifest(options.values.manifest)
  assertStagingTargets(manifest)
  const managedFiles = ['.npmrc', 'caracal.prerelease.env', '.gitignore']
  const backup = Object.fromEntries(consumerFiles(consumer).map((file) => [relative(consumer, file), readFileSync(file, 'utf8')]))
  const createdFiles = managedFiles.filter((file) => !existsSync(join(consumer, file)))
  writeFileSync(stateFile, `${JSON.stringify({ manifestId: manifest.id, createdAt: new Date().toISOString(), createdFiles, files: backup }, null, 2)}\n`)
  touchGitignore(consumer)

  const npmChanged = updateConsumerPackageJson(join(consumer, 'package.json'), manifest.versions.npm)
  const pyChanged = updateConsumerPython(join(consumer, 'pyproject.toml'), manifest.versions.pypi, true)
  if (!options.flags.has('no-lockfile')) {
    updateConsumerPython(join(consumer, 'requirements.txt'), manifest.versions.pypi, true)
    updateConsumerPython(join(consumer, 'requirements.lock'), manifest.versions.pypi, true)
  }
  updateConsumerCompose(join(consumer, 'compose.yaml'), manifest.artifacts.containers)
  updateConsumerCompose(join(consumer, 'docker-compose.yml'), manifest.artifacts.containers)
  writeConsumerEndpoints(consumer, manifest, true)
  refreshConsumerLocks(consumer, manifest, true, options.flags.has('no-lockfile'))
  say(`selected Caracal ${manifest.id} for ${consumer}`)
  if (!npmChanged && !pyChanged) say('no npm or Python dependency declarations referenced Caracal packages')
}

function clean(options) {
  const manifest = options.values.manifest ? loadManifest(options.values.manifest) : null
  const targets = manifest ? [manifestDir(manifest)] : [prereleaseRoot]
  for (const target of targets) rmSync(target, { recursive: true, force: true })
  if (manifest) {
    for (const image of Object.values(manifest.artifacts?.containers ?? {})) {
      tryRun('docker', ['image', 'rm', image], { capture: true })
    }
  }
  say(manifest ? `cleaned ${manifest.id}` : 'cleaned all prerelease artifacts')
}

function printVersion(options) {
  const manifest = makeManifest(options.values)
  writeManifest(manifest)
  say(JSON.stringify(manifest, null, 2))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  switch (options.command) {
    case 'version':
      printVersion(options)
      break
    case 'build':
      await build(options)
      break
    case 'stage':
      stage(options)
      break
    case 'select':
      selectConsumer(options, true)
      break
    case 'revert':
      selectConsumer(options, false)
      break
    case 'clean':
      clean(options)
      break
    case '-h':
    case '--help':
    case undefined:
      say(`Usage: scripts/prerelease.sh <command> [options]

Commands:
  version                 Compute and write the prerelease manifest.
  build [--allow-dirty]   Build npm, PyPI, OCI, and binary artifacts.
  stage                   Stage built artifacts in configured local prerelease registries.
  select --consumer PATH  Switch a downstream repo to prerelease artifacts.
  revert --consumer PATH  Restore the downstream repo state saved by select.
  clean                  Remove prerelease artifacts and rc image tags.

Options:
  --manifest PATH|ID      Use a specific prerelease manifest.
  --consumer PATH         Downstream repository path for select/revert.
  --no-lockfile           Skip package-manager lock refresh in select/revert.
  --runtime-version VER   Base runtime version for OCI and binaries; default UTC CalVer.
  --npm-registry URL      Prerelease npm registry; default http://localhost:4873.
  --pypi-repository URL   Prerelease PyPI staging upload endpoint.
  --pypi-simple URL       Prerelease Python simple index endpoint.
  --oci-registry HOST     Prerelease OCI registry; default localhost:5000.
  --binary-channel URL    Prerelease binary channel endpoint; default http://localhost:8765/caracal.
  --binary-dir PATH       Prerelease binary artifact staging directory.

Prerelease endpoints must be loopback, RFC1918, .local, or single-label staging
hosts. Public internet registries such as npmjs.org, pypi.org, ghcr.io, Docker
Hub, and GitHub Releases are refused for rc artifacts.`)
      break
    default:
      die(`unknown command: ${options.command}`)
  }
}

main().catch((error) => die(error.stack || error.message))
