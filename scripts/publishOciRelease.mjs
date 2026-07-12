#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Promotes verified source images to immutable release tags without rebuilding.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { imageDigest } from './lib/oci.mjs'
import { commitPattern, imageRef, ociRegistry, publishTagPattern } from './lib/releaseSpec.mjs'
import { verifyReleaseProvenance } from './verifyAttestation.mjs'

const [sourceSha, releaseTag] = process.argv.slice(2)
if (!commitPattern.test(sourceSha ?? '') || !publishTagPattern.test(releaseTag ?? '')) {
  throw new Error('usage: publishOciRelease.mjs <source-sha> <release-tag>')
}

const config = JSON.parse(readFileSync(resolve('release.config.json'), 'utf8'))
const registry = ociRegistry()

for (const image of config.product.containers) {
  const source = imageRef(image.name, `sha-${sourceSha}`, registry)
  const release = imageRef(image.name, releaseTag, registry)
  const sourceDigest = await imageDigest(source)
  verifyReleaseProvenance(source, sourceSha, releaseTag, { oci: true })
  const releaseDigest = await imageDigest(release, { required: false })
  if (releaseDigest && releaseDigest !== sourceDigest) {
    throw new Error(`${release} already points to ${releaseDigest}; expected ${sourceDigest}`)
  }
  if (!releaseDigest) {
    execFileSync('docker', ['buildx', 'imagetools', 'create', '--tag', release, `${source}@${sourceDigest}`], { stdio: 'inherit' })
  }
  if ((await imageDigest(release)) !== sourceDigest) throw new Error(`${release} digest changed during promotion`)
  verifyReleaseProvenance(release, sourceSha, releaseTag, { oci: true })
  process.stdout.write(`${release} -> ${sourceDigest}\n`)
}
