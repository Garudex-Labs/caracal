#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies the local runtime against the repository toolchain contract.

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contract = JSON.parse(readFileSync(resolve(root, 'toolchain.json'), 'utf8'))
const packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const metadataErrors = []
if (packageManifest.packageManager !== `pnpm@${contract.pnpm}`) {
  metadataErrors.push(`package.json must pin pnpm@${contract.pnpm}`)
}
if (
  packageManifest.engines?.node !== `>=${contract.node}` ||
  packageManifest.engines?.pnpm !== `>=${contract.pnpm}`
) {
  metadataErrors.push('package.json engines do not match toolchain.json')
}

const goWork = readFileSync(resolve(root, 'go.work'), 'utf8')
if (!new RegExp(`go ${contract.go}(?:\\.0)?`).test(goWork)) {
  metadataErrors.push('go.work Go version does not match toolchain.json')
}

const pythonProjects = [
  'packages/backends/redis/python/pyproject.toml',
  'packages/sdk/python/pyproject.toml',
  'packages/oauth/python/pyproject.toml',
  'packages/core/python/pyproject.toml',
  'packages/verify/python/pyproject.toml',
  'packages/revocation/python/pyproject.toml',
  'packages/identity/python/pyproject.toml',
  'packages/adapters/asgi/python/pyproject.toml',
  'packages/adapters/fastmcp/python/pyproject.toml',
  'packages/admin/python/pyproject.toml',
]
for (const path of pythonProjects) {
  const metadata = readFileSync(resolve(root, path), 'utf8')
  if (!metadata.includes(`requires-python = ">=${contract.python}"`)) {
    metadataErrors.push(`${path} Python version does not match toolchain.json`)
  }
}

const docs = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8')
const workflowDir = resolve(root, '.github/workflows')
const workflows = readdirSync(workflowDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => [name, readFileSync(resolve(workflowDir, name), 'utf8')])
const labels = { node: 'Node\\.js', pnpm: 'pnpm', go: 'Go', python: 'Python' }
const envNames = { node: 'NODE_VERSION', pnpm: 'PNPM_VERSION', go: 'GO_VERSION', python: 'PYTHON_VERSION' }
const actionNames = { node: 'node-version', pnpm: 'version', go: 'go-version', python: 'python-version' }
for (const [name, value] of Object.entries(contract)) {
  const escaped = value.replaceAll('.', '\\.')
  if (!new RegExp(`\\|\\s*${labels[name]}\\s*\\|\\s*${escaped}\\+?\\s*\\|`).test(docs)) {
    metadataErrors.push(`CONTRIBUTING.md ${name} version does not match toolchain.json`)
  }
  const envName = envNames[name]
  const actionName = actionNames[name]
  for (const [path, workflow] of workflows) {
    if (workflow.includes(envName) && !new RegExp(`${envName}:\\s*'${escaped}'`).test(workflow)) {
      metadataErrors.push(`${path} ${envName} does not match toolchain.json`)
    }
    const directVersion = new RegExp(`(?:^|\\n)\\s*${actionName}:\\s*'`)
    const expectedDirectVersion = new RegExp(`(?:^|\\n)\\s*${actionName}:\\s*'${escaped}'`)
    if (directVersion.test(workflow) && !expectedDirectVersion.test(workflow)) {
      metadataErrors.push(`${path} ${actionName} does not match toolchain.json`)
    }
  }
}

function versionParts(raw) {
  const match = String(raw).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null
}

function runVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) return null
  return `${result.stdout}${result.stderr}`.trim()
}

function atLeast(actual, required) {
  const got = versionParts(actual)
  const want = versionParts(required)
  if (!got || !want) return false
  return (
    got[0] > want[0] ||
    (got[0] === want[0] && (got[1] > want[1] || (got[1] === want[1] && got[2] >= want[2])))
  )
}

const versions = {
  node: process.versions.node,
  pnpm: runVersion('pnpm', ['--version']),
  go: runVersion('go', ['version']),
  python:
    runVersion(process.env.PYTHON || 'python3', ['--version']) ||
    runVersion('python', ['--version']),
}

console.log(
  `Required toolchain: Node.js ${contract.node}+, pnpm ${contract.pnpm}, Go ${contract.go}+, Python ${contract.python}+`,
)
console.log(
  `Detected toolchain: Node.js ${versions.node}, pnpm ${versions.pnpm ?? 'missing'}, Go ${versions.go ?? 'missing'}, Python ${versions.python ?? 'missing'}`,
)

const errors = [...metadataErrors]
if (!atLeast(versions.node, contract.node)) errors.push(`Node.js ${contract.node}+ is required`)
if (versions.pnpm !== contract.pnpm) errors.push(`pnpm ${contract.pnpm} is required`)
if (!atLeast(versions.go, contract.go)) errors.push(`Go ${contract.go}+ is required`)
if (!atLeast(versions.python, contract.python)) errors.push(`Python ${contract.python}+ is required`)

if (errors.length > 0) {
  for (const error of errors) console.error(`toolchain error: ${error}`)
  process.exit(1)
}
