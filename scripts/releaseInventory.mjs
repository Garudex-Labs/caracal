#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared release inventory loader for product artifacts and publishable packages.

import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function posix(path) {
  return path.split(sep).join('/')
}

export function readReleaseConfig() {
  const config = JSON.parse(readFileSync(join(repoRoot, 'release.config.json'), 'utf8'))
  if (!config.product || !config.packages) throw new Error('release.config.json must define product and packages')
  return config
}

export function npmPackages(config = readReleaseConfig()) {
  return config.packages.npm.map((entry) => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, entry.dir, 'package.json'), 'utf8'))
    if (pkg.name !== entry.name) throw new Error(`${entry.dir}/package.json name ${pkg.name} does not match ${entry.name}`)
    if (!pkg.version) throw new Error(`${entry.dir}/package.json is missing version`)
    return {
      ecosystem: 'npm',
      id: entry.id,
      group: entry.group,
      dir: entry.dir,
      name: entry.name,
      version: pkg.version,
      private: Boolean(pkg.private),
      publishConfig: pkg.publishConfig,
      dependencies: packageDependencies(pkg, config.packages.npm.map((candidate) => candidate.name)),
    }
  })
}

export function pypiPackages(config = readReleaseConfig()) {
  return config.packages.pypi.map((entry) => {
    const text = readFileSync(join(repoRoot, entry.dir, 'pyproject.toml'), 'utf8')
    const name = text.match(/^name = "([^"]+)"/m)?.[1]
    const version = text.match(/^version = "([^"]+)"/m)?.[1]
    if (name !== entry.name) throw new Error(`${entry.dir}/pyproject.toml name ${name} does not match ${entry.name}`)
    if (!version) throw new Error(`${entry.dir}/pyproject.toml is missing version`)
    return {
      ecosystem: 'pypi',
      id: entry.id,
      group: entry.group,
      dir: entry.dir,
      name: entry.name,
      module: entry.module,
      version,
      dependencies: pythonDependencies(text, config.packages.pypi.map((candidate) => candidate.name)),
    }
  })
}

export function productContainers(config = readReleaseConfig()) {
  return config.product.containers.map((container) => ({ ...container }))
}

export function productArchiveTargets(config = readReleaseConfig()) {
  return config.product.archiveTargets.map((target) => ({ ...target }))
}

export function productBinaries(config = readReleaseConfig()) {
  return Object.entries(config.product.binaries).map(([name, value]) => ({ name, ...value }))
}

export function releaseInventory(config = readReleaseConfig()) {
  return {
    config,
    product: config.product,
    packages: {
      npm: npmPackages(config),
      pypi: pypiPackages(config),
    },
  }
}

export function relativePath(path) {
  return posix(relative(repoRoot, path))
}

function packageDependencies(pkg, names) {
  const selected = new Set(names)
  const dependencies = []
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (selected.has(name)) dependencies.push(name)
    }
  }
  return dependencies.sort()
}

function pythonDependencies(text, names) {
  const selected = new Set(names)
  const dependencies = []
  for (const match of text.matchAll(/"(caracalai-[a-z0-9-]+)==[^"]+"/g)) {
    if (selected.has(match[1])) dependencies.push(match[1])
  }
  return [...new Set(dependencies)].sort()
}
