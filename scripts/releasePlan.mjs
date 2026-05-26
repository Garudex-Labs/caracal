#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Computes changed package publish plans from the central release inventory.

import { execFileSync } from 'node:child_process'
import { releaseInventory, repoRoot } from './releaseInventory.mjs'

function die(message) {
  process.stderr.write(`release-plan: ${message}\n`)
  process.exit(1)
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', options.stderr ?? 'pipe'] }).trim()
}

function parseArgs(argv) {
  const options = {
    allPackages: false,
    base: '',
    ecosystem: 'all',
    format: 'json',
    head: 'HEAD',
    packages: new Set(),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--all-packages':
      case '--all':
        options.allPackages = true
        break
      case '--base':
      case '--since':
        options.base = argv[++i] ?? ''
        if (!options.base) die(`${arg} needs a ref`)
        break
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
      case '--head':
        options.head = argv[++i] ?? ''
        if (!options.head) die('--head needs a ref')
        break
      case '--package':
        options.packages.add(argv[++i] ?? '')
        if (options.packages.has('')) die('--package needs an id, name, group, or dir')
        break
      case '-h':
      case '--help':
        process.stdout.write(`Usage: scripts/releasePlan.mjs [options]

  --since REF              Diff base. Alias: --base.
  --head REF               Diff head. Default: HEAD.
  --ecosystem all|npm|pypi Target ecosystem. Default: all.
  --package VALUE          Select id, name, group, or dir.
  --all-packages           Include all packages.
  --format VALUE           json, github-matrix, manifest-packages.
`)
        process.exit(0)
      default:
        die(`unknown arg: ${arg}`)
    }
  }
  return options
}

function headCommit(head) {
  try {
    return git(['rev-parse', '--verify', `${head}^{commit}`])
  } catch {
    die(`head not found: ${head}`)
  }
}

function explicitBase(base) {
  try {
    return git(['rev-parse', '--verify', `${base}^{commit}`])
  } catch {
    die(`base not found: ${base}`)
  }
}

function defaultBase(head) {
  const commit = headCommit(head)
  let tags = []
  try {
    tags = git(['tag', '--merged', commit, '--list', 'v*', '--sort=-creatordate'], { stderr: 'ignore' }).split('\n').filter(Boolean)
  } catch {
    tags = []
  }
  for (const tag of tags) {
    const tagCommit = git(['rev-list', '-n', '1', tag])
    if (tagCommit !== commit) return tag
  }
  return ''
}

function diffFiles(base, head) {
  if (!base) return []
  return git(['diff', '--name-only', '--diff-filter=ACMRTUXB', base, head, '--'], { stderr: 'inherit' })
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .filter((path) => !path.startsWith('examples/'))
}

function packageTouched(pkg, files) {
  return files.some((path) => path === pkg.dir || path.startsWith(`${pkg.dir}/`))
}

function packageMatches(pkg, values) {
  return values.has(pkg.id) || values.has(pkg.name) || values.has(pkg.group) || values.has(pkg.dir)
}

function withDependents(packages, selected) {
  const names = new Set(selected.map((pkg) => pkg.name))
  let changed = true
  while (changed) {
    changed = false
    for (const pkg of packages) {
      if (names.has(pkg.name)) continue
      if (pkg.dependencies.some((name) => names.has(name))) {
        names.add(pkg.name)
        changed = true
      }
    }
  }
  return packages.filter((pkg) => names.has(pkg.name))
}

function selectPackages(packages, options, files) {
  if (options.allPackages) return packages
  if (options.packages.size) {
    return withDependents(packages, packages.filter((pkg) => packageMatches(pkg, options.packages)))
  }
  return withDependents(packages, packages.filter((pkg) => packageTouched(pkg, files)))
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
  const base = options.allPackages ? '' : (options.base || defaultBase(options.head))
  if (!options.allPackages && !base && !options.packages.size) die('no base tag; pass --since, --package, or --all-packages')
  if (options.base) explicitBase(options.base)
  const head = headCommit(options.head)
  const files = options.allPackages ? [] : diffFiles(base, head)
  const ecosystems = options.ecosystem === 'all' ? ['npm', 'pypi'] : [options.ecosystem]
  const selected = Object.fromEntries(ecosystems.map((ecosystem) => [
    ecosystem,
    selectPackages(inventory.packages[ecosystem], options, files),
  ]))
  const plan = {
    base: base || null,
    head,
    changedFiles: files,
    packages: {
      published: Object.fromEntries(ecosystems.map((ecosystem) => [ecosystem, packageSets(inventory.packages[ecosystem], selected[ecosystem]).published])),
      unchanged: Object.fromEntries(ecosystems.map((ecosystem) => [ecosystem, packageSets(inventory.packages[ecosystem], selected[ecosystem]).unchanged])),
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
