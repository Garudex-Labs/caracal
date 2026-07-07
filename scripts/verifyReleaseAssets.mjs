#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies release archive assets and checksums for a Caracal release tag.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const [releaseTag, dir = 'dist'] = process.argv.slice(2)

function fail(message) {
  process.stderr.write(`verifyReleaseAssets: ${message}\n`)
  process.exit(1)
}

if (!releaseTag || !/^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/.test(releaseTag)) {
  fail(`expected release tag argument, got ${releaseTag ?? '<empty>'}`)
}

const root = resolve(dir)
const assets = [
  `caracal-runtime-linux-amd64-${releaseTag}.tar.gz`,
  `caracal-runtime-linux-arm64-${releaseTag}.tar.gz`,
  `caracal-runtime-darwin-amd64-${releaseTag}.tar.gz`,
  `caracal-runtime-darwin-arm64-${releaseTag}.tar.gz`,
  `caracal-runtime-windows-amd64-${releaseTag}.zip`,
  'manifest.json',
  'install.sh',
  'install.ps1',
  'SHA256SUMS',
]

for (const asset of assets) {
  const path = resolve(root, asset)
  if (!existsSync(path)) fail(`missing release asset: ${path}`)
}

// Checksums are verified in-process so the script runs identically on Linux,
// macOS, and Windows without GNU coreutils or shasum on PATH.
const sumLines = readFileSync(resolve(root, 'SHA256SUMS'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
if (sumLines.length === 0) fail('SHA256SUMS is empty')
for (const line of sumLines) {
  const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
  if (!match) fail(`malformed SHA256SUMS entry: ${line}`)
  const [, expected, name] = match
  const path = resolve(root, name)
  if (!existsSync(path)) fail(`SHA256SUMS references missing file: ${name}`)
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== expected) fail(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`)
  process.stdout.write(`${name}: OK\n`)
}

process.stdout.write(`verified ${assets.length} release assets in ${basename(root)} for ${releaseTag}\n`)
