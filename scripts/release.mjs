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
import { ensureRemoteReleaseTags, releaseTags } from './releaseTags.mjs'
import { verifyReleasePromotion } from './verifyReleasePromotion.mjs'
import { applyStamp, computeStamp, pypiFromNpm } from './lib/stamp.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inventory = releaseInventory()

const npmNames = inventory.packages.npm.map((pkg) => pkg.name)
const pypiNames = inventory.packages.pypi.map((pkg) => pkg.name)
const goModules = inventory.packages.go.filter((mod) => mod.publish)
const productImages = productContainers(inventory.config)
const containers = productImages.filter((image) => image.name !== 'runtime').map((image) => image.name)
const archiveTargets = productArchiveTargets(inventory.config).map((target) => `caracal-runtime-${target.os}-${target.arch}`)
const imageBuilds = productImages.map((image) => [image.name, image.context, image.dockerfile])
const releaseTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/

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

function prepareDocsVersion(version, dryRun = false) {
  execFileSync('node', ['scripts/docsVersion.mjs', dryRun ? 'plan' : 'snapshot', version], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
}

function parseArgs(argv) {
  const args = { command: argv[0], values: {}, flags: new Set() }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) die(`unexpected positional argument: ${arg}`)
    const key = arg.slice(2)
    if (['manifest', 'npm-registry', 'pypi-index', 'oci-registry', 'github-release-base', 'ref', 'from', 'to'].includes(key)) {
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
  const refs = [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]
  for (const candidate of refs) {
    const out = run('git', ['ls-remote', 'origin', candidate]).trim()
    if (out) return out.split(/\s+/, 1)[0]
  }
  return ''
}

function currentDate() {
  const date = new Date()
  return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, '0')}-${`${date.getUTCDate()}`.padStart(2, '0')}`
}

function rcVersion() {
  const version = inventory.config.product.version
  return version.includes('-rc.') ? version : `${version}-rc.sha${shortSha()}`
}

function numberedRcVersion() {
  const version = inventory.config.product.version
  if (!/-rc\.[0-9]+$/.test(version)) {
    die(`product.version must be a numbered rc (X.Y.Z-rc.N) to prepare a release; got ${version}`)
  }
  return version
}

function packageVersions(version) {
  const pypiVersion = pypiFromNpm(version)
  return {
    npm: Object.fromEntries(npmNames.map((name) => [name, version])),
    pypi: Object.fromEntries(pypiNames.map((name) => [name, pypiVersion])),
    go: Object.fromEntries(goModules.map((mod) => [mod.module, version])),
  }
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

function makeManifest(options = {}) {
  const version = rcVersion()
  const tag = `v${version}`
  const { npm, pypi, go } = packageVersions(version)
  const reg = registries(options)
  return {
    release: tag,
    mode: 'rc',
    version,
    generatedAt: new Date().toISOString(),
    registries: reg,
    binaries: { runtime: version },
    runtimeImage: version,
    containers: Object.fromEntries(containers.map((name) => [name, version])),
    helm: { chartVersion: version, appVersion: version, imageTag: version },
    images: Object.fromEntries(
      [...containers, 'runtime'].map((name) => [name, `${reg.oci.replace(/\/$/, '')}/caracal-${name}:v${version}`]),
    ),
    npm,
    pypi,
    packages: {
      published: { npm, pypi, go },
      unchanged: { npm: {}, pypi: {}, go: {} },
    },
    githubRelease: {
      tag,
      assets: `${reg.githubReleases.replace(/\/$/, '')}/${tag}`,
    },
  }
}

function makeStableManifest(version, tag, options = {}, promotedFrom) {
  if (!promotedFrom) die('stable manifests require a promotedFrom release candidate')
  const { npm, pypi, go } = packageVersions(version)
  const reg = registries(options)
  const manifest = {
    release: tag,
    mode: 'stable',
    publishedAt: currentDate(),
    version,
    generatedAt: new Date().toISOString(),
    registries: reg,
    binaries: { runtime: version },
    runtimeImage: version,
    containers: Object.fromEntries(containers.map((name) => [name, version])),
    helm: { chartVersion: version, appVersion: version, imageTag: version },
    images: Object.fromEntries([...containers, 'runtime'].map((name) => [name, `${reg.oci.replace(/\/$/, '')}/caracal-${name}:${tag}`])),
    pypi,
    npm,
    packages: {
      published: { npm, pypi, go },
      unchanged: { npm: {}, pypi: {}, go: {} },
    },
    githubRelease: {
      tag,
      assets: `${reg.githubReleases.replace(/\/$/, '')}/${tag}`,
    },
  }
  manifest.promotedFrom = promotedFrom
  return manifest
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

function writeReleaseRecord(manifest) {
  execFileSync('node', ['scripts/generateReleaseRecord.mjs', manifestPath(manifest)], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
}

function dispatchRelease(tag, dryRun) {
  const sha = headSha()
  execFileSync(
    'gh',
    [
      'workflow',
      'run',
      'release.yml',
      '--ref',
      tag,
      '-f',
      `ref=${dryRun ? sha : `refs/tags/${tag}`}`,
      '-f',
      `releaseVersion=${tag}`,
      '-f',
      `sourceSha=${sha}`,
      '-f',
      `dryRun=${dryRun}`,
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  )
}

function successfulReleaseRun(tag, sha, mode) {
  const title = `Caracal ${tag} ${mode} ${sha}`
  const runs = JSON.parse(
    run('gh', ['api', `repos/Garudex-Labs/caracal/actions/workflows/release.yml/runs?event=workflow_dispatch&status=success&per_page=100`]),
  ).workflow_runs
  return runs.some(
    (workflow) =>
      workflow.display_title === title && workflow.head_branch === tag && workflow.head_sha === sha && workflow.conclusion === 'success',
  )
}

function publishRelease(version) {
  const tag = `v${version}`
  const sha = headSha()
  const tags = releaseTags(inventory.config, version)
  const result = ensureRemoteReleaseTags(repoRoot, tags, sha)
  say(`${result.created ? 'published' : 'verified'} ${tags.length} release tags at ${sha}`)
  if (!successfulReleaseRun(tag, sha, 'dry-run')) {
    dispatchRelease(tag, true)
    say(`queued immutable release dry-run for ${tag}`)
    say('rerun this publish command after the dry-run succeeds')
    say('monitor: gh run list --workflow release.yml --limit 5')
    return
  }
  dispatchRelease(tag, false)
  say(`queued release workflow for ${tag}`)
  say('monitor: gh run list --workflow release.yml --limit 5')
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
  const version = inventory.config.product.version
  if (version.includes('-rc.')) die(`product.version ${version} is an rc; set a stable X.Y.Z version or use promote`)
  const tag = `v${version}`
  const manifest = join('releases', tag, 'manifest.json')
  if (!existsSync(join(repoRoot, manifest))) die(`manifest missing for ${tag}; prepare and commit the stable release first`)
  const releaseManifest = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'))
  if (!releaseManifest.promotedFrom) die(`${tag} must be prepared from a published release candidate`)
  execFileSync('node', ['scripts/validateReleaseManifest.mjs', '--product-version', manifest], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CARACAL_VALIDATE_HELM_FILES: '1' },
  })
  const drift = computeStamp()
  if (drift.length > 0) {
    for (const change of drift) say(`drift: ${change.path}`)
    die('artifact files do not match release.config.json; run scripts/release.sh promote and commit')
  }
  verifyReleasePromotion(repoRoot, releaseManifest.promotedFrom, tag)
  say(`stable: ${tag}`)
  execFileSync('node', ['scripts/docsVersion.mjs', 'verify'], { cwd: repoRoot, stdio: 'inherit' })
  if (dryRun) {
    if (options.flags.has('local')) {
      say(JSON.stringify({ manifest: join(repoRoot, manifest), ...JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')) }, null, 2))
      say('local dry-run complete')
      return
    }
    if (branch !== 'main') die(`stable dry-run must run from main (current: ${branch})`)
    const remote = remoteSha(branch)
    if (!remote || remote !== headSha()) die('origin/main differs from HEAD; push the stable release commit before dry-run')
    execFileSync(
      'gh',
      [
        'workflow',
        'run',
        'release.yml',
        '--ref',
        branch,
        '-f',
        `ref=${headSha()}`,
        '-f',
        `releaseVersion=${tag}`,
        '-f',
        `sourceSha=${headSha()}`,
        '-f',
        'dryRun=true',
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    )
    say(`queued stable dry-run for ${tag}`)
    say('monitor: gh run list --workflow release.yml --limit 5')
    return
  }
  publishRelease(version)
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

function prepare(options) {
  if (dirtyTree() && !options.flags.has('allow-dirty')) die('dirty tree; commit/stash or pass --allow-dirty')
  const version = numberedRcVersion()
  const tag = `v${version}`
  if (remoteSha(tag)) die(`remote tag already exists: ${tag}`)
  execFileSync('node', ['scripts/checkReleaseVersions.mjs', '--version', version], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync('node', ['scripts/checkOciVersions.mjs', '--all'], { cwd: repoRoot, stdio: 'inherit' })
  const diff = computeStamp()
  applyStamp(diff)
  for (const change of diff) say(`stamped: ${change.path}`)
  const manifest = makeManifest(options.values)
  const path = writeManifest(manifest)
  writeReleaseRecord(manifest)
  say(`prepared: ${manifest.release}`)
  say(path)
}

function publishRc() {
  if (dirtyTree()) die('dirty tree; commit or stash first')
  const version = numberedRcVersion()
  const tag = `v${version}`
  const branch = currentBranch()
  if (branch !== 'main') die(`rc publish must run from main (current: ${branch})`)
  execFileSync('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repoRoot, stdio: 'inherit' })
  if (headSha() !== run('git', ['rev-parse', 'origin/main']).trim()) die('main is behind origin/main')
  const manifest = join('releases', tag, 'manifest.json')
  if (!existsSync(join(repoRoot, manifest))) die(`manifest missing for ${tag}; run rc prepare first`)
  execFileSync('node', ['scripts/validateReleaseManifest.mjs', '--product-version', manifest], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CARACAL_VALIDATE_HELM_FILES: '1' },
  })
  const drift = computeStamp()
  if (drift.length > 0) {
    for (const change of drift) say(`drift: ${change.path}`)
    die('artifact files do not match release.config.json; run rc prepare and commit')
  }
  publishRelease(version)
}

function printVersion(options) {
  const version = numberedRcVersion()
  const tag = `v${version}`
  if (remoteSha(tag)) die(`remote tag already exists: ${tag}`)
  execFileSync('node', ['scripts/checkReleaseVersions.mjs', '--version', version], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync('node', ['scripts/checkOciVersions.mjs', '--all'], { cwd: repoRoot, stdio: 'inherit' })
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
  const sourceSha = releaseTagPattern.test(ref) ? remoteSha(ref) : headSha()
  if (!sourceSha) die(`origin ref not found: ${ref}`)
  const args = [
    'workflow',
    'run',
    'release.yml',
    '--ref',
    ref,
    '-f',
    `ref=${sourceSha}`,
    '-f',
    `releaseVersion=${manifest.release}`,
    '-f',
    `sourceSha=${sourceSha}`,
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
  if (dirtyTree() && !options.flags.has('allow-dirty')) {
    die(`dirty tree; commit/stash, use --local, or pass --allow-dirty`)
  }
  const remote = remoteSha(ref)
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
  say(`dispatch ref: ${manifest.release}`)
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
  say('    push only on release publish dispatch')
  say(`  runtimeImage`)
  say(`    apps/runtime/Dockerfile -> ${manifest.images.runtime}`)
  say('    push only on release publish dispatch')
  say(`  githubRelease`)
  say(`    prerelease: ${manifest.release}`)
  say('    attach archives, manifest, sums, installers')
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
  const match = rcTag.match(/^(v[0-9]+\.[0-9]+\.[0-9]+)-rc\.[0-9]+$/)
  if (!match) die(`not a numbered rc tag: ${rcTag}`)
  return match[1]
}

function promote(options) {
  if (dirtyTree()) die('dirty tree; commit or stash first')
  const fromTag = options.values.from
  if (!fromTag) die('--from <rc-tag> required')
  const stableTag = options.values.to ?? stableTagFromRc(fromTag)
  const stableVersion = stableTag.replace(/^v/, '')
  if (remoteSha(stableTag)) die(`remote tag already exists: ${stableTag}`)
  verifyReleasePromotion(repoRoot, fromTag, stableTag, true)
  execFileSync('node', ['scripts/checkReleaseVersions.mjs', '--version', stableVersion], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync('node', ['scripts/checkOciVersions.mjs', '--version', stableVersion, '--all'], { cwd: repoRoot, stdio: 'inherit' })
  const configPath = join(repoRoot, 'release.config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.product.version = stableVersion
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const stamped = computeStamp()
  applyStamp(stamped)
  for (const change of stamped) say(`stamped: ${change.path}`)
  prepareDocsVersion(stableVersion)
  const manifest = makeStableManifest(stableVersion, stableTag, options.values, fromTag)
  const outPath = writeManifest(manifest)
  writeReleaseRecord(manifest)
  say(`prepared stable rebuild: ${fromTag} -> ${stableTag}`)
  say(outPath)
  say('next: review and commit the stable release, run scripts/release.sh stable --dry-run, then scripts/release.sh stable')
}

function main() {
  const raw = process.argv.slice(2)
  let normalized = raw
  if (raw[0] === 'rc' && !['-h', '--help', undefined].includes(raw[1])) normalized = [`rc-${raw[1]}`, ...raw.slice(2)]
  const options = parseArgs(normalized)
  switch (options.command) {
    case 'rc':
      say(`Usage: scripts/release.sh rc <command> [options]

Commands:
  dry-run                Queue release.yml without publishing.
  version                Write an rc manifest.
  prepare                Stamp files and write the rc manifest.
  publish                Create and atomically push the release and Go module tags.
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
    case 'rc-publish':
      publishRc()
      break
    case 'rc-clean':
      clean(options)
      break
    case '-h':
    case '--help':
    case undefined:
      say(`Usage: scripts/release.sh <command> [options]

Commands:
  stable [--dry-run]      Publish a prepared stable release.
  stamp [--check]         Stamp artifact files from release.config.json.
  promote --from TAG      Prepare a stable rebuild from an approved rc.
  rc dry-run              Queue release.yml without publishing.
  rc version              Write an rc manifest.
  rc prepare              Stamp files and write the rc manifest.
  rc publish              Create and atomically push rc tags.
  rc clean --manifest PATH Remove an rc manifest.

Options:
  --from TAG              Source rc tag for promote.
  --to TAG                Override target stable tag for promote.
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
