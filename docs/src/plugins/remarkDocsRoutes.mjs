/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Rewrites documentation links to remain inside their selected minor-version route.
 */

import { docsVersionState } from '../../versioning.mjs'

const rootFiles = new Set(['/concept-graph.json', '/llms-full.txt', '/llms.txt', '/page-index.json', '/robots.txt', '/sitemap-index.xml'])
const publicPrefixes = ['/img/', '/markdown/', '/schemas/', '/sitemap-']

export function docsContentHref(href, filePath = '', state = docsVersionState) {
  if (!href.startsWith('/') || href.startsWith('//') || rootFiles.has(href)) return href
  if (publicPrefixes.some((prefix) => href.startsWith(prefix))) return href
  if (/^\/v\d+\.\d+(?:\/|$)/.test(href) || href === '/next' || href.startsWith('/next/')) return href

  const normalizedPath = filePath.replaceAll('\\', '/')
  const snapshot = normalizedPath.match(/\/content\/docs\/(v\d+\.\d+)(?:\/|$)/)?.[1]
  const version = snapshot ?? (state.current ? 'next' : state.target)
  if (!version) return href

  return href === '/' ? `/${version}/` : `/${version}${href}`
}

export function remarkDocsRoutes() {
  return (tree, file) => {
    visit(tree, (node) => {
      if (node.type === 'link' && typeof node.url === 'string') {
        node.url = docsContentHref(node.url, file.path)
      }

      if (node.type !== 'mdxJsxTextElement' && node.type !== 'mdxJsxFlowElement') return
      const href = node.attributes?.find(
        (attribute) => attribute.type === 'mdxJsxAttribute' && attribute.name === 'href' && typeof attribute.value === 'string',
      )
      if (href) href.value = docsContentHref(href.value, file.path)
    })
  }
}

function visit(node, callback) {
  callback(node)
  if (!Array.isArray(node.children)) return
  for (const child of node.children) visit(child, callback)
}
