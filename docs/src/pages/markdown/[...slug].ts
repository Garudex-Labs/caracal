/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Static Markdown endpoint for each documentation page.
 */

import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { formatPageMarkdown } from '../../lib/pageMarkdown'

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs')

  // The .md extension lives in the param value rather than the route filename:
  // extension-suffixed dynamic routes collide with trailingSlash normalization
  // during static generation, which rejects every generated path.
  return docs
    .filter((doc) => doc.id !== '404')
    .map((doc) => ({
      params: { slug: `${doc.id}.md` },
      props: { doc },
    }))
}

export const GET: APIRoute = ({ props }) => {
  return new Response(formatPageMarkdown(props.doc), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
