#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies GitHub Release classification and unauthenticated public visibility.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateGitHubRelease(release, tag, channel) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/.test(tag ?? '')) throw new Error(`invalid release tag: ${tag}`)
  if (!['rc', 'stable'].includes(channel)) throw new Error(`invalid release channel: ${channel}`)
  if (release?.tag_name !== tag) throw new Error(`GitHub Release tag ${release?.tag_name} does not match ${tag}`)
  if (release.draft !== false) throw new Error(`GitHub Release ${tag} is still a draft`)
  const expectedPrerelease = channel === 'rc'
  if (release.prerelease !== expectedPrerelease) {
    throw new Error(`GitHub Release ${tag} prerelease=${release.prerelease}; expected ${expectedPrerelease}`)
  }
  return release
}

export async function fetchPublicGitHubRelease(url, tag, channel, fetcher = fetch) {
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) throw new Error(`public GitHub Release ${tag} returned HTTP ${response.status}`)
  return validateGitHubRelease(await response.json(), tag, channel)
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args.shift()
  const values = new Map()
  while (args.length > 0) {
    const key = args.shift()
    const value = args.shift()
    if (!key?.startsWith('--') || !value) throw new Error(`invalid argument: ${key ?? '<empty>'}`)
    values.set(key.slice(2), value)
  }
  const tag = values.get('tag')
  const channel = values.get('channel')
  if (mode === 'file') {
    const path = values.get('path')
    if (!path) throw new Error('--path is required')
    validateGitHubRelease(JSON.parse(readFileSync(resolve(path), 'utf8')), tag, channel)
  } else if (mode === 'public') {
    const url = values.get('url')
    if (!url) throw new Error('--url is required')
    await fetchPublicGitHubRelease(url, tag, channel)
  } else {
    throw new Error('usage: verifyGitHubRelease.mjs file|public --tag TAG --channel rc|stable --path PATH|--url URL')
  }
  process.stdout.write(`verified public GitHub Release ${tag}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
