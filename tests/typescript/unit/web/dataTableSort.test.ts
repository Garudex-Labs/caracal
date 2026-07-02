// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies the DataTable announces sort state to assistive tech via aria-sort, aria-label, and aria-hidden.

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DataTable, type Column, type SortState } from '@/components/ui/DataTable'

interface Row {
  id: string
  name: string
}

const columns: Column<Row>[] = [
  { id: 'name', header: 'Name', sortable: true, cell: (r) => r.name },
  { id: 'created', header: 'Created', sortable: true, cell: () => '-' },
  { id: 'plain', header: 'Plain', cell: () => '-' },
]

const rows: Row[] = [{ id: '1', name: 'PiperNet' }]

function render(sort?: SortState): string {
  return renderToStaticMarkup(
    createElement(DataTable<Row>, {
      columns,
      rows,
      rowKey: (r) => r.id,
      sort,
      onSortChange: () => {},
    }),
  )
}

function count(html: string, needle: RegExp): number {
  return html.match(needle)?.length ?? 0
}

describe('DataTable sort accessibility', () => {
  it('marks the active ascending column aria-sort=ascending and other sortable columns none', () => {
    const html = render({ column: 'name', direction: 'asc' })
    expect(count(html, /aria-sort="ascending"/g)).toBe(1)
    expect(count(html, /aria-sort="none"/g)).toBe(1)
    expect(html).not.toContain('aria-sort="descending"')
  })

  it('marks the active descending column aria-sort=descending', () => {
    const html = render({ column: 'name', direction: 'desc' })
    expect(count(html, /aria-sort="descending"/g)).toBe(1)
    expect(count(html, /aria-sort="none"/g)).toBe(1)
    expect(html).not.toContain('aria-sort="ascending"')
  })

  it('marks every sortable column aria-sort=none when nothing is sorted', () => {
    const html = render()
    expect(count(html, /aria-sort="none"/g)).toBe(2)
    expect(html).not.toContain('aria-sort="ascending"')
    expect(html).not.toContain('aria-sort="descending"')
  })

  it('only sortable columns carry aria-sort', () => {
    // Two sortable columns, one plain: exactly two aria-sort attributes render.
    const html = render({ column: 'name', direction: 'asc' })
    expect(count(html, /aria-sort=/g)).toBe(2)
  })

  it('gives each sort button a descriptive aria-label and no label on plain headers', () => {
    const html = render()
    expect(html).toContain('aria-label="Sort by Name"')
    expect(html).toContain('aria-label="Sort by Created"')
    expect(html).not.toContain('aria-label="Sort by Plain"')
  })

  it('hides the decorative sort glyph from assistive tech', () => {
    const html = render({ column: 'name', direction: 'asc' })
    expect(count(html, /aria-hidden="true"/g)).toBe(2)
  })
})
