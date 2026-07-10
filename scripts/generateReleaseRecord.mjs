#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Generates the docs Releases record for a release tag from its validated manifest.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const tagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.(sha[0-9A-Za-z]+|[0-9]+))?$/
const archivePlatforms = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64']
const zipPlatform = 'windows-amd64'
const extras = ['manifest.json', 'install.sh', 'install.ps1', 'SHA256SUMS']

function fail(message) {
  process.stderr.write(`generateReleaseRecord: ${message}\n`)
  process.exit(1)
}

const repoRoot = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
const input = process.argv[2]
if (!input) fail('expected a manifest path or release tag argument')

const manifestPath = input.endsWith('.json') ? resolve(input) : join(repoRoot, 'releases', input, 'manifest.json')
if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const release = manifest.release
if (!tagPattern.test(release ?? '')) fail(`invalid manifest release tag: ${release}`)

const channel = manifest.mode ?? (release.includes('-rc.') ? 'rc' : 'stable')
const date = manifest.publishedAt ?? manifest.generatedAt?.slice(0, 10)
if (!date) fail('manifest has no publishedAt or generatedAt date')

const components = Object.keys(manifest.binaries ?? {})
if (components.length === 0) fail('manifest has no binaries to derive assets from')

const assets = [
  ...components.flatMap((component) => [
    ...archivePlatforms.map((platform) => `caracal-${component}-${platform}-${release}.tar.gz`),
    `caracal-${component}-${zipPlatform}-${release}.zip`,
  ]),
  ...extras,
].sort()

const record = { release, channel, date, assets }

const recordDir = join(repoRoot, 'docs', 'src', 'data', 'releases')
const recordPath = join(recordDir, `${release}.json`)
mkdirSync(recordDir, { recursive: true })
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
process.stdout.write(`wrote ${recordPath}\n`)
