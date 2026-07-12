#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Creates and verifies one atomic product and Go module release tag set.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commitPattern, releaseTagPattern } from './lib/releaseSpec.mjs'

function git(cwd, args, options = {}) {
  const output = execFileSync('git', args, { cwd, encoding: 'utf8', ...options })
  return typeof output === 'string' ? output.trim() : ''
}

function localTagCommit(cwd, tag) {
  try {
    return git(cwd, ['rev-list', '-n', '1', `refs/tags/${tag}`], { stdio: ['ignore', 'pipe', 'ignore'] }) || null
  } catch {
    return null
  }
}

function remoteTagCommit(cwd, remote, tag) {
  const output = git(cwd, ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
  if (!output) return null
  const refs = new Map(output.split(/\r?\n/).map((line) => line.split(/\s+/, 2).reverse()))
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null
}

export function releaseTags(config, version) {
  return [`v${version}`, ...config.packages.go.filter((mod) => mod.publish !== false).map((mod) => `${mod.dir}/v${version}`)]
}

export function verifyLocalReleaseTags(cwd, tags, expectedSha) {
  for (const tag of tags) {
    const actual = localTagCommit(cwd, tag)
    if (actual !== expectedSha) throw new Error(`${tag} resolves to ${actual ?? 'no commit'}; expected ${expectedSha}`)
  }
}

export function verifyRemoteReleaseTags(cwd, tags, expectedSha, remote = 'origin') {
  for (const tag of tags) {
    const actual = remoteTagCommit(cwd, remote, tag)
    if (actual !== expectedSha) throw new Error(`${tag} resolves to ${actual ?? 'no commit'}; expected ${expectedSha}`)
  }
}

export function ensureRemoteReleaseTags(cwd, tags, expectedSha, remote = 'origin') {
  const remoteCommits = new Map(tags.map((tag) => [tag, remoteTagCommit(cwd, remote, tag)]))
  for (const [tag, commit] of remoteCommits) {
    if (commit && commit !== expectedSha) throw new Error(`${tag} resolves to ${commit}; expected ${expectedSha}`)
  }
  const missing = tags.filter((tag) => !remoteCommits.get(tag))
  if (missing.length === 0) {
    verifyRemoteReleaseTags(cwd, tags, expectedSha, remote)
    return { created: false, tags }
  }

  const created = []
  try {
    for (const tag of missing) {
      const actual = localTagCommit(cwd, tag)
      if (actual && actual !== expectedSha) throw new Error(`local ${tag} resolves to ${actual}; expected ${expectedSha}`)
      if (!actual) {
        git(cwd, ['tag', '-a', tag, expectedSha, '-m', tag])
        created.push(tag)
      }
    }
    verifyLocalReleaseTags(cwd, missing, expectedSha)
    git(cwd, ['push', '--atomic', remote, ...missing.map((tag) => `refs/tags/${tag}`)], { stdio: 'inherit' })
    verifyRemoteReleaseTags(cwd, tags, expectedSha, remote)
    return { created: true, tags }
  } catch (error) {
    if (created.length > 0) execFileSync('git', ['tag', '--delete', ...created], { cwd, stdio: 'ignore' })
    throw error
  }
}

function main() {
  const [tag, expectedSha] = process.argv.slice(2)
  if (!releaseTagPattern.test(tag ?? '')) {
    throw new Error(`invalid release tag: ${tag ?? '<empty>'}`)
  }
  if (!commitPattern.test(expectedSha ?? '')) throw new Error(`invalid source commit: ${expectedSha ?? '<empty>'}`)
  const cwd = process.cwd()
  const config = JSON.parse(readFileSync(resolve(cwd, 'release.config.json'), 'utf8'))
  verifyLocalReleaseTags(cwd, releaseTags(config, tag.slice(1)), expectedSha)
  process.stdout.write(`verified release tag set for ${tag} at ${expectedSha}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
