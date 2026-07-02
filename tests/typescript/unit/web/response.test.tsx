// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests that the Operator Response component renders markdown features as HTML rather than raw source.

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { Response } from '@/components/ai-elements/response'

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(Response, null, markdown))
}

describe('Operator Response markdown', () => {
  it('renders bold, italic, and strikethrough without leaking syntax', () => {
    const html = render('A **bold** and _italic_ and ~~struck~~ word.')
    expect(html).toContain('font-semibold')
    expect(html).toContain('<del')
    expect(html).toContain('italic')
    expect(html).not.toContain('**bold**')
    expect(html).not.toContain('~~struck~~')
  })

  it('renders headings', () => {
    const html = render('# Title\n\n## Subtitle')
    expect(html).toMatch(/<h1[^>]*>.*Title.*<\/h1>/s)
    expect(html).toMatch(/<h2[^>]*>.*Subtitle.*<\/h2>/s)
  })

  it('renders unordered and ordered lists', () => {
    const html = render('- one\n- two\n\n1. first\n2. second')
    expect(html).toContain('<ul')
    expect(html).toContain('<ol')
    expect(html).toContain('<li')
    expect(html).toContain('one')
    expect(html).toContain('first')
  })

  it('renders task lists with checkboxes', () => {
    const html = render('- [x] done\n- [ ] todo')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
  })

  it('renders blockquotes and horizontal rules', () => {
    const html = render('> quoted\n\n---')
    expect(html).toContain('<blockquote')
    expect(html).toContain('<hr')
  })

  it('renders inline code and fenced code blocks', () => {
    const html = render('Use `npm` here.\n\n```ts\nconst x = 1;\n```')
    expect(html).toContain('<code')
    expect(html).toContain('npm')
    expect(html).toContain('<pre')
  })

  it('renders tables', () => {
    const html = render('| A | B |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
  })

  it('renders links', () => {
    const html = render('See [docs](https://example.com).')
    expect(html).toContain('data-streamdown="link"')
    expect(html).toContain('docs')
    expect(html).not.toContain('](https://example.com)')
  })

  it('completes incomplete markdown while streaming so partial tokens do not leak', () => {
    const html = render('A partial **bold')
    expect(html).toContain('font-semibold')
    expect(html).not.toContain('**bold')
  })
})
