#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Adds immutable image and chart OCI digests to a finalized release manifest.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [path] = process.argv.slice(2)
if (!path) throw new Error('usage: finalizeOciDigests.mjs <manifest>')
const manifestPath = resolve(path)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!manifest.images || typeof manifest.images !== 'object') throw new Error('manifest images are required')

manifest.imageDigests = {}
for (const [name, reference] of Object.entries(manifest.images)) {
  const output = execFileSync('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'], {
    encoding: 'utf8',
  })
  const digest = JSON.parse(output).digest
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`${reference} returned invalid digest ${digest}`)
  manifest.imageDigests[name] = digest
}
const registry = manifest.registries.oci.replace(/\/$/, '')
const chart = `${registry}/charts/caracal:${manifest.version}`
const chartOutput = execFileSync('docker', ['buildx', 'imagetools', 'inspect', chart, '--format', '{{json .Manifest}}'], {
  encoding: 'utf8',
})
const chartDigest = JSON.parse(chartOutput).digest
if (!/^sha256:[0-9a-f]{64}$/.test(chartDigest ?? '')) throw new Error(`${chart} returned invalid digest ${chartDigest}`)
manifest.helm.digest = chartDigest
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
