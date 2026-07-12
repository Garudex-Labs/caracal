#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Adds immutable image and chart OCI digests to a finalized release manifest.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { imageDigest } from './lib/oci.mjs'
import { chartRef, writeJsonAtomic } from './lib/releaseSpec.mjs'

const [path] = process.argv.slice(2)
if (!path) throw new Error('usage: finalizeOciDigests.mjs <manifest>')
const manifestPath = resolve(path)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!manifest.images || typeof manifest.images !== 'object') throw new Error('manifest images are required')
if (!manifest.registries?.oci) throw new Error('manifest registries.oci is required')
if (!manifest.helm || typeof manifest.helm !== 'object') throw new Error('manifest helm metadata is required')

manifest.imageDigests = {}
for (const [name, reference] of Object.entries(manifest.images)) {
  manifest.imageDigests[name] = await imageDigest(reference)
}
manifest.helm.digest = await imageDigest(`${chartRef(manifest.registries.oci)}:${manifest.version}`)
writeJsonAtomic(manifestPath, manifest)
