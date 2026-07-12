#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies a published npm package signature and exact source provenance.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commitPattern, releaseWorkflowPath, repoUrl } from './lib/releaseSpec.mjs'

function packageUrl(name, version) {
  const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
  return `https://registry.npmjs.org/${path}/${encodeURIComponent(version)}`
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
  if (workflow?.repository !== repoUrl || workflow?.path !== releaseWorkflowPath || workflow?.ref !== `refs/tags/${expected.tag}`) {
    throw new Error('npm provenance was not produced by the expected Caracal release workflow')
  }
  const dependency = statement.predicate?.buildDefinition?.resolvedDependencies?.find(
    (value) => value.uri === `git+${repoUrl}@refs/tags/${expected.tag}`,
  )
  if (dependency?.digest?.gitCommit !== expected.sha) throw new Error('npm provenance source commit does not match the release commit')
  const subject = statement.subject?.find((value) => value.name === packagePurl(expected.name, expected.version))
  if (!subject || subject.digest?.sha512 !== integrityDigest(metadata.dist?.integrity ?? '')) {
    throw new Error('npm provenance subject does not match the published package integrity')
  }
}

export function isRegistryPropagationError(output) {
  return /\bETARGET\b|No matching version found|notarget/i.test(output)
}

export async function fetchJsonWhenVisible(url, description, timeout = 300_000, interval = 15_000) {
  const deadline = Date.now() + timeout
  let attempt = 0
  while (true) {
    attempt += 1
    const response = await fetch(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } })
    if (response.ok) return response.json()
    if (response.status !== 404 || Date.now() >= deadline) {
      throw new Error(`${description} returned HTTP ${response.status}`)
    }
    process.stdout.write(`${description} is not visible yet; retrying verification (${attempt})\n`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, interval))
  }
}

async function installForVerification(directory, timeout = 300_000) {
  const deadline = Date.now() + timeout
  let attempt = 0
  while (true) {
    attempt += 1
    const result = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: directory,
      encoding: 'utf8',
    })
    if (result.status === 0) {
      process.stdout.write(result.stdout)
      return
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (!isRegistryPropagationError(output) || Date.now() >= deadline) {
      throw new Error(`npm install failed after ${attempt} attempts:\n${output}`)
    }
    process.stdout.write(`npm registry dependencies are not visible yet; retrying verification (${attempt})\n`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000))
  }
}

async function main() {
  const [name, version, sha, tag] = process.argv.slice(2)
  if (!name || !version || !commitPattern.test(sha ?? '') || !tag) {
    throw new Error('usage: verifyNpmRelease.mjs <package> <version> <source-sha> <release-tag>')
  }
  const metadata = await fetchJsonWhenVisible(packageUrl(name, version), `${name}@${version} metadata`)
  const attestationUrl = metadata.dist?.attestations?.url
  if (!attestationUrl) throw new Error(`${name}@${version} has no npm attestation URL`)
  const attestations = await fetchJsonWhenVisible(attestationUrl, `${name}@${version} attestations`)
  const directory = mkdtempSync(join(tmpdir(), 'caracal-npm-'))
  try {
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ private: true, dependencies: { [name]: version } })}\n`)
    await installForVerification(directory)
    execFileSync('npm', ['audit', 'signatures'], { cwd: directory, stdio: 'inherit' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  validateProvenance(metadata, attestations, { name, version, sha, tag })
  process.stdout.write(`${name}@${version} has verified npm signatures and source provenance\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
