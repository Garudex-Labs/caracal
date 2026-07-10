// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests documentation minor-version routing, metadata, and release invariants.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReleaseVersion, validateState } from '../../../../scripts/docsVersion.mjs'
import { docsEntryId, docsHref, logicalDocId, prefixSidebar, versionedRedirects } from '../../../../docs/versioning.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const released = {
  schemaVersion: 1,
  target: null,
  current: 'v0.3',
  versions: [
    { version: 'v0.3', release: 'v0.3.0', releasedAt: '2026-08-01', locked: false, digest: null },
    { version: 'v0.2', release: 'v0.2.0', releasedAt: '2026-07-10', locked: true, digest },
  ],
}

describe('documentation version metadata', () => {
  it('accepts the first unreleased target without a snapshot', () => {
    expect(validateState({ schemaVersion: 1, target: 'v0.2', current: null, versions: [] })).toBeTruthy()
  })

  it('accepts ordered stable minors with only the current minor unlocked', () => {
    expect(validateState(structuredClone(released))).toBeTruthy()
  })

  it('rejects patch-level documentation versions', () => {
    const state = structuredClone(released)
    state.versions[1].version = 'v0.2.1'
    expect(() => validateState(state)).toThrow('must match vX.Y')
  })

  it('rejects a historical minor without its immutable digest', () => {
    const state = structuredClone(released)
    state.versions[1].digest = null
    expect(() => validateState(state)).toThrow('must be locked')
  })

  it('derives the documentation minor from a stable product release', () => {
    expect(parseReleaseVersion('v1.4.0')).toMatchObject({ release: 'v1.4.0', minor: 'v1.4', patch: 0 })
    expect(parseReleaseVersion('1.4.3')).toMatchObject({ release: 'v1.4.3', minor: 'v1.4', patch: 3 })
    expect(() => parseReleaseVersion('v1.4.0-rc.1')).toThrow('stable X.Y.Z')
  })
})

describe('documentation version routing', () => {
  it('keeps the only documentation source unversioned before v0.2', () => {
    const state = { schemaVersion: 1, target: 'v0.2', current: null, versions: [] }
    expect(docsEntryId({ entry: 'guides/setup.mdx', data: {} }, state, false)).toBe('guides/setup')
  })

  it('routes mutable source to next after versioning begins', () => {
    expect(docsEntryId({ entry: 'index.mdx', data: {} }, released, false)).toBe('next')
    expect(docsEntryId({ entry: 'guides/setup.mdx', data: {} }, released, false)).toBe('next/guides/setup')
    expect(docsEntryId({ entry: 'v0.3/guides/setup.mdx', data: { slug: 'v0.3/guides/setup' } }, released, false)).toBe('v0.3/guides/setup')
  })

  it('keeps source IDs unversioned while a release snapshot is being created', () => {
    expect(docsEntryId({ entry: 'guides/setup.mdx', data: {} }, released, true)).toBe('guides/setup')
  })

  it('removes current, historical, and next route prefixes from logical page IDs', () => {
    expect(logicalDocId('v0.3/guides/setup', released)).toBe('guides/setup')
    expect(logicalDocId('v0.2/guides/setup', released)).toBe('guides/setup')
    expect(logicalDocId('next/guides/setup', released)).toBe('guides/setup')
  })

  it('keeps custom links inside the selected version', () => {
    expect(docsHref('/v0.2/guides/setup/', '/concepts/', released)).toBe('/v0.2/concepts/')
    expect(docsHref('/next/guides/setup/', '/concepts/', released)).toBe('/next/concepts/')
    expect(docsHref('/v0.2/guides/setup/', 'https://example.com', released)).toBe('https://example.com')
  })

  it('prefixes nested sidebars without changing external links', () => {
    const sidebar = [
      {
        label: 'Start',
        items: [
          { label: 'Overview', link: '/' },
          { label: 'Guide', link: '/guide/' },
        ],
      },
      { label: 'Source', link: 'https://github.com/Garudex-Labs/caracal' },
    ]
    expect(prefixSidebar(sidebar, 'v0.3')).toEqual([
      {
        label: 'Start',
        items: [
          { label: 'Overview', link: '/v0.3/' },
          { label: 'Guide', link: '/v0.3/guide/' },
        ],
      },
      { label: 'Source', link: 'https://github.com/Garudex-Labs/caracal' },
    ])
  })

  it('redirects legacy unversioned routes to the current stable minor', () => {
    const source = mkdtempSync(join(tmpdir(), 'caracal-docs-'))
    try {
      mkdirSync(join(source, 'guide'), { recursive: true })
      mkdirSync(join(source, 'v0.3'), { recursive: true })
      writeFileSync(join(source, 'index.mdx'), '---\ntitle: Home\n---\n')
      writeFileSync(join(source, 'guide', 'index.mdx'), '---\ntitle: Guide\n---\n')
      writeFileSync(join(source, 'v0.3', 'index.mdx'), '---\ntitle: Snapshot\n---\n')

      expect(versionedRedirects({ '/old/': '/guide/' }, source, released)).toMatchObject({
        '/': '/v0.3/',
        '/guide/': '/v0.3/guide/',
        '/old/': '/v0.3/guide/',
      })
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  })
})
