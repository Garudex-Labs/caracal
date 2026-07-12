#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Rejects release package versions that already exist in public registries.

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { registryDefaults } from './lib/releaseSpec.mjs'
import { pypiFromNpm } from './lib/stamp.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = {
    ecosystem: 'all',
    npmRegistry: process.env.CARACAL_NPM_REGISTRY ?? registryDefaults.npm,
    pypiApi: process.env.CARACAL_PYPI_API ?? registryDefaults.pypiApi,
    packages: [],
    version: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    switch (arg) {
      case '--ecosystem':
        if (!['all', 'npm', 'pypi'].includes(value)) throw new Error('--ecosystem must be all, npm, or pypi')
        options.ecosystem = value
        index += 1
        break
      case '--package':
        if (!value) throw new Error('--package requires a value')
        options.packages.push(value)
        index += 1
        break
      case '--npm-registry':
        if (!value) throw new Error('--npm-registry requires a URL')
        options.npmRegistry = value
        index += 1
        break
      case '--pypi-api':
        if (!value) throw new Error('--pypi-api requires a URL')
        options.pypiApi = value
        index += 1
        break
      case '--version':
        if (!value) throw new Error('--version requires a value')
        options.version = value.replace(/^v/, '')
        index += 1
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function plan(options) {
  const args = ['scripts/releasePlan.mjs', '--ecosystem', options.ecosystem, '--format', 'json']
  for (const value of options.packages) args.push('--package', value)
  return JSON.parse(execFileSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' }))
}

function endpoint(pkg, options) {
  if (pkg.ecosystem === 'npm') {
    const name = pkg.name.startsWith('@') ? `@${encodeURIComponent(pkg.name.slice(1))}` : encodeURIComponent(pkg.name)
    return new URL(`${name}/${encodeURIComponent(pkg.version)}`, ensureSlash(options.npmRegistry))
  }
  return new URL(`${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/json`, ensureSlash(options.pypiApi))
}

function ensureSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}

export async function findPublished(packages, options) {
  const published = []
  const attempts = 3
  for (const pkg of packages) {
    const url = endpoint(pkg, options)
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } })
      if (response.status === 404) break
      if (response.ok) {
        published.push(`${pkg.name}@${pkg.version}`)
        break
      }
      if (response.status < 500 || attempt >= attempts) throw new Error(`${url} returned HTTP ${response.status}`)
      await delay(5_000)
    }
  }
  return published
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const packages = plan(options).matrix.include.map((pkg) => ({
    ...pkg,
    version: options.version ? (pkg.ecosystem === 'pypi' ? pypiFromNpm(options.version) : options.version) : pkg.version,
  }))
  const published = await findPublished(packages, options)
  if (published.length > 0) {
    throw new Error(`release versions already published:\n${published.map((value) => `  ${value}`).join('\n')}`)
  }
  process.stdout.write(`verified ${packages.length} unpublished ${options.ecosystem} package versions\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
