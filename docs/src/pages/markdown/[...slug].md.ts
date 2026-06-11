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

  return docs
    .filter((doc) => doc.id !== '404')
    .map((doc) => ({
      params: { slug: doc.id },
      props: { doc },
    }))
}

export const GET: APIRoute = ({ props }) => {
  return new Response(formatPageMarkdown(props.doc), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
