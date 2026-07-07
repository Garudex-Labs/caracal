// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Single stamper that writes the release.config.json product version into every artifact file.

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readReleaseConfig, repoRoot } from '../releaseInventory.mjs'

export const releaseVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/

export function pypiFromNpm(version) {
  const numericRc = version.match(/^([0-9]+\.[0-9]+\.[0-9]+)-rc\.([0-9]+)$/)
  if (numericRc) return `${numericRc[1]}rc${numericRc[2]}`
  const shaRc = version.match(/^([0-9]+\.[0-9]+\.[0-9]+)-rc\.sha([A-Za-z0-9]+)$/)
  if (shaRc) return `${shaRc[1]}rc0+sha${shaRc[2]}`
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return version
  throw new Error(`cannot convert npm version: ${version}`)
}

export function baseVersion(version) {
  return version.replace(/-rc\.(?:sha[0-9A-Za-z]+|[0-9]+)$/, '')
}

function workspacePackagePaths() {
  const text = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const block = text.match(/^packages:\n((?: {2}- '[^']+'\n)+)/m)?.[1] ?? ''
  const patterns = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
  return patterns
    .flatMap((pattern) => globSync(`${pattern}/package.json`, { cwd: repoRoot }))
    .sort()
    .map((path) => join(repoRoot, path))
}

function stampPackageJson(path, version, npmNames, diff) {
  const before = readFileSync(path, 'utf8')
  const data = JSON.parse(before)
  if (data.version) data.version = version
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    if (!data[field]) continue
    for (const name of Object.keys(data[field])) {
      if (npmNames.has(name) && !data[field][name].startsWith('workspace:')) data[field][name] = version
    }
  }
  const after = `${JSON.stringify(data, null, 2)}\n`
  if (after !== before) diff.push({ path, before, after })
}

function stampPyproject(entry, pypiVersion, pypiNames, diff) {
  const path = join(repoRoot, entry.dir, 'pyproject.toml')
  const before = readFileSync(path, 'utf8')
  let after = before.replace(/^version = "[^"]+"/m, `version = "${pypiVersion}"`)
  after = after.replace(/"(caracalai-[a-z0-9-]+)==[^"]+"/g, (match, name) => {
    if (!pypiNames.has(name)) return match
    return `"${name}==${pypiVersion}"`
  })
  if (after !== before) diff.push({ path, before, after })
}

const installPinPattern = /((?:--version|-Version) )v[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-rc\.(?:sha[0-9A-Za-z]+|[0-9]+))?/g

function stampTextPins(config, diff) {
  const version = config.product.version
  const targets = [
    { path: 'README.md', apply: (text) => text.replace(installPinPattern, `$1v${version}`) },
    {
      path: 'CITATION.cff',
      apply: (text) => text.replace(/^version: .*$/m, `version: ${version}`),
    },
    {
      path: 'docs/src/content/docs/operations/kubernetes-helm.mdx',
      apply: (text) => text.replace(/^(\s*--version )\S+( \\)$/m, `$1${version}$2`),
    },
    {
      path: 'infra/tofu/envs/production/terraform.tfvars.example',
      apply: (text) => text.replace(/^chartVersion = "[^"]+"$/m, `chartVersion = "${version}"`),
    },
    {
      path: 'docs/src/content/docs/operations/opentofu.mdx',
      apply: (text) => text.replace(/caracalVersion = "v[^"]+"/, `caracalVersion = "v${version}"`),
    },
    {
      path: 'docs/src/content/docs/operations/docker-compose.mdx',
      apply: (text) => text.replace(/^export CARACAL_VERSION=.*$/m, `export CARACAL_VERSION=${version}`),
    },
  ]
  for (const target of targets) {
    const path = join(repoRoot, target.path)
    const before = readFileSync(path, 'utf8')
    const after = target.apply(before)
    if (after !== before) diff.push({ path, before, after })
  }
}

function goWorkspaceModulePaths(goWorkText) {
  return [...goWorkText.matchAll(/^\t\.\/(\S+)$/gm)].map((match) => match[1])
}

function stampGoDependencies(text, modules, version) {
  return text.replace(/(github\.com\/garudex-labs\/caracal\/packages\/[a-z0-9/]+\/go) v[0-9]\S*/g, (match, module) => {
    return modules.has(module) ? `${module} v${version}` : match
  })
}

function stampGoModules(config, diff) {
  const modules = new Set((config.packages.go ?? []).map((entry) => entry.module))
  const workPath = join(repoRoot, 'go.work')
  const workBefore = readFileSync(workPath, 'utf8')
  const modulePaths = goWorkspaceModulePaths(workBefore).map((dir) => join(repoRoot, dir, 'go.mod'))
  for (const path of [workPath, ...modulePaths]) {
    const before = path === workPath ? workBefore : readFileSync(path, 'utf8')
    const after = stampGoDependencies(before, modules, config.product.version)
    if (after !== before) diff.push({ path, before, after })
  }
}

function stampHelm(config, diff) {
  const version = config.product.version
  const chartPath = join(repoRoot, 'infra/helm/caracal/Chart.yaml')
  const valuesPath = join(repoRoot, 'infra/helm/caracal/values.yaml')
  const chartBefore = readFileSync(chartPath, 'utf8')
  const valuesBefore = readFileSync(valuesPath, 'utf8')
  let chartAfter = chartBefore.replace(/^version: .*/m, `version: ${version}`)
  chartAfter = chartAfter.replace(/^appVersion: .*/m, `appVersion: "${version}"`)
  const valuesAfter = valuesBefore.replace(/^( {2}tag: ).*/m, `$1"${version}"`)
  if (chartAfter !== chartBefore) diff.push({ path: chartPath, before: chartBefore, after: chartAfter })
  if (valuesAfter !== valuesBefore) diff.push({ path: valuesPath, before: valuesBefore, after: valuesAfter })
}

function stampDevStack(config, diff) {
  const base = baseVersion(config.product.version)
  const releasePath = join(repoRoot, 'packages/engine/runtime/release.json')
  const releaseBefore = readFileSync(releasePath, 'utf8')
  const releaseData = JSON.parse(releaseBefore)
  releaseData.version = base
  const releaseAfter = `${JSON.stringify(releaseData, null, 2)}\n`
  if (releaseAfter !== releaseBefore) diff.push({ path: releasePath, before: releaseBefore, after: releaseAfter })

  const schemaPath = join(repoRoot, 'packages/engine/src/envSchema.ts')
  const schemaBefore = readFileSync(schemaPath, 'utf8')
  const schemaAfter = schemaBefore.replace(/(CARACAL_BASE_VERSION: \{[^}]*default: ')[^']+(')/, `$1${base}$2`)
  if (schemaAfter !== schemaBefore) diff.push({ path: schemaPath, before: schemaBefore, after: schemaAfter })

  const envPath = join(repoRoot, 'infra/docker/dev.env')
  const envBefore = readFileSync(envPath, 'utf8')
  const envAfter = envBefore.replace(/^CARACAL_BASE_VERSION=.*$/m, `CARACAL_BASE_VERSION=${base}`)
  if (envAfter !== envBefore) diff.push({ path: envPath, before: envBefore, after: envAfter })

  const composePath = join(repoRoot, 'infra/docker/docker-compose.yml')
  const composeBefore = readFileSync(composePath, 'utf8')
  const composeAfter = composeBefore.replace(/(\$\{CARACAL_BASE_VERSION:-)[^}]+(\})/g, `$1${base}$2`)
  if (composeAfter !== composeBefore) diff.push({ path: composePath, before: composeBefore, after: composeAfter })
}

export function computeStamp(config = readReleaseConfig()) {
  const version = config.product.version
  if (!releaseVersionPattern.test(version)) throw new Error(`release.config.json product.version is not a release version: ${version}`)
  const pypiVersion = pypiFromNpm(version)
  const npmNames = new Set(config.packages.npm.map((entry) => entry.name))
  const pypiNames = new Set(config.packages.pypi.map((entry) => entry.name))
  const diff = []
  for (const path of workspacePackagePaths()) {
    stampPackageJson(path, version, npmNames, diff)
  }
  for (const entry of config.packages.pypi) {
    stampPyproject(entry, pypiVersion, pypiNames, diff)
  }
  stampGoModules(config, diff)
  stampHelm(config, diff)
  stampDevStack(config, diff)
  stampTextPins(config, diff)
  return diff
}

export function applyStamp(diff) {
  for (const change of diff) writeFileSync(change.path, change.after)
}
