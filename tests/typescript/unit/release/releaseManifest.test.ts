// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests release manifest source binding and registry collision detection.

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { findPublished } from '../../../../scripts/checkReleaseVersions.mjs'
import { finalizeManifest } from '../../../../scripts/finalizeReleaseManifest.mjs'
import { fetchPublicGitHubRelease, validateGitHubRelease } from '../../../../scripts/verifyGitHubRelease.mjs'
import { releaseInventory } from '../../../../scripts/releaseInventory.mjs'
import { ensureRemoteReleaseTags } from '../../../../scripts/releaseTags.mjs'
import { validateProvenance } from '../../../../scripts/verifyNpmRelease.mjs'

const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const sha = 'a'.repeat(40)
const inventory = releaseInventory()
const npm = Object.fromEntries(inventory.packages.npm.filter((pkg) => pkg.publish).map((pkg) => [pkg.name, '9.9.9-rc.1']))
const pypi = Object.fromEntries(inventory.packages.pypi.filter((pkg) => pkg.publish).map((pkg) => [pkg.name, '9.9.9rc1']))
const go = Object.fromEntries(inventory.packages.go.filter((pkg) => pkg.publish).map((pkg) => [pkg.module, '9.9.9-rc.1']))
const containers = Object.fromEntries(
  inventory.config.product.containers
    .filter((container) => container.name !== 'runtime')
    .map((container) => [container.name, '9.9.9-rc.1']),
)
const images = Object.fromEntries(
  inventory.config.product.containers.map((container) => [container.name, `ghcr.io/garudex-labs/caracal-${container.name}:v9.9.9-rc.1`]),
)
const manifest = {
  release: 'v9.9.9-rc.1',
  mode: 'rc',
  version: '9.9.9-rc.1',
  generatedAt: '2026-07-11T00:00:00.000Z',
  registries: {
    npm: 'https://registry.npmjs.org/',
    pypi: 'https://pypi.org/simple/',
    oci: 'ghcr.io/garudex-labs',
    githubReleases: 'https://github.com/Garudex-Labs/caracal/releases/download',
  },
  binaries: { runtime: '9.9.9-rc.1' },
  runtimeImage: '9.9.9-rc.1',
  containers,
  helm: { chartVersion: '9.9.9-rc.1', appVersion: '9.9.9-rc.1', imageTag: '9.9.9-rc.1' },
  images,
  npm,
  pypi,
  packages: {
    published: { npm, pypi, go },
    unchanged: { npm: {}, pypi: {}, go: {} },
  },
  githubRelease: {
    tag: 'v9.9.9-rc.1',
    assets: 'https://github.com/Garudex-Labs/caracal/releases/download/v9.9.9-rc.1',
  },
}

const servers: Array<ReturnType<typeof createServer>> = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function releaseRepository(): { work: string; remote: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'caracal-release-tags-'))
  const work = join(dir, 'work')
  const remote = join(dir, 'remote.git')
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
  execFileSync('git', ['init', work], { stdio: 'ignore' })
  git(work, ['config', 'user.name', 'Caracal Release Test'])
  git(work, ['config', 'user.email', 'release-test@caracal.invalid'])
  writeFileSync(join(work, 'release.txt'), 'release\n')
  git(work, ['add', 'release.txt'])
  git(work, ['commit', '-m', 'release fixture'])
  git(work, ['remote', 'add', 'origin', remote])
  return { work, remote, sha: git(work, ['rev-parse', 'HEAD']) }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))))
})

describe('release manifest finalization', () => {
  it('replaces preparation metadata with the exact clean source commit', () => {
    const finalized = finalizeManifest({ ...manifest, sha: 'stale', source: { gitSha: 'stale', dirty: true } }, sha)

    expect(finalized.sha).toBe(sha)
    expect(finalized.source).toEqual({ gitSha: sha, dirty: false })
  })

  it('rejects abbreviated source commits', () => {
    expect(() => finalizeManifest(manifest, 'abc123')).toThrow('full lowercase Git commit')
  })

  it('validates a finalized manifest against its expected commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-release-'))
    const path = join(dir, 'manifest.json')
    writeFileSync(path, `${JSON.stringify(finalizeManifest(manifest, sha))}\n`)

    const result = spawnSync(process.execPath, ['scripts/validateReleaseManifest.mjs', '--source-sha', sha, path], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('release manifests ok')
  })

  it('rejects dirty or mismatched finalized source metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-release-'))
    const path = join(dir, 'manifest.json')
    writeFileSync(path, `${JSON.stringify({ ...finalizeManifest(manifest, sha), source: { gitSha: sha, dirty: true } })}\n`)

    const result = spawnSync(process.execPath, ['scripts/validateReleaseManifest.mjs', '--source-sha', sha, path], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('finalized release source must be clean')
  })

  it('keeps committed release plans independent of a not-yet-created tag commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-release-'))
    const path = join(dir, 'manifest.json')
    writeFileSync(path, `${JSON.stringify(manifest)}\n`)

    const result = spawnSync(process.execPath, ['scripts/validateReleaseManifest.mjs', path], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(path, 'utf8')).not.toContain('source')
  })

  it('rejects a candidate manifest outside the configured product version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-release-'))
    const path = join(dir, 'manifest.json')
    writeFileSync(path, `${JSON.stringify(manifest)}\n`)

    const result = spawnSync(process.execPath, ['scripts/validateReleaseManifest.mjs', '--product-version', path], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match product.version')
  })

  it('rejects an incomplete image inventory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-release-'))
    const path = join(dir, 'manifest.json')
    const incomplete = structuredClone(manifest)
    Reflect.deleteProperty(incomplete.images, 'runtime')
    writeFileSync(path, `${JSON.stringify(incomplete)}\n`)

    const result = spawnSync(process.execPath, ['scripts/validateReleaseManifest.mjs', path], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('images keys')
  })
})

describe('release registry preflight', () => {
  it('pins the Windows publication dependencies with hashes', () => {
    const requirements = readFileSync(join(root, 'scripts', 'publishPypiRequirements.in'), 'utf8')
    const lock = readFileSync(join(root, 'scripts', 'publishPypiRequirements.lock'), 'utf8')

    expect(requirements).toMatch(/^colorama==0\.4\.6$/m)
    expect(requirements).toMatch(/^pywin32-ctypes==0\.2\.3$/m)
    expect(lock).toMatch(/^colorama==0\.4\.6 \\\n(?:    --hash=sha256:[0-9a-f]{64} \\\n)+    --hash=sha256:[0-9a-f]{64}$/m)
    expect(lock).toMatch(/^pywin32-ctypes==0\.2\.3 \\\n(?:    --hash=sha256:[0-9a-f]{64} \\\n)+    --hash=sha256:[0-9a-f]{64}$/m)
  })

  it('reports immutable versions that already exist', async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.url?.includes('existing') ? 200 : 404
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test registry did not bind a TCP port')
    const base = `http://127.0.0.1:${address.port}/`

    const published = await findPublished(
      [
        { ecosystem: 'npm', name: '@caracalai/existing', version: '0.2.0-rc.1' },
        { ecosystem: 'pypi', name: 'caracalai-missing', version: '0.2.0rc1' },
      ],
      { npmRegistry: base, pypiApi: base },
    )

    expect(published).toEqual(['@caracalai/existing@0.2.0-rc.1'])
  })
})

describe('npm release provenance', () => {
  it('binds the signed package subject to the release workflow and commit', () => {
    const name = '@caracalai/sdk'
    const version = '9.9.9-rc.1'
    const tag = `v${version}`
    const digest = 'ab'.repeat(64)
    const statement = {
      subject: [{ name: `pkg:npm/%40caracalai/sdk@${version}`, digest: { sha512: digest } }],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: 'https://github.com/Garudex-Labs/caracal',
              path: '.github/workflows/release.yml',
              ref: `refs/tags/${tag}`,
            },
          },
          resolvedDependencies: [
            {
              uri: `git+https://github.com/Garudex-Labs/caracal@refs/tags/${tag}`,
              digest: { gitCommit: sha },
            },
          ],
        },
      },
    }

    expect(() =>
      validateProvenance(
        { version, gitHead: sha, dist: { integrity: `sha512-${Buffer.from(digest, 'hex').toString('base64')}` } },
        {
          attestations: [
            {
              predicateType: 'https://slsa.dev/provenance/v1',
              bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } },
            },
          ],
        },
        { name, version, sha, tag },
      ),
    ).not.toThrow()
  })
})

describe('GitHub Release publication', () => {
  it('rejects a draft or incorrect release classification', () => {
    expect(() => validateGitHubRelease({ tag_name: 'v9.9.9-rc.1', draft: true, prerelease: true }, 'v9.9.9-rc.1', 'rc')).toThrow(
      'still a draft',
    )
    expect(() => validateGitHubRelease({ tag_name: 'v9.9.9-rc.1', draft: false, prerelease: false }, 'v9.9.9-rc.1', 'rc')).toThrow(
      'expected true',
    )
  })

  it('verifies public visibility without sending authorization', async () => {
    let authorization: string | undefined
    let accept: string | undefined
    const server = createServer((request, response) => {
      authorization = request.headers.authorization
      accept = request.headers.accept
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ tag_name: 'v9.9.9-rc.1', draft: false, prerelease: true }))
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test GitHub API did not bind a TCP port')

    await expect(fetchPublicGitHubRelease(`http://127.0.0.1:${address.port}/release`, 'v9.9.9-rc.1', 'rc')).resolves.toMatchObject({
      draft: false,
      prerelease: true,
    })
    expect(authorization).toBeUndefined()
    expect(accept).toBe('application/vnd.github+json')
  })
})

describe('release tag publication', () => {
  const tags = ['v9.9.9-rc.1', 'packages/core/go/v9.9.9-rc.1']

  it('publishes one atomic tag set and safely verifies it on retry', () => {
    const { work, sha } = releaseRepository()

    expect(ensureRemoteReleaseTags(work, tags, sha)).toMatchObject({ created: true, tags })
    expect(ensureRemoteReleaseTags(work, tags, sha)).toMatchObject({ created: false, tags })
    for (const tag of tags) expect(git(work, ['ls-remote', 'origin', `refs/tags/${tag}^{}`])).toContain(sha)
  })

  it('rejects a partial remote release tag set', () => {
    const { work, sha } = releaseRepository()
    git(work, ['tag', '-a', tags[0], sha, '-m', tags[0]])
    git(work, ['push', 'origin', `refs/tags/${tags[0]}`])

    expect(() => ensureRemoteReleaseTags(work, tags, sha)).toThrow('only 1 of 2 release tags')
  })

  it('removes only tags created by a rejected atomic push', () => {
    const { work, remote, sha } = releaseRepository()
    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/usr/bin/env sh\nexit 1\n')
    chmodSync(hook, 0o755)

    expect(() => ensureRemoteReleaseTags(work, tags, sha)).toThrow()
    for (const tag of tags) expect(spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: work }).status).not.toBe(0)
  })
})
