#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Synchronizes configured package metadata and exact internal dependency pins.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseInventory, repoRoot } from './releaseInventory.mjs'

function die(message) {
  process.stderr.write(`sync-packages: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { check: false, groups: new Set(), allGroups: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--check':
        options.check = true
        break
      case '--group':
        options.groups.add(argv[++i] ?? '')
        if (options.groups.has('')) die('--group needs a package group')
        break
      case '--all-groups':
        options.allGroups = true
        break
      case '-h':
      case '--help':
        process.stdout.write(`Usage: scripts/syncPackageVersions.mjs [options]

  --group NAME   Sync one PyPI group to npm.
  --all-groups   Sync all PyPI groups to npm.
  --check        Report drift only.
`)
        process.exit(0)
      default:
        die(`unknown arg: ${arg}`)
    }
  }
  return options
}

function pythonVersionFromNpm(version) {
  const numericRc = version.match(/^([0-9]+\.[0-9]+\.[0-9]+)-rc\.([0-9]+)$/)
  if (numericRc) return `${numericRc[1]}rc${numericRc[2]}`
  const shaRc = version.match(/^([0-9]+\.[0-9]+\.[0-9]+)-rc\.sha([A-Za-z0-9]+)$/)
  if (shaRc) return `${shaRc[1]}rc0+sha${shaRc[2]}`
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return version
  die(`cannot convert npm version: ${version}`)
}

function rewritePackageJson(pkg, versions, options) {
  const path = join(repoRoot, pkg.dir, 'package.json')
  const before = readFileSync(path, 'utf8')
  const data = JSON.parse(before)
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of Object.keys(data[field] ?? {})) {
      if (versions[name]) data[field][name] = versions[name]
    }
  }
  const after = `${JSON.stringify(data, null, 2)}\n`
  if (after !== before) {
    if (options.check) return [`${pkg.dir}/package.json`]
    writeFileSync(path, after)
    return [`${pkg.dir}/package.json`]
  }
  return []
}

function rewritePyproject(pkg, versions, groups, options) {
  const path = join(repoRoot, pkg.dir, 'pyproject.toml')
  const before = readFileSync(path, 'utf8')
  let after = before
  if (groups[pkg.group]) {
    after = after.replace(/^version = "[^"]+"/m, `version = "${groups[pkg.group]}"`)
  }
  after = after.replace(/"(?<name>caracalai-[a-z0-9-]+)==[^"]+"/g, (match, name) => {
    if (!versions[name]) return match
    return `"${name}==${versions[name]}"`
  })
  if (after !== before) {
    if (options.check) return [`${pkg.dir}/pyproject.toml`]
    writeFileSync(path, after)
    return [`${pkg.dir}/pyproject.toml`]
  }
  return []
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const inventory = releaseInventory()
  const npmVersions = Object.fromEntries(inventory.packages.npm.map((pkg) => [pkg.name, pkg.version]))
  const pypiVersions = Object.fromEntries(inventory.packages.pypi.map((pkg) => [pkg.name, pkg.version]))
  const npmGroups = Object.fromEntries(inventory.packages.npm.map((pkg) => [pkg.group, pkg.version]))
  const selectedGroups = {}
  for (const pkg of inventory.packages.pypi) {
    if (!npmGroups[pkg.group]) continue
    if (options.allGroups || options.groups.has(pkg.group)) {
      selectedGroups[pkg.group] = pythonVersionFromNpm(npmGroups[pkg.group])
      pypiVersions[pkg.name] = selectedGroups[pkg.group]
    }
  }
  const touched = [
    ...inventory.packages.npm.flatMap((pkg) => rewritePackageJson(pkg, npmVersions, options)),
    ...inventory.packages.pypi.flatMap((pkg) => rewritePyproject(pkg, pypiVersions, selectedGroups, options)),
  ]
  if (options.check && touched.length) die(`metadata drift:\n${touched.map((path) => `  ${path}`).join('\n')}`)
  process.stdout.write(touched.length ? `${touched.join('\n')}\n` : 'package metadata synced\n')
}

main()
