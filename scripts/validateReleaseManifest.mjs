// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Release manifest validator for committed Caracal release metadata.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pypiFromNpm } from './lib/stamp.mjs'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const files = process.argv.slice(2)
const releaseTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/

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

function validate(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (!releaseTagPattern.test(manifest.release ?? '')) fail(`${path}: release must be a vX.Y.Z or vX.Y.Z-rc.N tag`)
  const version = manifest.release.slice(1)
  const mode = version.includes('-rc.') ? 'rc' : 'stable'
  const packages = manifest.packages?.published ?? {}
  const npm = packages.npm ?? manifest.npm ?? {}
  const pypi = packages.pypi ?? manifest.pypi ?? {}
  if (manifest.mode !== mode) fail(`${path}: mode ${manifest.mode} does not match ${mode}`)
  assertVersions('binaries', manifest.binaries, version)
  assertVersions('containers', manifest.containers, version)
  assertVersions('npm', npm, version)
  assertVersions('pypi', pypi, pypiFromNpm(version))
  if (manifest.runtimeImage !== version) fail(`${path}: runtimeImage ${manifest.runtimeImage} does not match ${version}`)
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
}

for (const file of manifestFiles()) validate(file)
console.log('release manifests ok')
