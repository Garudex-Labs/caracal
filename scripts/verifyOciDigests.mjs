#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Compares release manifest OCI digests with public image and chart state.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function inspectDigest(reference) {
  const output = execFileSync('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'], {
    encoding: 'utf8',
  })
  const digest = JSON.parse(output).digest
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`${reference} returned invalid digest ${digest}`)
  return digest
}

export function verifyOciDigests(manifest) {
  if (!manifest.images || !manifest.imageDigests) throw new Error('manifest image references and digests are required')
  for (const [name, reference] of Object.entries(manifest.images)) {
    const expected = manifest.imageDigests[name]
    const actual = inspectDigest(reference)
    if (actual !== expected) throw new Error(`${reference} digest ${actual} does not match manifest ${expected}`)
    process.stdout.write(`${reference}@${actual}: OK\n`)
  }
  const registry = manifest.registries?.oci?.replace(/\/$/, '')
  if (!registry) throw new Error('manifest registries.oci is required')
  const chart = `${registry}/charts/caracal:${manifest.version}`
  const actual = inspectDigest(chart)
  if (actual !== manifest.helm?.digest) throw new Error(`${chart} digest ${actual} does not match manifest ${manifest.helm?.digest}`)
  process.stdout.write(`${chart}@${actual}: OK\n`)
}

const [path] = process.argv.slice(2)
if (!path) throw new Error('usage: verifyOciDigests.mjs <manifest>')
verifyOciDigests(JSON.parse(readFileSync(resolve(path), 'utf8')))
