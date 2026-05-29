// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ListView and DetailView behavior tests against a fake App.

import { describe, it, expect, vi } from 'vitest'
import { Buffer } from 'node:buffer'
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
    expect(lines).toContain('1 Jan, 00:00 UTC')
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

  it('shows only collection-safe footer actions when the table is empty', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string }>({
      title: 'zones',
      columns: [{ header: 'id', value: (r) => r.id }],
      load: async () => [],
      onEnter: () => {},
      actions: [
        { key: 'n', label: 'new', requiresSelection: false, build: () => fakeView() },
        { key: 'e', label: 'edit', build: () => fakeView() },
        { key: 'd', label: 'delete', build: () => fakeView() },
      ],
    })
    await view.init(app)

    const ids = view.footerActions({ app, size: { rows: 10, cols: 80 }, status: '' }).map((item) => item.id)

    expect(ids).toEqual(['new', 'reload', 'back'])
  })

  it('prioritizes row workflows and hides utility identity actions by default', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string; name: string }>({
      title: 'zones',
      columns: [{ header: 'name', value: (r) => r.name }],
      load: async () => [{ id: 'z1', name: 'prod' }],
      onEnter: () => {},
      rowId: (row) => row.id,
      rowName: (row) => row.name,
      actions: [
        { key: 'n', label: 'new', requiresSelection: false, build: () => fakeView() },
        { key: 'e', label: 'edit', build: () => fakeView() },
        { key: 'd', label: 'delete', build: () => fakeView() },
      ],
    })
    await view.init(app)

    const ids = view.footerActions({ app, size: { rows: 10, cols: 80 }, status: '' }).map((item) => item.id)

    expect(ids).toEqual(['open', 'new', 'edit', 'delete', 'move', 'reload', 'back'])
  })

  it('removes actions blocked by readonly and entity capability flags', async () => {
    const app = fakeApp()
    const view = new ListView<{ id: string; name: string; protected: boolean }>({
      title: 'resources',
      columns: [{ header: 'name', value: (r) => r.name }],
      load: async () => [{ id: 'r1', name: 'control', protected: true }],
      onEnter: () => {},
      readonly: true,
      entityFlags: (row) => row.protected ? ['protected_entity'] : [],
      actions: [
        { key: 'e', label: 'edit', hiddenWhen: ['loading', 'readonly'], build: () => fakeView() },
        { key: 'd', label: 'delete', hiddenWhen: ['loading', 'readonly', 'protected_entity'], build: () => fakeView() },
      ],
    })
    await view.init(app)

    const ids = view.footerActions({ app, size: { rows: 10, cols: 80 }, status: '' }).map((item) => item.id)

    expect(ids).toEqual(['open', 'move', 'reload', 'back'])
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

  it('treats alphabet keys as search text', async () => {
    const app = fakeApp()
    const view = new EntityPickerView<{ id: string; name: string }>({
      title: 'pick application',
      rows: [
        { id: 'app-1', name: 'alpha runner' },
        { id: 'app-2', name: 'key broker' },
      ],
      load: async () => [],
      value: (row) => row.id,
      label: (row) => row.name,
      onPick: () => {},
    })

    await view.onKey('k', { app, size: { rows: 10, cols: 80 }, status: '' })
    const body = view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(body).toContain('key broker')
    expect(body).not.toContain('alpha runner')
  })

  it('loads rows on init and renders a loading frame beforehand', async () => {
    const app = fakeApp()
    const view = new EntityPickerView<{ id: string; name: string }>({
      title: 'pick',
      load: async () => [{ id: 'a', name: 'Alpha' }],
      value: (row) => row.id,
      label: (row) => row.name,
      onPick: () => {},
    })
    expect(view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')).toContain('loading')
    await view.init(app)
    expect(view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')).toContain('Alpha')
  })

  it('surfaces loader failures as an error frame', async () => {
    const app = fakeApp()
    const view = new EntityPickerView<{ id: string; name: string }>({
      title: 'pick',
      load: async () => { throw new Error('boom') },
      value: (row) => row.id,
      label: (row) => row.name,
      onPick: () => {},
    })
    await view.init(app)
    expect(view.render({ app, size: { rows: 10, cols: 80 }, status: '' }).join('\n')).toContain('error')
  })

  it('reveals ids, copies values, and opens contextual info', async () => {
    const app = fakeApp()
    const view = new EntityPickerView<{ id: string; name: string }>({
      title: 'pick',
      rows: [{ id: 'res-1', name: 'Payments' }],
      load: async () => [],
      value: (row) => row.id,
      label: (row) => row.name,
      onPick: () => {},
    })
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }
    await view.onKey('V', ctx)
    expect(view.render(ctx).join('\n')).toContain('id:res-1')
    await view.onKey('N', ctx)
    await view.onKey('I', ctx)
    const status = (app as unknown as { _status: { text: string }[] })._status
    expect(status.some((s) => s.text.includes('copied name'))).toBe(true)
    expect(status.some((s) => s.text.includes('copied id'))).toBe(true)
    await view.onKey('?', ctx)
    expect(app.push).toHaveBeenCalled()
  })

  it('navigates with paging keys and pops on escape', async () => {
    const app = fakeApp()
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, name: `Row ${i}` }))
    const view = new EntityPickerView<{ id: string; name: string }>({
      title: 'pick', rows, load: async () => [],
      value: (row) => row.id, label: (row) => row.name, onPick: () => {},
    })
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }
    await view.onKey('end', ctx)
    expect((view as unknown as { cursor: number }).cursor).toBe(29)
    await view.onKey('pgup', ctx)
    expect((view as unknown as { cursor: number }).cursor).toBe(19)
    await view.onKey('home', ctx)
    expect((view as unknown as { cursor: number }).cursor).toBe(0)
    await view.onKey('pgdn', ctx)
    expect((view as unknown as { cursor: number }).cursor).toBe(10)
    await view.onKey('down', ctx)
    await view.onKey('up', ctx)
    expect((view as unknown as { cursor: number }).cursor).toBe(10)
    await view.onKey('esc', ctx)
    expect(app.pop).toHaveBeenCalled()
  })

  it('disambiguates duplicate labels and renders icons', async () => {
    const app = fakeApp()
    const view = new EntityPickerView<{ id: string; name: string }>({
      title: 'pick',
      rows: [
        { id: 'aaaa1111', name: 'Worker' },
        { id: 'bbbb2222', name: 'Worker' },
      ],
      load: async () => [],
      value: (row) => row.id,
      label: (row) => row.name,
      icon: () => '*',
      onPick: () => {},
    })
    const body = view.render({ app, size: { rows: 10, cols: 120 }, status: '' }).join('\n')
    expect(body).toContain('Worker (')
    expect(body).toContain('*')
  })

  it('clears the search with backspace', async () => {
    const app = fakeApp()
    const view = new EntityPickerView<{ id: string; name: string }>({
      title: 'pick',
      rows: [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }],
      load: async () => [],
      value: (row) => row.id,
      label: (row) => row.name,
      onPick: () => {},
    })
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }
    await view.onKey('b', ctx)
    expect(view.render(ctx).join('\n')).not.toContain('alpha')
    await view.onKey('backspace', ctx)
    expect(view.render(ctx).join('\n')).toContain('alpha')
  })
})

function fakeView() {
  return {
    title: 'fake',
    hints: () => [],
    render: () => [],
    onKey: () => {},
  }
}

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

  it('renders ISO date fields as readable timestamps in details', async () => {
    const app = fakeApp()
    const view = new DetailView({ title: 'x', load: async () => ({ created_at: '2026-05-28T04:48:55.460Z' }) })
    await view.init(app)

    const joined = view.render({ app, size: { rows: 10, cols: 100 }, status: '' }).join('\n')

    expect(joined).toContain('28 May 2026, 04:48:55 UTC')
    expect(joined).not.toContain('2026-05-28T04:48:55.460Z')
  })

  it('copies raw page JSON by default without rendered transformations', async () => {
    const app = fakeApp()
    const data = {
      id: 'z1',
      created_at: '2026-05-28T04:48:55.460Z',
      enabled: true,
      nested_value: { ids: ['a', 'b'] },
    }
    const view = new DetailView({ title: 'zone', load: async () => data })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await view.init(app)

      const ids = view.footerActions().map((action) => action.id)
      expect(ids).toContain('copy-page')
      expect(ids).not.toContain('copy-id')

      await view.onKey('Y', { app, size: { rows: 10, cols: 100 }, status: '' })
      const payload = String(write.mock.calls.at(-1)?.[0] ?? '')
      const encoded = payload.match(/\u001b\]52;c;([^\u0007]+)\u0007/)?.[1]
      expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe(JSON.stringify(data, null, 2))
      expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toContain('2026-05-28T04:48:55.460Z')
    } finally {
      write.mockRestore()
    }
  })

  it('copies array-shaped review pages', async () => {
    const app = fakeApp()
    const data = [{ id: 'event-1' }, { id: 'event-2' }]
    const view = new DetailView({ title: 'audit review', load: async () => data })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await view.init(app)

      expect(view.footerActions().map((action) => action.id)).toContain('copy-page')

      await view.onKey('Y', { app, size: { rows: 10, cols: 100 }, status: '' })
      const payload = String(write.mock.calls.at(-1)?.[0] ?? '')
      const encoded = payload.match(/\u001b\]52;c;([^\u0007]+)\u0007/)?.[1]
      expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe(JSON.stringify(data, null, 2))
    } finally {
      write.mockRestore()
    }
  })

  it('supports explicit copy-page opt-out', async () => {
    const app = fakeApp()
    const view = new DetailView({ title: 'plain', load: async () => ({ id: 'z1' }), copyPage: false })
    await view.init(app)

    expect(view.footerActions().map((action) => action.id)).not.toContain('copy-page')
    expect(view.hints()).not.toContain('Y:copy-page')
  })

  it('hides reveal when the page has no hidden content', async () => {
    const app = fakeApp()
    const view = new DetailView({
      title: 'plain',
      load: async () => ({ id: 'z1', name: 'zone' }),
      mask: (_value, path) => path[path.length - 1] === 'access_token' ? '••••' : undefined,
    })
    await view.init(app)

    expect(view.footerActions().map((action) => action.id)).not.toContain('reveal')
    expect(view.hints()).not.toContain('v:reveal')
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

describe('AuditTailView lifecycle and interaction', () => {
  function auditClient(events: unknown[], opts: { fail?: boolean } = {}) {
    return {
      audit: {
        list: vi.fn(async () => { if (opts.fail) throw new Error('audit boom'); return events }),
        byRequest: vi.fn(async () => []),
      },
    } as unknown as Parameters<typeof import('../../../../apps/console/src/views/audit.ts')['AuditTailView']> extends never ? never : import('@caracalai/admin').AdminClient
  }

  const sample = [
    { id: 'e1', occurred_at: '2025-01-01T00:00:00Z', event_type: 'token_exchange', decision: 'allow', evaluation_status: 'ok', request_id: 'req-1' },
    { id: 'e2', occurred_at: '2025-01-01T00:01:00Z', event_type: 'introspect', decision: 'deny', evaluation_status: 'ok', request_id: 'req-2' },
    { id: 'e3', occurred_at: '2025-01-01T00:02:00Z', event_type: 'authorize', decision: 'partial', evaluation_status: 'ok', request_id: undefined },
  ]

  it('fetches events on init and renders coloured decisions', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const view = new AuditTailView(auditClient(sample) as never, 'z1', { limit: 50 })
    await view.init(fakeApp())
    const ctx = { app: fakeApp(), size: { rows: 10, cols: 120 }, status: '' }
    const out = view.render(ctx).join('\n')
    expect(out).toContain('token_exchange')
    expect(out).toContain('allow')
    expect(out).toContain('deny')
    expect(out).toContain('partial')
    view.dispose()
  })

  it('reports an error status when the initial fetch fails', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const app = fakeApp()
    const view = new AuditTailView(auditClient([], { fail: true }) as never, 'z1')
    await view.init(app)
    const status = (app as unknown as { _status: { text: string; kind: string }[] })._status
    expect(status.some((s) => s.kind === 'error' && s.text.includes('audit:'))).toBe(true)
    view.dispose()
  })

  it('cycles the decision filter, toggles pause, and reloads', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const client = auditClient(sample)
    const changes: unknown[] = []
    const view = new AuditTailView(client as never, 'z1', {}, (f) => changes.push(f))
    await view.init(fakeApp())
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 120 }, status: '' }
    await view.onKey('d', ctx)
    expect(view.hints().some((h) => h === 'filter:allow')).toBe(true)
    expect(changes.length).toBe(1)
    await view.onKey('p', ctx)
    expect(view.hints()).toContain('p:resume')
    await view.onKey('r', ctx)
    expect((client.audit.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
    view.dispose()
  })

  it('navigates rows and opens an explain detail on enter', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const view = new AuditTailView(auditClient(sample) as never, 'z1')
    await view.init(fakeApp())
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 120 }, status: '' }
    await view.onKey('down', ctx)
    await view.onKey('enter', ctx)
    expect(app.push).toHaveBeenCalled()
    view.dispose()
  })

  it('opens contextual info and pops on escape', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const view = new AuditTailView(auditClient(sample) as never, 'z1')
    await view.init(fakeApp())
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 120 }, status: '' }
    await view.onKey('?', ctx)
    expect(app.push).toHaveBeenCalled()
    await view.onKey('esc', ctx)
    expect(app.pop).toHaveBeenCalled()
    view.dispose()
  })

  it('summarizes active filters in the hints', async () => {
    const { AuditTailView } = await import('../../../../apps/console/src/views/audit.ts')
    const view = new AuditTailView(auditClient([]) as never, 'z1', {
      since: '2025-01-01', request_id: 'req-9', event_type: 'authorize', limit: 25,
    })
    const hints = view.hints().join(' ')
    expect(hints).toContain('since:2025-01-01')
    expect(hints).toContain('request:req-9')
    expect(hints).toContain('event:authorize')
    expect(hints).toContain('limit:25')
  })
})
