// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Release manifest validator for committed Caracal release metadata.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseInventory } from './releaseInventory.mjs'
import { pypiFromNpm } from './lib/stamp.mjs'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const inventory = releaseInventory()
const args = process.argv.slice(2)
const files = []
let expectedSourceSha = process.env.CARACAL_EXPECT_SOURCE_SHA ?? ''
let requireProductVersion = false
let requireImageDigests = false
const releaseTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/
const sourceShaPattern = /^[0-9a-f]{40}$/

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--source-sha') {
    expectedSourceSha = args[index + 1] ?? ''
    if (!expectedSourceSha) fail('--source-sha requires a value')
    index += 1
  } else if (args[index] === '--product-version') {
    requireProductVersion = true
  } else if (args[index] === '--image-digests') {
    requireImageDigests = true
  } else {
    files.push(args[index])
  }
}

if (expectedSourceSha && !sourceShaPattern.test(expectedSourceSha)) {
  fail(`expected source SHA must be a full lowercase Git commit, got ${expectedSourceSha}`)
}

function fail(message) {
  throw new Error(message)
}

function manifestFiles() {
  if (files.length > 0) return files
  const releases = join(repoRoot, 'releases')
  return readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
    .map((entry) => join(releases, entry.name, 'manifest.json'))
}

function assertVersions(group, values, expected) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail(`${group} must be an object`)
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.length === 0) fail(`${group} ${name} must have a version`)
    if (value !== expected) fail(`${group} ${name} version ${value} does not match ${expected}`)
  }
}

function assertKeys(group, values, expected) {
  const actual = Object.keys(values).sort()
  const names = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(names)) {
    fail(`${group} package names ${actual.join(', ') || '<empty>'} do not match ${names.join(', ')}`)
  }
}

function assertEmpty(group, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail(`${group} must be an object`)
  if (Object.keys(values).length > 0) fail(`${group} must be empty for a lockstep release`)
}

function assertSameMap(group, first, second) {
  if (JSON.stringify(Object.entries(first).sort()) !== JSON.stringify(Object.entries(second).sort())) {
    fail(`${group} top-level and packages.published values do not match`)
  }
}

function validate(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (!releaseTagPattern.test(manifest.release ?? '')) fail(`${path}: release must be a vX.Y.Z or vX.Y.Z-rc.N tag`)
  const version = manifest.release.slice(1)
  const mode = version.includes('-rc.') ? 'rc' : 'stable'
  const packages = manifest.packages?.published
  const unchanged = manifest.packages?.unchanged
  if (!packages || !unchanged) fail(`${path}: packages.published and packages.unchanged are required`)
  const npm = packages.npm
  const pypi = packages.pypi
  const go = packages.go
  if (manifest.mode !== mode) fail(`${path}: mode ${manifest.mode} does not match ${mode}`)
  if (manifest.version !== version) fail(`${path}: version ${manifest.version} does not match ${version}`)
  if (requireProductVersion && version !== inventory.config.product.version) {
    fail(`${path}: version ${version} does not match product.version ${inventory.config.product.version}`)
  }
  assertVersions('binaries', manifest.binaries, version)
  assertVersions('containers', manifest.containers, version)
  assertVersions('npm', npm, version)
  assertVersions('pypi', pypi, pypiFromNpm(version))
  assertVersions('go', go, version)
  if (manifest.npm) {
    assertVersions('top-level npm', manifest.npm, version)
    assertSameMap('npm', manifest.npm, npm)
  }
  if (manifest.pypi) {
    assertVersions('top-level pypi', manifest.pypi, pypiFromNpm(version))
    assertSameMap('pypi', manifest.pypi, pypi)
  }
  assertEmpty('unchanged npm', unchanged.npm)
  assertEmpty('unchanged pypi', unchanged.pypi)
  assertEmpty('unchanged go', unchanged.go)
  assertKeys(
    'npm',
    npm,
    inventory.packages.npm.filter((pkg) => pkg.publish).map((pkg) => pkg.name),
  )
  assertKeys(
    'pypi',
    pypi,
    inventory.packages.pypi.filter((pkg) => pkg.publish).map((pkg) => pkg.name),
  )
  assertKeys(
    'go',
    go,
    inventory.packages.go.filter((pkg) => pkg.publish).map((pkg) => pkg.module),
  )
  if (manifest.runtimeImage !== version) fail(`${path}: runtimeImage ${manifest.runtimeImage} does not match ${version}`)
  if (requireImageDigests) {
    if (!manifest.images || !manifest.imageDigests) fail(`${path}: finalized image references and digests are required`)
    assertKeys('image digests', manifest.imageDigests, Object.keys(manifest.images))
    for (const [name, digest] of Object.entries(manifest.imageDigests)) {
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) fail(`${path}: image digest ${name} is invalid`)
    }
  }
  if (!manifest.helm || typeof manifest.helm !== 'object') fail(`${path}: helm metadata is required`)
  if (manifest.helm.chartVersion !== version) fail(`${path}: helm chartVersion ${manifest.helm.chartVersion} does not match ${version}`)
  if (manifest.helm.appVersion !== version) fail(`${path}: helm appVersion ${manifest.helm.appVersion} does not match ${version}`)
  if (manifest.helm.imageTag !== version) fail(`${path}: helm imageTag ${manifest.helm.imageTag} does not match ${version}`)
  if (process.env.CARACAL_VALIDATE_HELM_FILES === '1') {
    const chart = readFileSync(join(repoRoot, 'infra/helm/caracal/Chart.yaml'), 'utf8')
    const chartFileVersion = chart.match(/^version: ([^ \n]+)/m)?.[1]
    const appVersion = chart.match(/^appVersion: "([^"]+)"/m)?.[1]
    if (chartFileVersion !== manifest.helm.chartVersion)
      fail(`${path}: Chart.yaml version ${chartFileVersion} does not match ${manifest.helm.chartVersion}`)
    if (appVersion !== manifest.helm.appVersion)
      fail(`${path}: Chart.yaml appVersion ${appVersion} does not match ${manifest.helm.appVersion}`)
  }
  const hasSha = Object.hasOwn(manifest, 'sha')
  const hasSource = Object.hasOwn(manifest, 'source')
  if (hasSha !== hasSource) fail(`${path}: sha and source must either both be present or both be absent`)
  if (hasSha) {
    if (!sourceShaPattern.test(manifest.sha)) fail(`${path}: sha must be a full lowercase Git commit`)
    if (!sourceShaPattern.test(manifest.source?.gitSha ?? '')) fail(`${path}: source.gitSha must be a full lowercase Git commit`)
    if (manifest.sha !== manifest.source.gitSha) {
      fail(`${path}: sha ${manifest.sha} does not match source.gitSha ${manifest.source.gitSha}`)
    }
    if (manifest.source.dirty !== false) fail(`${path}: finalized release source must be clean`)
  }
  if (expectedSourceSha) {
    if (!hasSha) fail(`${path}: finalized release source metadata is missing`)
    if (manifest.sha !== expectedSourceSha) fail(`${path}: sha ${manifest.sha} does not match ${expectedSourceSha}`)
    if (manifest.source?.gitSha !== expectedSourceSha) {
      fail(`${path}: source.gitSha ${manifest.source?.gitSha} does not match ${expectedSourceSha}`)
    }
  }
}

for (const file of manifestFiles()) validate(file)
console.log('release manifests ok')
