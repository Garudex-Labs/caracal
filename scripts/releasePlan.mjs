#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Computes lockstep package publish plans from the central release inventory.

import { releaseInventory } from './releaseInventory.mjs'

function die(message) {
  process.stderr.write(`release-plan: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    ecosystem: 'all',
    format: 'json',
    packages: new Set(),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--ecosystem':
        options.ecosystem = argv[++i] ?? ''
        if (!['all', 'npm', 'pypi'].includes(options.ecosystem)) die('--ecosystem must be all, npm, or pypi')
        break
      case '--format':
        options.format = argv[++i] ?? ''
        if (!['json', 'github-matrix', 'manifest-packages'].includes(options.format)) {
          die('--format must be json, github-matrix, or manifest-packages')
        }
        break
      case '--package':
        options.packages.add(argv[++i] ?? '')
        if (options.packages.has('')) die('--package needs an id, name, group, or dir')
        break
      case '-h':
      case '--help':
        process.stdout.write(`Usage: scripts/releasePlan.mjs [options]

  --ecosystem all|npm|pypi Target ecosystem. Default: all.
  --package VALUE          Select id, name, group, or dir. Default: all packages.
  --format VALUE           json, github-matrix, manifest-packages.
`)
        process.exit(0)
      default:
        die(`unknown arg: ${arg}`)
    }
  }
  return options
}

function packageMatches(pkg, values) {
  return values.has(pkg.id) || values.has(pkg.name) || values.has(pkg.group) || values.has(pkg.dir)
}

function selectPackages(packages, options) {
  const publishable = packages.filter((pkg) => pkg.publish !== false)
  if (options.packages.size) return publishable.filter((pkg) => packageMatches(pkg, options.packages))
  return publishable
}

function packageSets(packages, selected) {
  const selectedNames = new Set(selected.map((pkg) => pkg.name))
  return {
    published: Object.fromEntries(selected.map((pkg) => [pkg.name, pkg.version])),
    unchanged: Object.fromEntries(packages.filter((pkg) => !selectedNames.has(pkg.name)).map((pkg) => [pkg.name, pkg.version])),
  }
}

function matrixPackage(pkg) {
  const { private: _, publishConfig: __, dependencies: ___, ...value } = pkg
  return value
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const inventory = releaseInventory()
  const ecosystems = options.ecosystem === 'all' ? ['npm', 'pypi'] : [options.ecosystem]
  const selected = Object.fromEntries(ecosystems.map((ecosystem) => [ecosystem, selectPackages(inventory.packages[ecosystem], options)]))
  const plan = {
    packages: {
      published: Object.fromEntries(
        ecosystems.map((ecosystem) => [ecosystem, packageSets(inventory.packages[ecosystem], selected[ecosystem]).published]),
      ),
      unchanged: Object.fromEntries(
        ecosystems.map((ecosystem) => [ecosystem, packageSets(inventory.packages[ecosystem], selected[ecosystem]).unchanged]),
      ),
    },
    matrix: {
      include: ecosystems.flatMap((ecosystem) => selected[ecosystem].map(matrixPackage)),
    },
  }

  switch (options.format) {
    case 'json':
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      break
    case 'github-matrix':
      process.stdout.write(`${JSON.stringify(plan.matrix)}\n`)
      break
    case 'manifest-packages':
      process.stdout.write(`${JSON.stringify(plan.packages, null, 2)}\n`)
      break
  }
}

main()
