/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Build-time generator for the /concept-graph.json knowledge graph.
 */

import { getCollection } from 'astro:content'
import concepts from '../data/concepts.json'
import { docsVersionState, logicalDocId, publishedDocs, publishedPath } from '../../versioning.mjs'

const site = 'https://docs.caracal.run'

export async function GET() {
  const docs = publishedDocs(await getCollection('docs'))

  const nodes = docs
    .filter((d) => logicalDocId(d.id) !== 'index')
    .map((d) => {
      const data = d.data as Record<string, unknown>
      return {
        id: logicalDocId(d.id),
        url: `${site}${publishedPath(d.id)}`,
        markdownUrl: `${site}/markdown/${d.id}.md`,
        title: d.data.title,
        pageType: (data.pageType as string | undefined) ?? null,
        concepts: (data.concepts as string[] | undefined) ?? [],
        requires: (data.requires as string[] | undefined) ?? [],
      }
    })

  const edges: Array<{ source: string; target: string; type: string }> = []
  for (const node of nodes) {
    for (const req of node.requires) {
      edges.push({ source: node.id, target: req, type: 'requires' })
    }
    for (const concept of node.concepts) {
      edges.push({ source: node.id, target: concept, type: 'about' })
    }
  }

  const body = JSON.stringify(
    {
      generated: new Date().toISOString(),
      version: docsVersionState.current ?? docsVersionState.target,
      nodes,
      edges,
      conceptRegistry: concepts,
    },
    null,
    2,
  )

  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
