// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single stamper that writes release.config.json versions into every artifact file.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readReleaseConfig, repoRoot } from '../releaseInventory.mjs'

export function pypiFromNpm(version) {
  const numericRc = version.match(/^([0-9]+\.[0-9]+\.[0-9]+)-rc\.([0-9]+)$/)
  if (numericRc) return `${numericRc[1]}rc${numericRc[2]}`
  const shaRc = version.match(/^([0-9]+\.[0-9]+\.[0-9]+)-rc\.sha([A-Za-z0-9]+)$/)
  if (shaRc) return `${shaRc[1]}rc0+sha${shaRc[2]}`
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return version
  throw new Error(`cannot convert npm version: ${version}`)
}

export function helmChartVersion(value) {
  const [core, pre] = value.split('-', 2)
  const parts = core.split('.')
  const recut = parts[3]
  const base = `${Number(parts[0])}.${Number(parts[1])}.${Number(parts[2])}`
  return `${base}${pre ? `-${pre}` : ''}${recut ? `+${recut}` : ''}`
}

function npmVersionMap(config) {
  return Object.fromEntries(config.packages.npm.map((entry) => [entry.name, entry.version]))
}

function pypiVersionMap(config) {
  const byGroup = Object.fromEntries(config.packages.npm.map((entry) => [entry.group, entry.version]))
  return Object.fromEntries(
    config.packages.pypi.map((entry) => {
      const npmVersion = byGroup[entry.group]
      return [entry.name, npmVersion ? pypiFromNpm(npmVersion) : entry.version]
    }),
  )
}

function stampPackageJson(entry, npmVersions, diff) {
  const path = join(repoRoot, entry.dir, 'package.json')
  const before = readFileSync(path, 'utf8')
  const data = JSON.parse(before)
  data.version = entry.version
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    if (!data[field]) continue
    for (const name of Object.keys(data[field])) {
      if (npmVersions[name]) data[field][name] = npmVersions[name]
    }
  }
  const after = `${JSON.stringify(data, null, 2)}\n`
  if (after !== before) diff.push({ path, before, after })
}

function stampPyproject(entry, pypiVersions, diff) {
  const path = join(repoRoot, entry.dir, 'pyproject.toml')
  const before = readFileSync(path, 'utf8')
  const target = pypiVersions[entry.name] ?? entry.version
  let after = before.replace(/^version = "[^"]+"/m, `version = "${target}"`)
  after = after.replace(/"(caracalai-[a-z0-9-]+)==[^"]+"/g, (match, name) => {
    if (!pypiVersions[name]) return match
    return `"${name}==${pypiVersions[name]}"`
  })
  if (after !== before) diff.push({ path, before, after })
}

const installPinPattern = /((?:--version|-Version) )v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?(?:-rc\.(?:sha[0-9A-Za-z]+|[0-9]+))?/g

export function stampReadmePins(text, productVersion) {
  return text.replace(installPinPattern, `$1v${productVersion}`)
}

function stampReadme(config, diff) {
  const path = join(repoRoot, 'README.md')
  const before = readFileSync(path, 'utf8')
  const after = stampReadmePins(before, config.product.version)
  if (after !== before) diff.push({ path, before, after })
}

function goWorkspaceModulePaths(goWorkText) {
  return [...goWorkText.matchAll(/^\t\.\/(\S+)$/gm)].map((match) => match[1])
}

function stampGoDependencies(text, versions) {
  return text.replace(/(github\.com\/garudex-labs\/caracal\/packages\/[a-z0-9/]+\/go) v[0-9]\S*/g, (match, module) => {
    const version = versions[module]
    return version ? `${module} v${version}` : match
  })
}

function stampGoModules(config, diff) {
  const versions = Object.fromEntries((config.packages.go ?? []).map((entry) => [entry.module, entry.version]))
  const workPath = join(repoRoot, 'go.work')
  const workBefore = readFileSync(workPath, 'utf8')
  const modulePaths = goWorkspaceModulePaths(workBefore).map((dir) => join(repoRoot, dir, 'go.mod'))
  for (const path of [workPath, ...modulePaths]) {
    const before = path === workPath ? workBefore : readFileSync(path, 'utf8')
    const after = stampGoDependencies(before, versions)
    if (after !== before) diff.push({ path, before, after })
  }
}

function stampHelm(config, diff) {
  const productVersion = config.product.version
  const chartPath = join(repoRoot, 'infra/helm/caracal/Chart.yaml')
  const valuesPath = join(repoRoot, 'infra/helm/caracal/values.yaml')
  const chartBefore = readFileSync(chartPath, 'utf8')
  const valuesBefore = readFileSync(valuesPath, 'utf8')
  let chartAfter = chartBefore.replace(/^version: .*/m, `version: ${helmChartVersion(productVersion)}`)
  chartAfter = chartAfter.replace(/^appVersion: .*/m, `appVersion: "${productVersion}"`)
  const valuesAfter = valuesBefore.replace(/^( {2}tag: ).*/m, `$1"${productVersion}"`)
  if (chartAfter !== chartBefore) diff.push({ path: chartPath, before: chartBefore, after: chartAfter })
  if (valuesAfter !== valuesBefore) diff.push({ path: valuesPath, before: valuesBefore, after: valuesAfter })
}

export function computeStamp(config = readReleaseConfig()) {
  if (!config.product?.version) throw new Error('release.config.json missing product.version')
  const npmVersions = npmVersionMap(config)
  const pypiVersions = pypiVersionMap(config)
  const diff = []
  for (const entry of config.packages.npm) {
    if (!entry.version) throw new Error(`release.config.json missing version for ${entry.name}`)
    stampPackageJson(entry, npmVersions, diff)
  }
  for (const entry of config.packages.pypi) {
    stampPyproject(entry, pypiVersions, diff)
  }
  stampGoModules(config, diff)
  stampHelm(config, diff)
  stampReadme(config, diff)
  return diff
}

export function applyStamp(diff) {
  for (const change of diff) writeFileSync(change.path, change.after)
}
