#!/usr/bin/env node
// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Authorizes a workflow actor against the maintainer registry on the default branch.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseMaintainers(text) {
  return [...text.matchAll(/@([A-Za-z0-9_-]+)/g)].map((match) => match[1].toLowerCase())
}

export function isAuthorized(actor, maintainers, { allowGitHubBot = false } = {}) {
  if (allowGitHubBot && actor === 'github-actions[bot]') return true
  return maintainers.includes(actor.toLowerCase())
}

function main() {
  const args = process.argv.slice(2)
  let actor = ''
  let branch = ''
  let allowGitHubBot = false
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case '--actor':
        actor = args[++index] ?? ''
        break
      case '--branch':
        branch = args[++index] ?? ''
        break
      case '--allow-github-bot':
        allowGitHubBot = true
        break
      default:
        throw new Error(`unknown argument: ${args[index]}`)
    }
  }
  const repository = process.env.GITHUB_REPOSITORY
  if (!actor || !branch || !repository) {
    throw new Error('usage: authorizeReleaseActor.mjs --actor NAME --branch BRANCH [--allow-github-bot] with GITHUB_REPOSITORY set')
  }
  const response = execFileSync('gh', ['api', `repos/${repository}/contents/.github/MAINTAINERS?ref=${branch}`], { encoding: 'utf8' })
  const registry = Buffer.from(JSON.parse(response).content, 'base64').toString('utf8')
  if (!isAuthorized(actor, parseMaintainers(registry), { allowGitHubBot })) {
    throw new Error(`${actor} is not listed in .github/MAINTAINERS on ${branch} and cannot run release workflows`)
  }
  process.stdout.write(`${actor} is authorized for release workflows\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
