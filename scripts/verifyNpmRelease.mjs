#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies a published npm package signature and exact source provenance.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function packageUrl(name, version) {
  return `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/${encodeURIComponent(version)}`
}

function packagePurl(name, version) {
  if (!name.startsWith('@')) return `pkg:npm/${name}@${version}`
  const [scope, packageName] = name.slice(1).split('/', 2)
  return `pkg:npm/%40${scope}/${packageName}@${version}`
}

function integrityDigest(integrity) {
  const [algorithm, value] = integrity.split('-', 2)
  if (algorithm !== 'sha512' || !value) throw new Error(`expected sha512 integrity, got ${integrity}`)
  return Buffer.from(value, 'base64').toString('hex')
}

export function validateProvenance(metadata, attestations, expected) {
  if (metadata.version !== expected.version) throw new Error(`published version ${metadata.version} does not match ${expected.version}`)
  if (metadata.gitHead !== expected.sha) throw new Error(`published gitHead ${metadata.gitHead} does not match ${expected.sha}`)
  const attestation = attestations.attestations?.find((value) => value.predicateType === 'https://slsa.dev/provenance/v1')
  if (!attestation) throw new Error('npm package has no SLSA provenance attestation')
  const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow
  if (
    workflow?.repository !== 'https://github.com/Garudex-Labs/caracal' ||
    workflow?.path !== '.github/workflows/release.yml' ||
    workflow?.ref !== `refs/tags/${expected.tag}`
  ) {
    throw new Error('npm provenance was not produced by the expected Caracal release workflow')
  }
  const dependency = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
    (value) => value.uri === `git+https://github.com/Garudex-Labs/caracal@refs/tags/${expected.tag}`,
  )
  if (dependency?.digest?.gitCommit !== expected.sha) throw new Error('npm provenance source commit does not match the release commit')
  const subject = statement.subject?.find((value) => value.name === packagePurl(expected.name, expected.version))
  if (!subject || subject.digest?.sha512 !== integrityDigest(metadata.dist?.integrity ?? '')) {
    throw new Error('npm provenance subject does not match the published package integrity')
  }
}

async function main() {
  const [name, version, sha, tag] = process.argv.slice(2)
  if (!name || !version || !/^[0-9a-f]{40}$/.test(sha ?? '') || !tag) {
    throw new Error('usage: verifyNpmRelease.mjs <package> <version> <source-sha> <release-tag>')
  }
  const metadata = await fetch(packageUrl(name, version), { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }).then(
    async (response) => {
      if (!response.ok) throw new Error(`${name}@${version} metadata returned HTTP ${response.status}`)
      return response.json()
    },
  )
  const attestationUrl = metadata.dist?.attestations?.url
  if (!attestationUrl) throw new Error(`${name}@${version} has no npm attestation URL`)
  const attestations = await fetch(attestationUrl, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }).then(
    async (response) => {
      if (!response.ok) throw new Error(`${name}@${version} attestations returned HTTP ${response.status}`)
      return response.json()
    },
  )
  const directory = mkdtempSync(join(tmpdir(), 'caracal-npm-'))
  try {
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ private: true, dependencies: { [name]: version } })}\n`)
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' })
    execFileSync('npm', ['audit', 'signatures'], { cwd: directory, stdio: 'inherit' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  validateProvenance(metadata, attestations, { name, version, sha, tag })
  process.stdout.write(`${name}@${version} has verified npm signatures and source provenance\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
