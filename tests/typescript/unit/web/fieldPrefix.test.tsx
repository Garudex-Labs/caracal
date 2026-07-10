/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the Field primitive's locked-prefix variant that renders a fixed namespace ahead of the editable text.
*/
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { Field } from '@/components/ui/Primitives'
import { ViewOnlyProvider } from '@/components/ui/ViewOnly'

function inputTag(html: string): string {
  const match = html.match(/<input[^>]*>/)
  expect(match, 'expected an input control').not.toBeNull()
  return match![0]
}

describe('Field prefix variant', () => {
  it('renders the locked namespace ahead of the editable input, hidden from assistive tech', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: 'Identifier',
        prefix: 'resource://',
        value: 'pipernet',
        onChange: () => {},
      }),
    )
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('resource://')
    expect(html).toContain('font-mono')
    // The editable value excludes the namespace, so users type only the varying part.
    expect(inputTag(html)).toContain('value="pipernet"')
    expect(inputTag(html)).not.toContain('resource://')
  })

  it('moves the error treatment onto the wrapper when a prefix is present', () => {
    const withError = renderToStaticMarkup(
      createElement(Field, { prefix: 'provider://', error: 'Required', value: '', onChange: () => {} }),
    )
    expect(withError).toContain('border-destructive')
    expect(withError).toContain('focus-within:ring-destructive/25')
    expect(withError).toContain('>Required<')

    const clean = renderToStaticMarkup(createElement(Field, { prefix: 'provider://', hint: 'Slug only.', value: '', onChange: () => {} }))
    expect(clean).not.toContain('border-destructive')
    expect(clean).toContain('>Slug only.<')
  })

  it('dims the whole control and disables the input on a read-only surface', () => {
    const html = renderToStaticMarkup(
      createElement(
        ViewOnlyProvider,
        { readOnly: true },
        createElement(Field, { prefix: 'resource://', value: 'nucleus', onChange: () => {} }),
      ),
    )
    expect(html).toContain('cursor-not-allowed opacity-50')
    expect(inputTag(html)).toContain('disabled')
  })

  it('keeps the plain single-input control when no prefix is given', () => {
    const html = renderToStaticMarkup(createElement(Field, { label: 'Name', error: 'Required', value: '', onChange: () => {} }))
    expect(html).not.toContain('aria-hidden')
    expect(inputTag(html)).toContain('border-destructive')
    expect(html).toContain('>Required<')
  })
})
