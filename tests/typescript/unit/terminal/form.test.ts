// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// FormView focus, validation, secret reveal, and dispose-abort tests.

import { describe, it, expect, vi } from 'vitest'
import { FormView } from '../../../../apps/tui/src/views/form.ts'
import type { App } from '../../../../apps/tui/src/screen.ts'

function fakeApp(): App {
  const status: { text: string; kind: string }[] = []
  const popped: number[] = []
  const app = {
    invalidate: vi.fn(),
    push: vi.fn(),
    pop: vi.fn(() => { popped.push(1) }),
    setStatus: vi.fn((t: string, k: 'info' | 'error' = 'info') => { status.push({ text: t, kind: k }) }),
    current: vi.fn(),
    exit: vi.fn(async () => {}),
    replaceTop: vi.fn(),
    bannerLeft: '',
    bannerRight: '',
  } as unknown as App
  ;(app as unknown as { _status: typeof status; _popped: number[] })._status = status
  ;(app as unknown as { _status: typeof status; _popped: number[] })._popped = popped
  return app
}

describe('FormView focus', () => {
  it('moves focus with tab and j on bool fields', async () => {
    const view = new FormView({
      title: 't',
      fields: [
        { key: 'a', label: 'a', kind: 'bool', default: 'false' },
        { key: 'b', label: 'b', kind: 'bool', default: 'false' },
      ],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    const ctx = { app, size: { rows: 10, cols: 80 }, status: '' }
    await view.onKey('tab', ctx)
    expect((view as unknown as { focus: number }).focus).toBe(1)
    await view.onKey('j', ctx)
    expect((view as unknown as { focus: number }).focus).toBe(2)
  })
})

describe('FormView input UX', () => {
  it('renders required text fields as editable inputs', () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'name', label: 'name', kind: 'text', required: true }],
      onSubmit: async () => {},
    })
    const lines = view.render({ app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' }).join('\n')
    expect(lines).toContain('Type or paste into fields')
    expect(lines).toContain('name *')
    expect(lines).toContain('[ <name> ]')
  })

  it('accepts pasted text chunks in text fields', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'id', label: 'application id', kind: 'text', required: true }],
      onSubmit: async () => {},
    })
    await view.onKey('019e3025-999e-753c-8a09-7c8acc3f6480', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    expect(view.values_().id).toBe('019e3025-999e-753c-8a09-7c8acc3f6480')
  })

  it('accepts bracketed paste in text fields', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'name', label: 'name', kind: 'text' }],
      onSubmit: async () => {},
    })
    await view.onKey('\u001b[200~Ryan\'s Workflow\u001b[201~', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    expect(view.values_().name).toBe('Ryan\'s Workflow')
  })
})

describe('FormView validation', () => {
  it('blocks submit when required field empty', async () => {
    const submit = vi.fn(async () => {})
    const view = new FormView({
      title: 't',
      fields: [{ key: 'name', label: 'name', kind: 'text', required: true }],
      onSubmit: submit,
    })
    const app = fakeApp()
    await view.onKey('enter', { app, size: { rows: 10, cols: 80 }, status: '' })
    expect(submit).not.toHaveBeenCalled()
    const status = (app as unknown as { _status: { text: string; kind: string }[] })._status
    expect(status[0]!.text).toMatch(/required/)
  })

  it('runs custom validator', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 'n', label: 'n', kind: 'text', default: 'bad', validate: (v) => v === 'bad' ? 'no good' : undefined }],
      onSubmit: vi.fn(async () => {}),
    })
    const app = fakeApp()
    await view.onKey('enter', { app, size: { rows: 10, cols: 80 }, status: '' })
    const status = (app as unknown as { _status: { text: string; kind: string }[] })._status
    expect(status[0]!.text).toBe('no good')
  })
})

describe('FormView secret', () => {
  it('masks by default and reveals with right arrow', async () => {
    const view = new FormView({
      title: 't',
      fields: [{ key: 's', label: 's', kind: 'secret', default: 'topsecret' }],
      onSubmit: async () => {},
    })
    const ctx = { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' }
    let lines = view.render(ctx).join('\n')
    expect(lines).toContain('••••')
    expect(lines).not.toContain('topsecret')
    await view.onKey('right', ctx)
    lines = view.render(ctx).join('\n')
    expect(lines).toContain('topsecret')
  })
})

describe('FormView list field', () => {
  it('passes raw csv to onSubmit', async () => {
    const submit = vi.fn(async () => {})
    const view = new FormView({
      title: 't',
      fields: [{ key: 'tags', label: 'tags', kind: 'list', default: 'a,b,c' }],
      onSubmit: submit,
    })
    await view.onKey('enter', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    expect(submit).toHaveBeenCalledWith({ tags: 'a,b,c' }, expect.anything())
  })
})

describe('FormView picker fields', () => {
  it('opens focused field picker with right arrow and lets it set the value', async () => {
    const pick = vi.fn((_app: App, setValue: (value: string) => void) => {
      setValue('picked-id')
    })
    const view = new FormView({
      title: 't',
      fields: [{ key: 'application_id', label: 'application', kind: 'text', pick }],
      onSubmit: async () => {},
    })
    const app = fakeApp()
    await view.onKey('right', { app, size: { rows: 10, cols: 80 }, status: '' })
    expect(pick).toHaveBeenCalled()
    expect(view.values_().application_id).toBe('picked-id')
    expect(view.hints()).toContain('→:pick')
  })
})

describe('FormView esc cancels', () => {
  it('pops the app and calls onCancel', async () => {
    const cancel = vi.fn()
    const view = new FormView({ title: 't', fields: [], onSubmit: async () => {}, onCancel: cancel })
    const app = fakeApp()
    await view.onKey('esc', { app, size: { rows: 10, cols: 80 }, status: '' })
    expect(cancel).toHaveBeenCalled()
    expect(app.pop).toHaveBeenCalled()
  })
})

describe('FormView dispose', () => {
  it('aborts the controller', () => {
    const view = new FormView({ title: 't', fields: [], onSubmit: async () => {} })
    expect(view.abort.signal.aborted).toBe(false)
    view.dispose()
    expect(view.abort.signal.aborted).toBe(true)
  })
})
