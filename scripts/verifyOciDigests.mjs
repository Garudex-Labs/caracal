#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Compares release manifest OCI digests with public image and chart state.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { imageDigest } from './lib/oci.mjs'
import { chartRef } from './lib/releaseSpec.mjs'

export async function verifyOciDigests(manifest) {
  if (!manifest.images || !manifest.imageDigests) throw new Error('manifest image references and digests are required')
  for (const [name, reference] of Object.entries(manifest.images)) {
    const expected = manifest.imageDigests[name]
    const actual = await imageDigest(reference)
    if (actual !== expected) throw new Error(`${reference} digest ${actual} does not match manifest ${expected}`)
    process.stdout.write(`${reference}@${actual}: OK\n`)
  }
  if (!manifest.registries?.oci) throw new Error('manifest registries.oci is required')
  const chart = `${chartRef(manifest.registries.oci)}:${manifest.version}`
  const actual = await imageDigest(chart)
  if (actual !== manifest.helm?.digest) throw new Error(`${chart} digest ${actual} does not match manifest ${manifest.helm?.digest}`)
  process.stdout.write(`${chart}@${actual}: OK\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path] = process.argv.slice(2)
  if (!path) throw new Error('usage: verifyOciDigests.mjs <manifest>')
  await verifyOciDigests(JSON.parse(readFileSync(resolve(path), 'utf8')))
}
