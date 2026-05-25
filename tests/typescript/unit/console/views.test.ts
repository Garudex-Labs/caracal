// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ListView and DetailView behavior tests against a fake App.

import { describe, it, expect, vi } from 'vitest'
import { ListView } from '../../../../apps/console/src/views/list.ts'
import { DetailView } from '../../../../apps/console/src/views/detail.ts'
import { EntityPickerView } from '../../../../apps/console/src/views/picker.ts'
import type { App } from '../../../../apps/console/src/screen.ts'
import type { ConsoleStateStore } from '../../../../apps/console/src/state.ts'

function fakeApp(): App {
  const pushed: unknown[] = []
  const status: { text: string; kind: string }[] = []
  const app = {
    invalidate: vi.fn(),
    push: vi.fn((v: unknown) => { pushed.push(v) }),
    pop: vi.fn(),
    current: vi.fn(),
    setStatus: vi.fn((t: string, k: 'info' | 'error' = 'info') => { status.push({ text: t, kind: k }) }),
    exit: vi.fn(async () => {}),
    replaceTop: vi.fn(),
    bannerLeft: '',
    bannerRight: '',
  } as unknown as App
  ;(app as unknown as { _pushed: unknown[]; _status: typeof status })._pushed = pushed
  ;(app as unknown as { _pushed: unknown[]; _status: typeof status })._status = status
  return app
}

describe('AuditTailView', () => {
  it('keeps cursor at 0 when receiving navigation with no events', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const fakeClient = { audit: { tail: vi.fn(), byRequest: vi.fn() } } as unknown as Parameters<typeof AuditTailView>[0]
    const view = new AuditTailView(fakeClient as never, 'zone-1')
    const ctx = { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' }
    await view.onKey('down', ctx)
    await view.onKey('pgdn', ctx)
    await view.onKey('up', ctx)
    const rendered = view.render(ctx).join('\n')
    expect(rendered).toContain('no events yet')
    const cursor = (view as unknown as { cursor: number }).cursor
    expect(cursor).toBe(0)
  })

  it('sanitizes API-sourced fields so injected escapes cannot reach output', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const fakeClient = { audit: { tail: vi.fn(), byRequest: vi.fn() } } as unknown as Parameters<typeof AuditTailView>[0]
    const view = new AuditTailView(fakeClient as never, 'zone-1')
    ;(view as unknown as { events: unknown[] }).events = [{
      occurred_at: '2025-01-01T00:00:00Z',
      event_type: 'evil\u001b[2J',
      decision: 'allow',
      evaluation_status: 'ok',
      request_id: 'req-\u001b]0;hijack\u0007',
    }]
    const ctx = { app: fakeApp(), size: { rows: 10, cols: 200 }, status: '' }
    const lines = view.render(ctx).join('\n')
    // Only the SGR escapes that the renderer itself emits (e.g. invert/fg) may
    // appear; injected ESC bytes from event_type / request_id must be gone.
    expect(lines).not.toContain('evil\u001b[2J')
    expect(lines).not.toContain('\u001b]')
    expect(lines).not.toContain('\u0007')
  })
})

describe('ListView', () => {
  it('loads rows and renders header + cursor row', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string; name: string }>({
      title: 'things',
      columns: [{ header: 'id', width: 4, value: (r) => r.id }, { header: 'name', value: (r) => r.name }],
      load: async () => [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
    })
    await view.init(app)
    const lines = view.render({ app, size: { rows: 10, cols: 40 }, status: '' })
    expect(lines[0]).toContain('id')
    expect(lines[0]).toContain('name')
    expect(lines[1]).toContain('a')
    expect(lines[1]).toContain('Alpha')
    expect(lines[2]).toContain('b')
  })

  it('hides row IDs until reveal is requested', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string; name: string }>({
      title: 'things',
      columns: [{ header: 'name', value: (r) => r.name }],
      load: async () => [{ id: 'res-1', name: 'Payments API' }],
      rowId: (row) => row.id,
      rowName: (row) => row.name,
    })
    await view.init(app)
    let lines = view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(lines).toContain('Payments API')
    expect(lines).not.toContain('res-1')
    await view.onKey('V', { app, size: { rows: 10, cols: 80 }, status: '' })
    lines = view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(lines).toContain('res-1')
  })

  it('moves cursor with j/k and triggers onEnter on enter', async () => {
    const app = fakeApp()
    const seen: string[] = []
    const view = new ListView<{ id: string }>({
      title: 'x',
      columns: [{ header: 'id', value: (r) => r.id }],
      load: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      onEnter: (_app, row) => { seen.push(row.id) },
    })
    await view.init(app)
    await view.onKey('j', { app, size: { rows: 10, cols: 40 }, status: '' })
    await view.onKey('j', { app, size: { rows: 10, cols: 40 }, status: '' })
    await view.onKey('enter', { app, size: { rows: 10, cols: 40 }, status: '' })
    expect(seen).toEqual(['c'])
  })

  it('restores and persists the selected row when list state is configured', async () => {
    const app = fakeApp()
    const state = {
      listSelection: vi.fn(() => 'b'),
      setListSelection: vi.fn(),
    } as unknown as ConsoleStateStore
    const view = new ListView<{ id: string }>({
      title: 'x',
      columns: [{ header: 'id', value: (r) => r.id }],
      load: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      state,
      stateKey: 'things',
      zoneId: 'zone-1',
      rowKey: (row) => row.id,
    })

    await view.init(app)
    expect((view as unknown as { cursor: number }).cursor).toBe(1)

    await view.onKey('j', { app, size: { rows: 10, cols: 40 }, status: '' })
    expect(state.setListSelection).toHaveBeenCalledWith('things', 'c', 'zone-1')
  })

  it('shows error banner when load throws', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string }>({
      title: 'x',
      columns: [{ header: 'id', value: (r) => r.id }],
      load: async () => { throw new Error('boom') },
    })
    await view.init(app)
    const lines = view.render({ app, size: { rows: 10, cols: 40 }, status: '' })
    expect(lines[0]).toContain('error: boom')
  })

  it('esc back key pops the app', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string }>({
      title: 'x',
      columns: [{ header: 'id', value: (r) => r.id }],
      load: async () => [],
    })
    await view.init(app)
    await view.onKey('esc', { app, size: { rows: 10, cols: 40 }, status: '' })
    expect(app.pop).toHaveBeenCalled()
  })

  it('keeps cursor at 0 with empty rows on every navigation key', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string }>({
      title: 'x',
      columns: [{ header: 'id', value: (r) => r.id }],
      load: async () => [],
    })
    await view.init(app)
    const ctx = { app, size: { rows: 10, cols: 40 }, status: '' }
    for (const k of ['j', 'k', 'pgdn', 'pgup', 'g', 'G'] as const) {
      await view.onKey(k, ctx)
      expect((view as unknown as { cursor: number }).cursor).toBe(0)
    }
  })
})

describe('EntityPickerView', () => {
  it('searches by name and selects the hidden internal value', async () => {
    const app = fakeApp()
    const picked: string[] = []
    const view = new EntityPickerView<{ id: string; name: string; description: string }>({
      title: 'pick resource',
      rows: [
        { id: 'res-1', name: 'Payments API', description: 'prod' },
        { id: 'res-2', name: 'Billing API', description: 'dev' },
      ],
      load: async () => [],
      value: (row) => row.id,
      label: (row) => row.name,
      description: (row) => row.description,
      onPick: (value) => { picked.push(value) },
    })

    await view.onKey('B', { app, size: { rows: 10, cols: 80 }, status: '' })
    const body = view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(body).toContain('Billing API')
    expect(body).not.toContain('Payments API')
    expect(body).toContain('id:hidden')

    await view.onKey('enter', { app, size: { rows: 10, cols: 80 }, status: '' })
    expect(picked).toEqual(['res-2'])
  })
})

describe('DetailView', () => {
  it('renders structured detail fields', async () => {
    const app = fakeApp()
    const view = new DetailView({ title: 'x', load: async () => ({ name: 'demo', count: 3, status: 'active' }) })
    await view.init(app)
    const lines = view.render({ app, size: { rows: 10, cols: 80 }, status: '' })
    const joined = lines.join('\n')
    expect(joined).toContain('Overview')
    expect(joined).toContain('Name')
    expect(joined).toContain('demo')
    expect(joined).toContain('Count')
    expect(joined).toContain('Status')
    expect(joined).not.toContain('"name"')
    expect(joined).not.toContain('{')
  })

  it('groups nested detail data without JSON punctuation', async () => {
    const app = fakeApp()
    const view = new DetailView({
      title: 'x',
      load: async () => ({
        request_id: 'req-1',
        scopes: ['read', 'write'],
        claims: { subject_id: 'user-1', valid: true },
        attempts: [{ decision: 'deny', evaluation_status: 'blocked' }],
      }),
    })
    await view.init(app)
    const joined = view.render({ app, size: { rows: 30, cols: 100 }, status: '' }).join('\n')
    expect(joined).toContain('Request ID')
    expect(joined).toContain('Scopes (2)')
    expect(joined).toContain('Claims')
    expect(joined).toContain('Subject ID')
    expect(joined).toContain('Attempts (1)')
    expect(joined).toContain('#1')
    expect(joined).toContain('Decision')
    expect(joined).not.toContain('"subject_id"')
    expect(joined).not.toContain('"read"')
  })

  it('scrolls with j and k', async () => {
    const app = fakeApp()
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
    const view = new DetailView({ title: 'x', load: async () => big })
    await view.init(app)
    await view.onKey('j', { app, size: { rows: 5, cols: 80 }, status: '' })
    await view.onKey('j', { app, size: { rows: 5, cols: 80 }, status: '' })
    const lines = view.render({ app, size: { rows: 5, cols: 80 }, status: '' })
    expect(lines[0]).toContain('K0')
  })

  it('caps scroll offset so the last line stays visible (no off-by-one past end)', async () => {
    const app = fakeApp()
    const data = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, `line-${i}`]))
    const view = new DetailView({ title: 'x', load: async () => data })
    await view.init(app)
    const ctx = { app, size: { rows: 25, cols: 80 }, status: '' }
    for (let i = 0; i < 500; i++) await view.onKey('j', ctx)
    const offset = (view as unknown as { offset: number; body: string[] }).offset
    const body = (view as unknown as { body: string[] }).body
    // Maximum valid offset must show a full viewport ending on the last line.
    expect(offset).toBe(Math.max(0, body.length - ctx.size.rows))
    const rendered = view.render(ctx)
    expect(rendered.length).toBe(ctx.size.rows)
    expect(rendered[rendered.length - 1]).toContain(body[body.length - 1]!)
  })
})
