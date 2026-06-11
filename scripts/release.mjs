#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unified release workflow for stable and rc versioning, manifests, and dry-runs.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productArchiveTargets, productContainers, releaseInventory } from './releaseInventory.mjs'
import { applyStamp, computeStamp } from './lib/stamp.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inventory = releaseInventory()

const npmPaths = inventory.packages.npm.map((pkg) => pkg.dir)
const pyPaths = inventory.packages.pypi.map((pkg) => pkg.dir)
const productImages = productContainers(inventory.config)
const containers = productImages.filter((image) => image.name !== 'runtime').map((image) => image.name)
const archiveTargets = productArchiveTargets(inventory.config).flatMap((target) => [
  `caracal-runtime-${target.os}-${target.arch}`,
  `caracal-console-${target.os}-${target.arch}`,
])
const imageBuilds = productImages.map((image) => [image.name, image.context, image.dockerfile])
const releaseTagPattern = /^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/

function die(message) {
  process.stderr.write(`release: ${message}\n`)
  process.exit(1)
}

function say(message = '') {
  process.stdout.write(`${message}\n`)
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8', ...options })
}

function parseArgs(argv) {
  const args = { command: argv[0], values: {}, flags: new Set() }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) die(`unexpected positional argument: ${arg}`)
    const key = arg.slice(2)
    if (
      [
        'base-version',
        'manifest',
        'npm-registry',
        'pypi-index',
        'oci-registry',
        'github-release-base',
        'suffix',
        'package-suffix',
        'ref',
        'from',
        'to',
      ].includes(key)
    ) {
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
  return run('git', ['rev-parse', '--short', 'HEAD']).trim()
}

function dirtyTree() {
  return run('git', ['status', '--porcelain']).trim()
}

function currentBranch() {
  return run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

function headSha() {
  return run('git', ['rev-parse', 'HEAD']).trim()
}

function remoteSha(ref) {
  const refs = [`refs/heads/${ref}`, `refs/tags/${ref}`]
  for (const candidate of refs) {
    const out = run('git', ['ls-remote', 'origin', candidate]).trim()
    if (out) return out.split(/\s+/, 1)[0]
  }
  return ''
}

function currentCalVer() {
  const date = new Date()
  return `${date.getUTCFullYear()}.${`${date.getUTCMonth() + 1}`.padStart(2, '0')}.${`${date.getUTCDate()}`.padStart(2, '0')}`
}

function currentDate() {
  const date = new Date()
  return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, '0')}-${`${date.getUTCDate()}`.padStart(2, '0')}`
}

function cleanBase(version) {
  if (/([+-]dev\.|-dev\.sha|-rc\.|rc\d+)/i.test(version)) die(`base version is already suffixed: ${version}`)
  return version
}

function npmRcBase(version, suffix) {
  if (version.endsWith(`-${suffix}`)) return version.slice(0, -suffix.length - 1)
  const base = version.replace(/-rc\.(?:sha[0-9A-Za-z]+|[0-9]+)$/, '')
  if (base !== version) return base
  return cleanBase(version)
}

function pythonRcBase(version, suffix) {
  const numeric = suffix.match(/^rc\.([0-9]+)$/)?.[1]
  const sha = suffix.match(/^rc\.sha([A-Za-z0-9]+)$/)?.[1]
  if (numeric && version.endsWith(`rc${numeric}`)) return version.slice(0, -`rc${numeric}`.length)
  if (sha && version.endsWith(`rc0+sha${sha}`)) return version.slice(0, -`rc0+sha${sha}`.length)
  const base = version.replace(/rc(?:[0-9]+|0\+sha[0-9A-Za-z]+)$/, '')
  if (base !== version) return base
  return cleanBase(version)
}

function rcSuffix(options) {
  return options.suffix ?? process.env.CARACAL_SUFFIX ?? `rc.sha${shortSha()}`
}

function npmRcVersion(version, suffix) {
  if (version.endsWith(`-${suffix}`)) return version
  return `${cleanBase(version)}-${suffix}`
}

function pythonRcVersion(version, suffix) {
  const numeric = suffix.match(/^rc\.([0-9]+)$/)?.[1]
  const sha = suffix.match(/^rc\.sha([A-Za-z0-9]+)$/)?.[1]
  if (numeric && version.endsWith(`rc${numeric}`)) return version
  if (sha && version.endsWith(`rc0+sha${sha}`)) return version
  const base = cleanBase(version)
  if (numeric) return `${base}rc${numeric}`
  if (sha) return `${base}rc0+sha${sha}`
  die(`unsupported Python rc suffix: ${suffix}; use rc.<number> or rc.sha<gitsha>`)
}

function readPackageVersions(paths, suffix) {
  return Object.fromEntries(
    paths.map((path) => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8'))
      if (!pkg.name || !pkg.version) die(`missing name or version in ${path}/package.json`)
      return [pkg.name, npmRcBase(pkg.version, suffix)]
    }),
  )
}

function readPythonVersions(paths, suffix) {
  return Object.fromEntries(
    paths.map((path) => {
      const text = readFileSync(join(repoRoot, path, 'pyproject.toml'), 'utf8')
      const name = text.match(/^name = "([^"]+)"/m)?.[1]
      const version = text.match(/^version = "([^"]+)"/m)?.[1]
      if (!name || !version) die(`missing name or version in ${path}/pyproject.toml`)
      return [name, pythonRcBase(version, suffix)]
    }),
  )
}

function registries(options) {
  return {
    npm: options['npm-registry'] ?? process.env.CARACAL_NPM_REGISTRY ?? 'https://registry.npmjs.org/',
    pypi: options['pypi-index'] ?? process.env.CARACAL_PYPI_INDEX ?? 'https://pypi.org/simple/',
    oci: options['oci-registry'] ?? process.env.CARACAL_OCI_REGISTRY ?? 'ghcr.io/garudex-labs',
    githubReleases:
      options['github-release-base'] ??
      process.env.CARACAL_GITHUB_RELEASE_BASE ??
      'https://github.com/Garudex-Labs/caracal/releases/download',
  }
}

function helmChartVersion(value) {
  const [core, pre] = value.split('-', 2)
  const parts = core.split('.')
  const recut = parts[3]
  const base = `${Number(parts[0])}.${Number(parts[1])}.${Number(parts[2])}`
  return `${base}${pre ? `-${pre}` : ''}${recut ? `+${recut}` : ''}`
}

function makeManifest(options = {}) {
  const sha = shortSha()
  const suffix = rcSuffix(options)
  // Package versions are SemVer and independent of the date-based release tag.
  // A package rc number only resets when its base version advances after a
  // stable publish, so the package suffix may differ from the tag suffix.
  const packageSuffix = options['package-suffix'] ?? process.env.CARACAL_PACKAGE_SUFFIX ?? suffix
  const baseVersion = cleanBase(options['base-version'] ?? process.env.CARACAL_BASE_VERSION ?? currentCalVer())
  const version = `${baseVersion}-${suffix}`
  const tag = `v${version}`
  const npm = Object.fromEntries(
    Object.entries(readPackageVersions(npmPaths, packageSuffix)).map(([name, base]) => [
      name,
      npmRcVersion(base, packageSuffix),
    ]),
  )
  const pypi = Object.fromEntries(
    Object.entries(readPythonVersions(pyPaths, packageSuffix)).map(([name, base]) => [
      name,
      pythonRcVersion(base, packageSuffix),
    ]),
  )
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
    binaries: { runtime: version, console: version },
    runtimeImage: version,
    containers: Object.fromEntries(containers.map((name) => [name, version])),
    helm: { chartVersion: helmChartVersion(version), appVersion: version, imageTag: version },
    images: Object.fromEntries(
      [...containers, 'runtime'].map((name) => [name, `${reg.oci.replace(/\/$/, '')}/caracal-${name}:v${version}`]),
    ),
    npm,
    pypi,
    packages: {
      published: { npm, pypi },
      unchanged: { npm: {}, pypi: {} },
    },
    githubRelease: {
      tag,
      assets: `${reg.githubReleases.replace(/\/$/, '')}/${tag}`,
    },
  }
}

function makeStableManifest(version, tag) {
  const npm = Object.fromEntries(
    npmPaths.map((path) => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8'))
      if (!pkg.name || !pkg.version) die(`missing name or version in ${path}/package.json`)
      return [pkg.name, pkg.version]
    }),
  )
  const pypi = Object.fromEntries(
    pyPaths.map((path) => {
      const text = readFileSync(join(repoRoot, path, 'pyproject.toml'), 'utf8')
      const name = text.match(/^name = "([^"]+)"/m)?.[1]
      const pkgVersion = text.match(/^version = "([^"]+)"/m)?.[1]
      if (!name || !pkgVersion) die(`missing name or version in ${path}/pyproject.toml`)
      return [name, pkgVersion]
    }),
  )
  const chartVersion = helmChartVersion(version)
  return {
    release: tag,
    mode: 'stable',
    publishedAt: currentDate(),
    binaries: { runtime: version, console: version },
    runtimeImage: version,
    containers: Object.fromEntries(containers.map((name) => [name, version])),
    helm: { chartVersion, appVersion: version, imageTag: version },
    pypi,
    npm,
    packages: {
      published: { npm, pypi },
      unchanged: { npm: {}, pypi: {} },
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

function nextStableTag() {
  const today = currentCalVer()
  const prefix = `v${today}`
  let maxSuffix = -1
  for (const existing of run('git', ['tag', '--list', `${prefix}*`])
    .trim()
    .split('\n')
    .filter(Boolean)) {
    const suffix = existing.slice(prefix.length)
    if (!suffix) {
      if (maxSuffix < 0) maxSuffix = 0
      continue
    }
    const match = suffix.match(/^\.([0-9]+)$/)
    if (match) maxSuffix = Math.max(maxSuffix, Number(match[1]))
  }
  return maxSuffix < 0 ? prefix : `${prefix}.${maxSuffix + 1}`
}

function remoteTagExists(tag) {
  try {
    execFileSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function pendingChangesets() {
  try {
    return readdirSync(join(repoRoot, '.changeset')).filter((name) => name.endsWith('.md') && name !== 'README.md').length
  } catch {
    return 0
  }
}

function validateStablePackageVersions(manifest) {
  for (const [group, values] of Object.entries({ npm: manifest.npm, pypi: manifest.pypi })) {
    for (const [name, version] of Object.entries(values)) {
      if (/dev\.sha|dev\./.test(version)) die(`${group} ${name} has dev version ${version}`)
    }
  }
}

function writeStableManifest(manifest) {
  validateStablePackageVersions(manifest)
  rewriteHelm(manifest)
  return writeManifest(manifest)
}

function assertStableCommit(tag) {
  const manifest = `releases/${tag}/manifest.json`
  if (!existsSync(join(repoRoot, manifest))) die(`manifest missing for ${tag}`)
  execFileSync('node', ['scripts/validateReleaseManifest.mjs', manifest], { cwd: repoRoot, stdio: 'inherit' })
  const files = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim().split('\n')
  for (const file of [manifest, 'infra/helm/caracal/Chart.yaml', 'infra/helm/caracal/values.yaml']) {
    if (!files.includes(file)) die(`release commit missing ${file}`)
  }
}

function stable(options) {
  if (dirtyTree()) die('dirty tree; commit or stash first')
  const dryRun = options.flags.has('dry-run')
  const branch = currentBranch()
  if (branch !== 'main' && !dryRun) die(`stable must run from main (current: ${branch})`)
  execFileSync('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd: repoRoot, stdio: 'inherit' })
  if (!dryRun) {
    execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repoRoot, stdio: 'inherit' })
    if (headSha() !== run('git', ['rev-parse', 'origin/main']).trim()) die('main is behind origin/main')
  }
  const tag = nextStableTag()
  const version = tag.slice(1)
  if (remoteTagExists(tag)) die(`remote tag already exists: ${tag}`)
  const pending = pendingChangesets()
  say(`stable: ${tag}`)
  say(`changesets: ${pending}`)
  if (dryRun) {
    if (pending > 0) {
      execFileSync('pnpm', ['changeset', 'status'], { cwd: repoRoot, stdio: 'inherit' })
      execFileSync('pnpm', ['changeset', 'version'], { cwd: repoRoot, stdio: 'inherit' })
    } else {
      say('no changesets')
    }
    writeStableManifest(makeStableManifest(version, tag))
    say('dry-run diff')
    execFileSync(
      'git',
      [
        '--no-pager',
        'diff',
        '--',
        '**/package.json',
        '**/pyproject.toml',
        'infra/helm/caracal/Chart.yaml',
        'infra/helm/caracal/values.yaml',
        `releases/${tag}/manifest.json`,
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    )
    execFileSync('git', ['restore', '--worktree', '--staged', '.'], { cwd: repoRoot, stdio: 'inherit' })
    execFileSync('git', ['clean', '-fd', '--', '.changeset', 'packages', 'apps', 'releases'], { cwd: repoRoot, stdio: 'inherit' })
    if (dirtyTree()) die('dry-run cleanup failed')
    say('dry-run complete')
    return
  }
  if (pending > 0) execFileSync('pnpm', ['changeset', 'version'], { cwd: repoRoot, stdio: 'inherit' })
  writeStableManifest(makeStableManifest(version, tag))
  execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'inherit' })
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot, stdio: 'ignore' })
  } catch {
    execFileSync('git', ['commit', '-m', `release: ${tag}`], { cwd: repoRoot, stdio: 'inherit' })
  }
  assertStableCommit(tag)
  execFileSync('git', ['tag', '-a', tag, '-m', tag], { cwd: repoRoot, stdio: 'inherit' })
  try {
    execFileSync('git', ['push', '--atomic', 'origin', 'main', `refs/tags/${tag}`], { cwd: repoRoot, stdio: 'inherit' })
  } catch {
    die(`atomic push failed for main and ${tag}`)
  }
  say(`pushed ${tag}`)
  say('Actions will publish release assets.')
}

function loadManifest(pathOrTag) {
  if (pathOrTag) {
    const path = pathOrTag.endsWith('.json') ? resolve(pathOrTag) : join(repoRoot, 'releases', pathOrTag, 'manifest.json')
    if (!existsSync(path)) die(`manifest not found: ${path}`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  const root = join(repoRoot, 'releases')
  if (!existsSync(root)) die('no rc manifest; run rc version first')
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /-rc\./.test(entry.name) && existsSync(join(root, entry.name, 'manifest.json')))
    .map((entry) => ({ name: entry.name, time: statSync(join(root, entry.name, 'manifest.json')).mtimeMs }))
    .sort((a, b) => a.time - b.time)
  if (!entries.length) die('no rc manifest; run rc version first')
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
  text = text.replace(/"(?<name>caracalai-[a-z0-9-]+)==[^"]+"/g, (match, pkgName) => {
    if (!versions[pkgName]) return match
    return `"${pkgName}==${versions[pkgName]}"`
  })
  writeFileSync(path, text)
}

function rewriteHelm(manifest) {
  const chartPath = join(repoRoot, 'infra/helm/caracal/Chart.yaml')
  const valuesPath = join(repoRoot, 'infra/helm/caracal/values.yaml')
  let chart = readFileSync(chartPath, 'utf8')
  let values = readFileSync(valuesPath, 'utf8')
  chart = chart.replace(/^version: .*/m, `version: ${manifest.helm.chartVersion}`)
  chart = chart.replace(/^appVersion: .*/m, `appVersion: "${manifest.helm.appVersion}"`)
  values = values.replace(/^  tag: .*/m, `  tag: "${manifest.helm.imageTag}"`)
  writeFileSync(chartPath, chart)
  writeFileSync(valuesPath, values)
}

function prepare(options) {
  if (dirtyTree() && !options.flags.has('allow-dirty')) die('dirty tree; commit/stash or pass --allow-dirty')
  const manifest = makeManifest(options.values)
  const path = writeManifest(manifest)
  for (const pkgPath of npmPaths) rewritePackageJson(join(repoRoot, pkgPath, 'package.json'), manifest.npm)
  for (const pyPath of pyPaths) rewritePyproject(join(repoRoot, pyPath, 'pyproject.toml'), manifest.pypi)
  rewriteHelm(manifest)
  say(`prepared: ${manifest.release}`)
  say(path)
}

function printVersion(options) {
  const manifest = makeManifest(options.values)
  const path = writeManifest(manifest)
  say(JSON.stringify({ manifest: path, ...manifest }, null, 2))
}

function dryRun(options) {
  const manifest = makeManifest(options.values)
  if (options.flags.has('local')) {
    simulateWorkflow(manifest)
    return
  }
  const ref = options.values.ref ?? process.env.CARACAL_WORKFLOW_REF ?? currentBranch()
  const checkoutRef = releaseTagPattern.test(ref) ? `refs/tags/${ref}` : ref
  const args = [
    'workflow',
    'run',
    'release.yml',
    '--ref',
    ref,
    '-f',
    `ref=${checkoutRef}`,
    '-f',
    `releaseVersion=${manifest.release}`,
    '-f',
    'dryRun=true',
  ]
  say(`rc dry-run: ${manifest.release}`)
  say(`workflow ref: ${ref}`)
  say('publishing: off')
  if (options.flags.has('print-command')) {
    say(`gh ${args.map(shellArg).join(' ')}`)
    return
  }
  if (manifest.source.dirty && !options.flags.has('allow-dirty')) {
    die(`dirty tree; commit/stash, use --local, or pass --allow-dirty`)
  }
  const remote = remoteSha(ref)
  if (!remote) die(`origin ref not found: ${ref}`)
  if (!options.flags.has('allow-stale-ref') && ref === currentBranch() && remote !== headSha()) {
    die(`origin/${ref} differs from HEAD; push, choose --ref, or pass --allow-stale-ref`)
  }
  execFileSync('gh', args, { cwd: repoRoot, stdio: 'inherit' })
  say(`queued: ${manifest.release}`)
  say('monitor: gh run list --workflow release.yml --limit 5')
}

function shellArg(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function simulateWorkflow(manifest) {
  const path = manifestPath(manifest)
  say(`rc dry-run: ${manifest.release}`)
  say(`workflow: .github/workflows/release.yml`)
  say(`trigger: tag ${manifest.release}`)
  say(`mode: ${manifest.mode}`)
  say('publishing: off')
  say()
  say('metadata')
  say(`  manifest: ${path}`)
  say(`  helm: ${manifest.helm.chartVersion}`)
  say(`  app/image: ${manifest.version}`)
  say(`  binaries: ${manifest.version}`)
  say()
  say(`jobs`)
  say(`  context`)
  say('    check maintainer, tag, manifest')
  say(`  archives`)
  say('    install deps, build TypeScript, build binaries')
  say('    archives:')
  for (const name of archiveTargets) say(`      ${name}-${manifest.release}.${name.includes('windows') ? 'zip' : 'tar.gz'}`)
  say('    checksums, smoke tests, provenance')
  say(`  serviceImages`)
  for (const [name, context, dockerfile] of imageBuilds.filter(([name]) => name !== 'runtime')) {
    say(`    ${name}: ${dockerfile} (${context})`)
  }
  say('    push only on tag workflow')
  say(`  runtimeImage`)
  say(`    apps/runtime/Dockerfile -> ${manifest.images.runtime}`)
  say('    push only on tag workflow')
  say(`  githubRelease`)
  say(`    prerelease: ${manifest.release}`)
  say('    attach archives, manifest, sums, installers')
  say(`  postValidate`)
  say(`    release=${manifest.release}`)
  say(`  promoteStable`)
  say('    skipped for rc')
  say()
  say(JSON.stringify({ manifest: path, ...manifest }, null, 2))
}

function clean(options) {
  const manifest = loadManifest(options.values.manifest)
  rmSync(dirname(manifestPath(manifest)), { recursive: true, force: true })
  say(`cleaned: ${manifest.release}`)
}

function stamp(options) {
  const diff = computeStamp()
  if (options.flags.has('check')) {
    if (diff.length === 0) {
      say('no drift')
      return
    }
    for (const change of diff) say(`drift: ${change.path}`)
    process.exit(1)
  }
  if (diff.length === 0) {
    say('already in sync')
    return
  }
  applyStamp(diff)
  for (const change of diff) say(`stamped: ${change.path}`)
}

function stableTagFromRc(rcTag) {
  const match = rcTag.match(/^(v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?)-rc\.(?:sha[0-9A-Za-z]+|[0-9]+)$/)
  if (!match) die(`not an rc tag: ${rcTag}`)
  return match[1]
}

function stripNpmRc(version) {
  return version.replace(/-rc\.(?:sha[0-9A-Za-z]+|[0-9]+)$/, '')
}

function promote(options) {
  const fromTag = options.values.from
  if (!fromTag) die('--from <rc-tag> required')
  const stableTag = options.values.to ?? stableTagFromRc(fromTag)
  const stableVersion = stableTag.replace(/^v/, '')
  const rcManifestPath = join(repoRoot, 'releases', fromTag, 'manifest.json')
  if (!existsSync(rcManifestPath)) die(`rc manifest not found: ${rcManifestPath}`)
  const rcManifest = JSON.parse(readFileSync(rcManifestPath, 'utf8'))
  if (rcManifest.mode !== 'rc') die(`source manifest is not rc: ${rcManifest.mode}`)
  if (rcManifest.release !== fromTag) die(`manifest release ${rcManifest.release} does not match ${fromTag}`)
  const reg = registries(options)
  const npm = Object.fromEntries(Object.entries(rcManifest.npm ?? {}).map(([name, ver]) => [name, stripNpmRc(ver)]))
  const pypi = Object.fromEntries(
    Object.entries(npm).map(([name, ver]) => {
      const pyName = name.replace(/^@caracalai\//, 'caracalai-')
      return [pyName, stripNpmRc(rcManifest.pypi?.[pyName] ?? ver).replace(/rc[0-9]+(\+sha[0-9A-Za-z]+)?$/, '')]
    }),
  )
  const manifest = {
    release: stableTag,
    mode: 'stable',
    publishedAt: currentDate(),
    version: stableVersion,
    baseVersion: stableVersion,
    sha: rcManifest.sha,
    generatedAt: new Date().toISOString(),
    promotedFrom: fromTag,
    registries: reg,
    binaries: { runtime: stableVersion, console: stableVersion },
    runtimeImage: stableVersion,
    containers: Object.fromEntries(Object.keys(rcManifest.containers ?? {}).map((name) => [name, stableVersion])),
    helm: { chartVersion: helmChartVersion(stableVersion), appVersion: stableVersion, imageTag: stableVersion },
    images: Object.fromEntries(
      Object.keys(rcManifest.images ?? {}).map((name) => [name, `${reg.oci.replace(/\/$/, '')}/caracal-${name}:${stableTag}`]),
    ),
    sourceImages: rcManifest.images,
    npm,
    pypi,
    packages: {
      published: { npm, pypi },
      unchanged: { npm: {}, pypi: {} },
    },
    githubRelease: {
      tag: stableTag,
      assets: `${reg.githubReleases.replace(/\/$/, '')}/${stableTag}`,
    },
  }
  const outPath = writeManifest(manifest)
  say(`promoted: ${fromTag} -> ${stableTag}`)
  say(outPath)
  say('next: retag images via CI, then push tag')
}

function main() {
  const raw = process.argv.slice(2)
  const normalized = raw[0] === 'rc' && !['-h', '--help', undefined].includes(raw[1]) ? [`rc-${raw[1]}`, ...raw.slice(2)] : raw
  const options = parseArgs(normalized)
  switch (options.command) {
    case 'rc':
      say(`Usage: scripts/release.sh rc <command> [options]

Commands:
  dry-run                Queue release.yml without publishing.
  version                Write an rc manifest.
  prepare                Write manifest and stamp rc metadata.
  clean --manifest PATH  Remove an rc manifest.`)
      break
    case 'stable':
      stable(options)
      break
    case 'stamp':
      stamp(options)
      break
    case 'promote':
      promote(options)
      break
    case 'rc-version':
      printVersion(options)
      break
    case 'rc-dry-run':
      dryRun(options)
      break
    case 'rc-prepare':
      prepare(options)
      break
    case 'rc-clean':
      clean(options)
      break
    case '-h':
    case '--help':
    case undefined:
      say(`Usage: scripts/release.sh <command> [options]

Commands:
  stable [--dry-run]      Prepare or publish stable.
  stamp [--check]         Stamp artifact files from release.config.json.
  promote --from TAG      Promote an rc tag to stable (retag, no rebuild).
  rc dry-run              Queue release.yml without publishing.
  rc version              Write an rc manifest.
  rc prepare              Write manifest and stamp rc metadata.
  rc clean --manifest PATH Remove an rc manifest.

Options:
  --base-version VER      Base version. Default: UTC CalVer.
  --from TAG              Source rc tag for promote.
  --to TAG                Override target stable tag for promote.
  --suffix VALUE          rc suffix. Default: rc.sha<gitsha>.
  --package-suffix VALUE  Package rc suffix when it differs from the tag suffix. Default: --suffix.
  --ref REF               Dry-run ref. Default: current branch.
  --manifest PATH|TAG     rc manifest path or tag.
  --npm-registry URL      npm registry.
  --pypi-index URL        Python index.
  --oci-registry HOST     OCI namespace.
  --github-release-base   GitHub asset base.
  --local                 Print local simulation.
  --print-command         Print gh command.
  --allow-dirty           Dispatch even with local changes.
  --allow-stale-ref       Allow remote/local ref drift.`)
      break
    default:
      die(`unknown command: ${options.command}`)
  }
}

main()
