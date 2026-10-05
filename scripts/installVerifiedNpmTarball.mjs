#!/usr/bin/env node
// Install a pinned npm package without running npm's install/lifecycle scripts.
// The caller supplies the version and the independently pinned registry SHA-512.

import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const [name, version, integrity, directory] = process.argv.slice(2)
if (
  !/^[a-z][a-z0-9-]*$/.test(name ?? '') ||
  !/^\d+\.\d+\.\d+$/.test(version ?? '') ||
  !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? '') ||
  !directory
) {
  throw new Error('usage: installVerifiedNpmTarball.mjs <name> <exact-version> <sha512-integrity> <destination>')
}

const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
const bytes = await new Promise((accept, reject) => {
  https
    .get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`download failed: HTTP ${response.statusCode}`))
        return
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => accept(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    .on('error', reject)
})

const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
if (actual !== integrity) throw new Error(`integrity mismatch for ${name}@${version}`)

const temp = mkdtempSync(join(tmpdir(), 'caracal-npm-'))
try {
  const archive = join(temp, 'package.tgz')
  writeFileSync(archive, bytes)
  mkdirSync(resolve(directory), { recursive: true })
  const tar = spawnSync('tar', ['-xzf', archive, '-C', resolve(directory), '--strip-components=1'], { stdio: 'inherit' })
  if (tar.error || tar.status !== 0) throw tar.error ?? new Error(`tar failed: ${tar.status}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
