/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Generates the Operator's bundled documentation corpus from the docs build's llms-full.txt.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '../../../docs/dist/llms-full.txt')
const out = resolve(here, '../src/operator-docs-corpus.ts')

// Each page may contribute at most this many characters of body to the corpus. The exact names,
// endpoints, and fields the Operator must not invent live near the top of each page, so a generous
// cap keeps the corpus grounded without shipping the entire site into the API image.
const MAX_BODY_CHARS = 6000

if (!existsSync(source)) {
  console.error(`docs corpus source not found: ${source}\nRun the docs build first: pnpm --filter @caracalai/docs build`)
  process.exit(1)
}

const raw = readFileSync(source, 'utf8')

// llms-full.txt is a sequence of page blocks. Each block is a metadata header fenced by --- lines
// (# Title, # URL:, # Markdown:, # Type:, # Concepts:, # Requires:) followed by the page body, up to
// the next header fence. Parse on the fenced metadata blocks so the split can never run inside body
// prose that happens to contain a horizontal rule.
function parsePages(text) {
  const lines = text.split('\n')
  const pages = []
  let current = null
  let i = 0
  while (i < lines.length) {
    if (lines[i] === '---' && lines[i + 1]?.startsWith('# ') && hasUrlWithin(lines, i + 1)) {
      if (current) pages.push(current)
      const meta = {}
      const title = lines[i + 1].slice(2).trim()
      let j = i + 2
      while (j < lines.length && lines[j] !== '---') {
        const m = /^# ([A-Za-z]+):\s*(.*)$/.exec(lines[j])
        if (m) meta[m[1].toLowerCase()] = m[2].trim()
        j++
      }
      current = { title, url: meta.url ?? '', concepts: meta.concepts ?? '', body: [] }
      i = j + 1
      continue
    }
    if (current) current.body.push(lines[i])
    i++
  }
  if (current) pages.push(current)
  return pages
}

// A metadata fence is a --- line followed by a # Title and, within the next few lines, a # URL:
// field. Body prose with an incidental --- never has that shape, so this disambiguates the two.
function hasUrlWithin(lines, start) {
  for (let k = start; k < Math.min(start + 8, lines.length); k++) {
    if (lines[k] === '---') return false
    if (lines[k].startsWith('# URL:')) return true
  }
  return false
}

// Reduce a page id from its canonical URL: the path under the docs site, without the trailing
// slash, so a citation names a stable page rather than a full URL.
function pageId(url) {
  try {
    const path = new URL(url).pathname.replace(/\/$/, '')
    return path.length > 0 ? path : '/'
  } catch {
    return url
  }
}

// Strip the body to retrieval-useful prose: drop fenced diagrams that carry no searchable terms,
// collapse runs of blank lines, and cap the length. Code blocks are kept — they hold the exact
// package names, endpoints, and snippets the Operator must quote correctly.
function cleanBody(lines) {
  const text = lines.join('\n')
  const withoutMermaid = text.replace(/```mermaid[\s\S]*?```/g, '')
  return withoutMermaid
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY_CHARS)
}

const pages = parsePages(raw)
  .map((page) => ({
    id: pageId(page.url),
    title: page.title,
    url: page.url,
    concepts: page.concepts,
    body: cleanBody(page.body),
  }))
  .filter((page) => page.body.length > 0 && page.id !== '/' && page.title !== 'Caracal')

const header = `// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Generated documentation corpus the Operator retrieves over; regenerate with scripts/build-docs-corpus.mjs.

import type { DocPage } from './operator-docs.js'

export const DOCS_CORPUS: DocPage[] = ${JSON.stringify(pages, null, 0)}
`

writeFileSync(out, header)
const bytes = Buffer.byteLength(header)
console.log(`wrote ${pages.length} pages to ${out} (${(bytes / 1024).toFixed(0)} KiB)`)
