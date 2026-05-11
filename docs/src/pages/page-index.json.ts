/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Build-time generator for the /page-index.json metadata index.
 */

import { getCollection } from 'astro:content'

const site = 'https://docs.garudexlabs.com'

export async function GET() {
  const docs = await getCollection('docs')

  const pages = docs
    .filter((d) => d.id !== 'index')
    .map((d) => {
      const data = d.data as Record<string, unknown>
      return {
        id: d.id,
        url: `${site}/${d.id}/`,
        title: d.data.title,
        description: d.data.description,
        pageType: (data.pageType as string | undefined) ?? null,
        concepts: (data.concepts as string[] | undefined) ?? [],
        relatedConcepts: (data.relatedConcepts as string[] | undefined) ?? [],
        requires: (data.requires as string[] | undefined) ?? [],
        keywords: (data.keywords as string[] | undefined) ?? [],
        aliases: (data.aliases as string[] | undefined) ?? [],
        service: (data.service as string | undefined) ?? null,
      }
    })

  const body = JSON.stringify(
    {
      generated: new Date().toISOString(),
      product: 'Caracal',
      baseUrl: site,
      pages,
    },
    null,
    2,
  )

  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
