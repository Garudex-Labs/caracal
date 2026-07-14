// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Operator's in-process documentation retrieval over the bundled corpus.

import { describe, it, expect } from 'vitest'
import { retrieveDocs, docsCorpusSize } from '../../../../apps/api/src/operator-docs.js'

describe('docsCorpusSize', () => {
  it('ships a non-empty documentation corpus with the Operator', () => {
    // The corpus is generated from the docs build and bundled into the API, so retrieval needs no
    // network call. An empty corpus would mean the generated module was lost.
    expect(docsCorpusSize()).toBeGreaterThan(50)
  })
})

describe('retrieveDocs', () => {
  it('returns nothing for a query with no meaningful terms', () => {
    expect(retrieveDocs('the a an of to')).toEqual([])
  })

  it('surfaces the TypeScript SDK page with the exact package name for an SDK question', () => {
    const results = retrieveDocs('what is the typescript sdk package name and how do I load a profile')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toContain('typescript')
    // The whole point of retrieval: the exact, real package name is in the grounding text, so the
    // model quotes @caracalai/sdk rather than inventing @caracal/sdk.
    const joined = results.map((r) => r.snippet).join('\n')
    expect(joined).toContain('@caracalai/sdk')
  })

  it('surfaces the approval decision endpoint from the densest passage of a long API page', () => {
    const results = retrieveDocs('subject-plane decision endpoint authenticated with a federated user session mandate')
    const joined = results.map((r) => r.snippet).join('\n')
    // The decision route lives deep in the STS API reference; the densest-window snippet
    // must reach it rather than stopping at the page's opening lines.
    expect(joined).toContain('/step-up/{id}/decision')
    expect(results.some((r) => r.id.includes('sts'))).toBe(true)
  })

  it('keeps Caracal identifiers intact as searchable terms', () => {
    // A query naming the identifier verbatim must match the page that defines provider auth modes.
    const results = retrieveDocs('which provider auth modes support shared service credentials or API keys')
    const joined = results.map((r) => `${r.id} ${r.snippet}`).join('\n')
    expect(joined).toMatch(/client_credentials|API key|Bearer token/i)
  })

  it('returns at most the requested number of passages, each citing a page', () => {
    const results = retrieveDocs('how do I create a zone and grant access to a resource', 2)
    expect(results.length).toBeLessThanOrEqual(2)
    for (const result of results) {
      expect(result.id.startsWith('/')).toBe(true)
      expect(result.url.length).toBeGreaterThan(0)
      expect(result.snippet.length).toBeGreaterThan(0)
    }
  })
})
