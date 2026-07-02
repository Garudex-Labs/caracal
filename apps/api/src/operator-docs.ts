// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-process documentation retrieval that grounds the Operator's answers in the real Caracal docs.

import { DOCS_CORPUS } from './operator-docs-corpus.js'

// One documentation page in the bundled corpus: a stable id and canonical url for citation, the
// concepts it covers, and the retrieval-useful body text. The corpus ships with the Operator, so
// retrieval needs no network call and no data leaves the deployment.
export interface DocPage {
  id: string
  title: string
  url: string
  concepts: string
  body: string
}

// A retrieved passage: the page it came from and a bounded snippet centered on the part of the page
// most relevant to the query, so the model sees the exact names and endpoints to quote without the
// whole page inflating the prompt.
export interface DocSnippet {
  id: string
  title: string
  url: string
  snippet: string
}

const SNIPPET_CHARS = 900
const DEFAULT_TOP_K = 3

// Words that carry no retrieval signal. Dropped from the query so scoring is driven by the terms
// that actually distinguish one page from another.
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'be',
  'do',
  'does',
  'how',
  'what',
  'why',
  'when',
  'where',
  'which',
  'who',
  'can',
  'i',
  'my',
  'me',
  'we',
  'our',
  'you',
  'your',
  'it',
  'this',
  'that',
  'these',
  'those',
  'as',
  'at',
  'by',
  'from',
  'into',
  'about',
  'should',
  'would',
  'could',
  'use',
  'using',
  'get',
  'set',
  'need',
  'want',
  'so',
  'if',
  'then',
  'up',
])

// Tokenizes text into lowercase terms for scoring: alphanumerics plus the separators that appear in
// Caracal identifiers (@, /, :, ., -) are kept inside a token so "@caracalai/sdk", "resource://",
// and "step-up-challenges" survive as searchable terms rather than being split apart.
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9@/:._-]*/g) ?? []).filter((token) => token.length > 1)
}

// The query terms that drive scoring: tokenized, stop-words removed, de-duplicated. An identifier
// like "@caracalai/sdk" also contributes its internal parts so a query phrased loosely still matches
// the page that defines it.
function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const token of tokenize(query)) {
    if (STOP_WORDS.has(token)) continue
    terms.add(token)
    for (const part of token.split(/[@/:._-]+/)) {
      if (part.length > 2 && !STOP_WORDS.has(part)) terms.add(part)
    }
  }
  return [...terms]
}

// Scores a page against the query terms. Title and concept matches weigh more than body matches
// because they signal the page's subject, and each term is counted with diminishing returns so a
// single term repeated many times cannot outrank a page that covers more of the query.
function scorePage(page: DocPage, terms: string[]): number {
  const title = page.title.toLowerCase()
  const concepts = page.concepts.toLowerCase()
  const id = page.id.toLowerCase()
  const body = page.body.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (title.includes(term)) score += 8
    if (concepts.includes(term)) score += 5
    if (id.includes(term)) score += 4
    const count = occurrences(body, term)
    if (count > 0) score += 2 + Math.log2(count)
  }
  return score
}

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count++
    from = at + needle.length
  }
}

// Extracts the most relevant window of a page body: the position where query terms cluster most
// densely, expanded to a bounded length and trimmed to clean boundaries, so the snippet shows the
// model the exact passage that answers the query — an endpoint table or a code block deep in a long
// page — rather than just the page's opening lines.
function bestSnippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase()
  // Collect every occurrence of every term, then find the window of SNIPPET_CHARS that covers the
  // most occurrences. This favors a dense cluster (for example an endpoint reference table) over the
  // first incidental mention near the top of the page.
  const hits: number[] = []
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(term, from)
      if (at === -1) break
      hits.push(at)
      from = at + term.length
    }
  }
  if (hits.length === 0) return body.slice(0, SNIPPET_CHARS).trim()
  hits.sort((a, b) => a - b)
  let bestStart = hits[0]
  let bestCount = 0
  for (const anchor of hits) {
    const windowEnd = anchor + SNIPPET_CHARS
    let count = 0
    for (const hit of hits) {
      if (hit >= anchor && hit < windowEnd) count++
      else if (hit >= windowEnd) break
    }
    if (count > bestCount) {
      bestCount = count
      bestStart = anchor
    }
  }
  const start = Math.max(0, bestStart - SNIPPET_CHARS / 4)
  const end = Math.min(body.length, start + SNIPPET_CHARS)
  let snippet = body.slice(start, end)
  if (start > 0) snippet = `…${snippet.replace(/^\S*\s/, '')}`
  if (end < body.length) snippet = `${snippet.replace(/\s\S*$/, '')}…`
  return snippet.trim()
}

// Retrieves the documentation pages most relevant to a query as bounded snippets, or an empty list
// when nothing scores above zero. Pure in-memory work over the bundled corpus, so it adds no network
// call and no latency budget beyond a scan; safe to call on every answer turn.
export function retrieveDocs(query: string, topK: number = DEFAULT_TOP_K): DocSnippet[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const scored = DOCS_CORPUS.map((page) => ({ page, score: scorePage(page, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
  return scored.map(({ page }) => ({
    id: page.id,
    title: page.title,
    url: page.url,
    snippet: bestSnippet(page.body, terms),
  }))
}

// The number of pages in the bundled corpus, so startup can log that documentation grounding is
// available and a test can assert the corpus shipped rather than being empty.
export function docsCorpusSize(): number {
  return DOCS_CORPUS.length
}
