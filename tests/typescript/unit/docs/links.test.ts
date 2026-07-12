// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Validates every internal documentation link and anchor against the actual page and heading inventory.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const docsRoot = join(__dirname, '../../../../docs/src/content/docs')

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function collectPages(dir: string, pages: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectPages(path, pages)
    else if (entry.name.endsWith('.mdx')) pages.set(relative(docsRoot, path), readFileSync(path, 'utf8'))
  }
}

function routeOf(relPath: string): string {
  return relPath
    .replace(/\.mdx$/, '')
    .replace(/\/index$/, '')
    .replace(/^index$/, '')
}

describe('documentation links', () => {
  const pages = new Map<string, string>()
  collectPages(docsRoot, pages)

  const routes = new Map<string, string>()
  for (const [relPath] of pages) routes.set(routeOf(relPath), relPath)

  const anchors = new Map<string, Set<string>>()
  for (const [relPath, content] of pages) {
    const set = new Set<string>()
    for (const match of content.matchAll(/^#{2,4}\s+(.+)$/gm)) set.add(slugify(match[1]))
    for (const match of content.matchAll(/id="([^"]+)"/g)) set.add(match[1])
    anchors.set(relPath, set)
  }

  it('resolves every internal page link and anchor', () => {
    const problems: string[] = []
    for (const [relPath, content] of pages) {
      for (const match of content.matchAll(/\]\((\/[a-z0-9/._-]*?)(?:#([a-zA-Z0-9_-]+))?\)/g)) {
        const target = match[1].replace(/\/$/, '').replace(/^\//, '')
        if (target.startsWith('schemas/') || target.startsWith('img/')) continue
        const targetPage = routes.get(target)
        if (targetPage === undefined) {
          problems.push(`${relPath}: no page for ${match[1]}`)
          continue
        }
        const fragment = match[2]
        if (fragment && !anchors.get(targetPage)?.has(fragment)) {
          problems.push(`${relPath}: no anchor ${match[1]}#${fragment}`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})
