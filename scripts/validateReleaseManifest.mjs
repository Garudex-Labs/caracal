// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Release manifest validator for committed Caracal release metadata.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const files = process.argv.slice(2)

function fail(message) {
  throw new Error(message)
}

function chartVersion(value) {
  const [core, pre] = value.split('-', 2)
  const parts = core.split('.')
  const recut = parts[3]
  const base = `${Number(parts[0])}.${Number(parts[1])}.${Number(parts[2])}`
  return `${base}${pre ? `-${pre}` : ''}${recut ? `+${recut}` : ''}`
}

function manifestFiles() {
  if (files.length > 0) return files
  const releases = join(repoRoot, 'releases')
  return readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
    .map((entry) => join(releases, entry.name, 'manifest.json'))
}

function assertVersions(group, values, version) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail(`${group} must be an object`)
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.length === 0) fail(`${group} ${name} must have a version`)
    if (/dev\.sha|dev\./.test(value)) fail(`${group} ${name} has dev version ${value}`)
    if ((group === 'binaries' || group === 'containers') && value !== version) {
      fail(`${group} ${name} version ${value} does not match ${version}`)
    }
  }
}

function validate(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (!manifest.release?.startsWith('v')) fail(`${path}: release must start with v`)
  const version = manifest.release.slice(1)
  const mode = version.includes('-rc.') ? 'rc' : 'stable'
  const packages = manifest.packages?.published ?? {}
  const npm = packages.npm ?? manifest.npm ?? {}
  const pypi = packages.pypi ?? manifest.pypi ?? {}
  if (manifest.mode !== mode) fail(`${path}: mode ${manifest.mode} does not match ${mode}`)
  assertVersions('binaries', manifest.binaries, version)
  assertVersions('containers', manifest.containers, version)
  assertVersions('npm', npm, version)
  assertVersions('pypi', pypi, version)
  if (manifest.runtimeImage !== version) fail(`${path}: runtimeImage ${manifest.runtimeImage} does not match ${version}`)
  const expectedChartVersion = chartVersion(version)
  if (!manifest.helm || typeof manifest.helm !== 'object') fail(`${path}: helm metadata is required`)
  if (manifest.helm.chartVersion !== expectedChartVersion)
    fail(`${path}: helm chartVersion ${manifest.helm.chartVersion} does not match ${expectedChartVersion}`)
  if (manifest.helm.appVersion !== version) fail(`${path}: helm appVersion ${manifest.helm.appVersion} does not match ${version}`)
  if (manifest.helm.imageTag !== version) fail(`${path}: helm imageTag ${manifest.helm.imageTag} does not match ${version}`)
  if (process.env.CARACAL_VALIDATE_HELM_FILES === '1') {
    const chart = readFileSync(join(repoRoot, 'infra/helm/caracal/Chart.yaml'), 'utf8')
    const values = readFileSync(join(repoRoot, 'infra/helm/caracal/values.yaml'), 'utf8')
    const chartFileVersion = chart.match(/^version: ([^ \n]+)/m)?.[1]
    const appVersion = chart.match(/^appVersion: "([^"]+)"/m)?.[1]
    const imageTag = values.match(/^  tag: "([^"]+)"/m)?.[1]
    if (chartFileVersion !== manifest.helm.chartVersion)
      fail(`${path}: Chart.yaml version ${chartFileVersion} does not match ${manifest.helm.chartVersion}`)
    if (appVersion !== manifest.helm.appVersion)
      fail(`${path}: Chart.yaml appVersion ${appVersion} does not match ${manifest.helm.appVersion}`)
    if (imageTag !== manifest.helm.imageTag) fail(`${path}: values.yaml global.tag ${imageTag} does not match ${manifest.helm.imageTag}`)
  }
}

for (const file of manifestFiles()) validate(file)
console.log('release manifests ok')
