#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Rejects release image and chart versions that already exist in an OCI registry.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const missingPattern = /(?:manifest unknown|name unknown|not found)/i

function inspect(command, args, artifact) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) throw result.error
  if (result.status === 0) throw new Error(`release artifact already published: ${artifact}`)
  if (!missingPattern.test(output)) throw new Error(`could not verify ${artifact}: ${output.trim()}`)
  process.stdout.write(`unpublished: ${artifact}\n`)
}

function parseArgs(argv) {
  const artifacts = []
  let versionOverride = ''
  let all = false
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--version':
        if (!argv[index + 1]) throw new Error('--version requires a value')
        versionOverride = argv[index + 1].replace(/^v/, '')
        index += 1
        break
      case '--image':
        if (!argv[index + 1]) throw new Error('--image requires a reference')
        artifacts.push({ kind: 'image', reference: argv[index + 1] })
        index += 1
        break
      case '--chart':
        if (!argv[index + 1] || !argv[index + 2]) throw new Error('--chart requires a reference and version')
        artifacts.push({ kind: 'chart', reference: argv[index + 1], version: argv[index + 2] })
        index += 2
        break
      case '--all': {
        all = true
        break
      }
      default:
        throw new Error(`unknown argument: ${argv[index]}`)
    }
  }
  if (all) {
    const config = JSON.parse(readFileSync(resolve('release.config.json'), 'utf8'))
    const registry = (process.env.CARACAL_OCI_REGISTRY ?? 'ghcr.io/garudex-labs').replace(/\/$/, '')
    const version = versionOverride || config.product.version
    for (const image of config.product.containers) {
      artifacts.push({ kind: 'image', reference: `${registry}/caracal-${image.name}:v${version}` })
    }
    artifacts.push({ kind: 'chart', reference: `oci://${registry}/charts/caracal`, version })
  }
  if (artifacts.length === 0) throw new Error('specify --all, --image, or --chart')
  return artifacts
}

for (const artifact of parseArgs(process.argv.slice(2))) {
  if (artifact.kind === 'image') {
    inspect('docker', ['buildx', 'imagetools', 'inspect', artifact.reference], artifact.reference)
  } else {
    inspect('helm', ['show', 'chart', artifact.reference, '--version', artifact.version], `${artifact.reference}:${artifact.version}`)
  }
}
