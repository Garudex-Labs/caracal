/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Documentation Markdown formatting helpers for page copy endpoints.
 */

const site = 'https://docs.caracal.run'

type MarkdownPage = {
  id: string
  body?: string
  data: {
    title: string
    description: string
    pageType?: string
    concepts?: string[]
    requires?: string[]
  }
}

export function formatPageMarkdown(doc: MarkdownPage) {
  const canonicalUrl = doc.id === 'index' ? `${site}/` : `${site}/${doc.id}/`
  const markdownUrl = `${site}/markdown/${doc.id}.md`
  const lines = [
    '---',
    `title: ${JSON.stringify(doc.data.title)}`,
    `url: ${JSON.stringify(canonicalUrl)}`,
    `markdown_url: ${JSON.stringify(markdownUrl)}`,
    `description: ${JSON.stringify(doc.data.description)}`,
    `page_type: ${JSON.stringify(doc.data.pageType ?? 'page')}`,
    `concepts: ${JSON.stringify(doc.data.concepts ?? [])}`,
    `requires: ${JSON.stringify(doc.data.requires ?? [])}`,
    '---',
    '',
    `# ${doc.data.title}`,
    '',
    `Canonical URL: ${canonicalUrl}`,
    `Markdown URL: ${markdownUrl}`,
    `Description: ${doc.data.description}`,
    `Page type: ${doc.data.pageType ?? 'page'}`,
    `Concepts: ${(doc.data.concepts ?? []).join(', ') || 'none'}`,
    `Requires: ${(doc.data.requires ?? []).join(', ') || 'none'}`,
    '',
    '---',
    '',
    doc.body ?? '',
    '',
  ]

  return lines.join('\n')
}
