#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Creates and validates immutable minor-version documentation snapshots.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docsRoot = join(repoRoot, 'docs')
const statePath = join(docsRoot, 'versions.json')
const stateRepoPath = 'docs/versions.json'
const minorPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const releasePattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const digestPattern = /^sha256:[a-f0-9]{64}$/
const docsRequire = createRequire(join(docsRoot, 'package.json'))

function die(message) {
  process.stderr.write(`docs-version: ${message}\n`)
  process.exit(1)
}

function readState(path = statePath) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeState(state) {
  const temp = `${statePath}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temp, statePath)
}

export function parseReleaseVersion(value) {
  const match = value?.match(releasePattern)
  if (!match) throw new Error(`release '${value}' must be a stable X.Y.Z version`)
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return {
    version: `${major}.${minor}.${patch}`,
    release: `v${major}.${minor}.${patch}`,
    minor: `v${major}.${minor}`,
    major,
    minorNumber: minor,
    patch,
  }
}

function parseMinor(value) {
  const match = value?.match(minorPattern)
  if (!match) throw new Error(`documentation version '${value}' must match vX.Y`)
  return [Number(match[1]), Number(match[2])]
}

function compareMinor(left, right) {
  const [leftMajor, leftMinor] = parseMinor(left)
  const [rightMajor, rightMinor] = parseMinor(right)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

export function validateState(state) {
  if (!state || typeof state !== 'object') throw new Error('docs/versions.json must contain an object')
  if (state.schemaVersion !== 1) throw new Error('docs/versions.json schemaVersion must be 1')
  if (state.target !== null) parseMinor(state.target)
  if (state.current !== null) parseMinor(state.current)
  if (!Array.isArray(state.versions)) throw new Error('docs/versions.json versions must be an array')

  if (state.current === null) {
    if (state.versions.length > 0) throw new Error('documentation versions require a current stable minor')
    if (state.target === null) throw new Error('the first documentation release requires a target minor')
    return state
  }

  if (state.target !== null) throw new Error('target must be null after the first documentation release')
  if (state.versions.length === 0 || state.versions[0].version !== state.current) {
    throw new Error('the first documentation version must be the current stable minor')
  }

  const seen = new Set()
  for (const [index, entry] of state.versions.entries()) {
    parseMinor(entry.version)
    if (seen.has(entry.version)) throw new Error(`duplicate documentation version: ${entry.version}`)
    seen.add(entry.version)

    const release = parseReleaseVersion(entry.release)
    if (release.minor !== entry.version || release.patch !== 0) {
      throw new Error(`${entry.version} must originate from its X.Y.0 stable release`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.releasedAt)) {
      throw new Error(`${entry.version} releasedAt must use YYYY-MM-DD`)
    }
    if (index > 0 && compareMinor(state.versions[index - 1].version, entry.version) <= 0) {
      throw new Error('documentation versions must be ordered newest first')
    }

    if (index === 0) {
      if (entry.locked !== false || entry.digest !== null) {
        throw new Error(`${entry.version} must remain writable while it is current`)
      }
    } else if (entry.locked !== true || !digestPattern.test(entry.digest)) {
      throw new Error(`${entry.version} must be locked with a SHA-256 digest`)
    }
  }

  return state
}

function versionContentDir(version) {
  return join(docsRoot, 'src', 'content', 'docs', version)
}

function versionConfigPath(version) {
  return join(docsRoot, 'src', 'content', 'versions', `${version}.json`)
}

function listFiles(path, output = []) {
  if (!existsSync(path)) return output
  const stats = lstatSync(path)
  if (!stats.isDirectory()) {
    output.push(path)
    return output
  }
  for (const entry of readdirSync(path)) listFiles(join(path, entry), output)
  return output
}

function versionFiles(version) {
  const files = [...listFiles(versionContentDir(version))]
  if (existsSync(versionConfigPath(version))) files.push(versionConfigPath(version))

  for (const root of [join(docsRoot, 'src', 'assets'), join(docsRoot, 'public')]) {
    for (const file of listFiles(root)) {
      if (relative(root, file).split(sep).includes(version)) files.push(file)
    }
  }

  return [...new Set(files)].sort()
}

function versionDigest(version) {
  const files = versionFiles(version)
  if (files.length === 0) throw new Error(`documentation snapshot ${version} is missing`)

  const hash = createHash('sha256')
  for (const file of files) {
    const path = relative(docsRoot, file).split(sep).join('/')
    const stats = lstatSync(file)
    hash.update(`${stats.isSymbolicLink() ? 'link' : 'file'}\0${path}\0`)
    hash.update(stats.isSymbolicLink() ? readlinkSync(file) : readFileSync(file))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function assertSnapshot(version) {
  if (!existsSync(versionContentDir(version))) throw new Error(`missing documentation content for ${version}`)
  if (!existsSync(versionConfigPath(version))) throw new Error(`missing sidebar snapshot for ${version}`)
  JSON.parse(readFileSync(versionConfigPath(version), 'utf8'))
}

function verifyStateFiles(state) {
  for (const entry of state.versions) {
    assertSnapshot(entry.version)
    if (entry.locked && versionDigest(entry.version) !== entry.digest) {
      throw new Error(`${entry.version} is locked and its snapshot has changed`)
    }
  }
}

function verifyBase(state, ref) {
  if (!ref) return

  let base
  try {
    base = JSON.parse(
      execFileSync('git', ['show', `${ref}:${stateRepoPath}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
  } catch {
    return
  }
  validateState(base)

  for (const entry of base.versions.filter((version) => version.locked)) {
    const current = state.versions.find((version) => version.version === entry.version)
    if (JSON.stringify(current) !== JSON.stringify(entry)) {
      throw new Error(`${entry.version} was already locked in ${ref} and cannot be changed`)
    }
  }
}

function verifyArtifact(state, artifactPath) {
  const artifact = resolve(repoRoot, artifactPath)
  const cname = join(artifact, 'CNAME')
  if (!existsSync(cname) || readFileSync(cname, 'utf8').trim() !== 'docs.caracal.run') {
    throw new Error('documentation artifact is missing the docs.caracal.run CNAME')
  }

  if (!state.current) {
    if (!existsSync(join(artifact, 'index.html'))) throw new Error('documentation artifact is missing index.html')
    return
  }

  for (const entry of state.versions) {
    if (!existsSync(join(artifact, entry.version, 'index.html'))) {
      throw new Error(`documentation artifact is missing ${entry.version}/index.html`)
    }
  }
  if (!existsSync(join(artifact, 'next', 'index.html'))) throw new Error('documentation artifact is missing next/index.html')

  const root = join(artifact, 'index.html')
  if (!existsSync(root) || !readFileSync(root, 'utf8').includes(`/${state.current}/`)) {
    throw new Error(`documentation root does not redirect to ${state.current}`)
  }

  const current = readFileSync(join(artifact, state.current, 'index.html'), 'utf8')
  if (!current.includes('caracal-version-select')) throw new Error('documentation artifact is missing the version selector')
}

function snapshotPlan(state, value) {
  const release = parseReleaseVersion(value)
  if (state.current === release.minor) return { release, create: false }
  if (release.patch !== 0) throw new Error(`a new documentation minor must be created by ${release.minor}.0`)
  if (state.target && state.target !== release.minor) {
    throw new Error(`the first documentation release target is ${state.target}, not ${release.minor}`)
  }
  if (state.current && compareMinor(release.minor, state.current) <= 0) {
    throw new Error(`new documentation minor ${release.minor} must be newer than ${state.current}`)
  }
  if (existsSync(versionContentDir(release.minor)) || existsSync(versionConfigPath(release.minor))) {
    throw new Error(`${release.minor} snapshot exists but is not registered`)
  }
  return { release, create: true }
}

function removeVersionDirectories(root, version) {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name === version) rmSync(path, { recursive: true, force: true })
    else removeVersionDirectories(path, version)
  }
}

function rollbackSnapshot(version, state) {
  writeState(state)
  rmSync(versionContentDir(version), { recursive: true, force: true })
  rmSync(versionConfigPath(version), { force: true })
  removeVersionDirectories(join(docsRoot, 'src', 'assets'), version)
  removeVersionDirectories(join(docsRoot, 'public'), version)
}

function snapshot(value) {
  const state = validateState(readState())
  verifyStateFiles(state)
  const plan = snapshotPlan(state, value)
  if (!plan.create) {
    process.stdout.write(`docs-version: ${plan.release.minor} remains the current documentation version; no snapshot created\n`)
    return
  }

  const stateBefore = structuredClone(state)
  if (state.current) {
    const current = state.versions[0]
    current.locked = true
    current.digest = versionDigest(current.version)
  }
  state.current = plan.release.minor
  state.target = null
  state.versions.unshift({
    version: plan.release.minor,
    release: plan.release.release,
    releasedAt: new Date().toISOString().slice(0, 10),
    locked: false,
    digest: null,
  })
  writeState(state)

  try {
    const astroPackage = docsRequire.resolve('astro/package.json')
    const astro = join(dirname(astroPackage), JSON.parse(readFileSync(astroPackage, 'utf8')).bin.astro)
    execFileSync(process.execPath, [astro, 'build'], {
      cwd: docsRoot,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', CARACAL_DOCS_SNAPSHOT: '1' },
      stdio: 'inherit',
    })
    const verified = validateState(readState())
    verifyStateFiles(verified)
  } catch (error) {
    rollbackSnapshot(plan.release.minor, stateBefore)
    throw error
  }

  process.stdout.write(
    `docs-version: created ${plan.release.minor}; ${stateBefore.current ?? 'unversioned docs'} is no longer the default\n`,
  )
}

function parseVerifyArgs(args) {
  let base = ''
  let artifact = ''
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--base') base = args[++index] ?? ''
    else if (args[index] === '--artifact') artifact = args[++index] ?? ''
    else throw new Error(`unknown verify option: ${args[index]}`)
  }
  return { base, artifact }
}

function verify(args) {
  const options = parseVerifyArgs(args)
  const state = validateState(readState())
  verifyStateFiles(state)
  verifyBase(state, options.base)
  if (options.artifact) verifyArtifact(state, options.artifact)
  process.stdout.write(`docs-version: verified ${state.current ?? state.target} documentation state\n`)
}

function plan(value) {
  const state = validateState(readState())
  verifyStateFiles(state)
  const result = snapshotPlan(state, value)
  process.stdout.write(
    result.create
      ? `docs-version: ${result.release.release} will create ${result.release.minor} and lock ${state.current ?? 'no previous version'}\n`
      : `docs-version: ${result.release.release} stays on ${result.release.minor}; no documentation snapshot will be created\n`,
  )
}

function usage() {
  process.stdout.write(`Usage: node scripts/docsVersion.mjs <command> [options]

Commands:
  verify [--base REF] [--artifact DIR]  Validate metadata, locks, and an optional build.
  plan X.Y.Z                          Validate the documentation action for a stable release.
  snapshot X.Y.Z                      Snapshot a new stable minor or no-op for a patch.
`)
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  try {
    switch (command) {
      case 'verify':
        verify(args)
        break
      case 'plan':
        if (args.length !== 1) throw new Error('plan requires one stable X.Y.Z version')
        plan(args[0])
        break
      case 'snapshot':
        if (args.length !== 1) throw new Error('snapshot requires one stable X.Y.Z version')
        snapshot(args[0])
        break
      case '-h':
      case '--help':
      case undefined:
        usage()
        break
      default:
        throw new Error(`unknown command: ${command}`)
    }
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
