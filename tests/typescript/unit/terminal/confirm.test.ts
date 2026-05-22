// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ConfirmView y/n guard and dispose tests.

import { describe, it, expect, vi } from 'vitest'
import { ConfirmView } from '../../../../apps/tui/src/views/form.ts'
import type { App } from '../../../../apps/tui/src/screen.ts'

function fakeApp(): App {
  const app = {
    invalidate: vi.fn(),
    push: vi.fn(),
    pop: vi.fn(),
    setStatus: vi.fn(),
    current: vi.fn(),
    exit: vi.fn(async () => {}),
    replaceTop: vi.fn(),
    bannerLeft: '',
    bannerRight: '',
  } as unknown as App
  return app
}

describe('ConfirmView', () => {
  it('runs onConfirm when y pressed', async () => {
    const confirm = vi.fn(async () => {})
    const view = new ConfirmView({ message: 'sure?', onConfirm: confirm })
    await view.onKey('y', { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    expect(confirm).toHaveBeenCalled()
  })

  it('cancels on n and on esc', async () => {
    const cancel = vi.fn()
    for (const k of ['n', 'N', 'esc'] as const) {
      const app = fakeApp()
      const view = new ConfirmView({ message: '?', onConfirm: vi.fn(), onCancel: cancel })
      await view.onKey(k, { app, size: { rows: 10, cols: 80 }, status: '' })
      expect(app.pop).toHaveBeenCalled()
    }
    expect(cancel).toHaveBeenCalledTimes(3)
  })

  it('default-no: ignores other keys without invoking onConfirm', async () => {
    const confirm = vi.fn(async () => {})
    const view = new ConfirmView({ message: '?', onConfirm: confirm })
    for (const k of ['enter', 'space', 'a', 'tab'] as const) {
      await view.onKey(k, { app: fakeApp(), size: { rows: 10, cols: 80 }, status: '' })
    }
    expect(confirm).not.toHaveBeenCalled()
  })

  it('isTextEntry suppresses global q', () => {
    const view = new ConfirmView({ message: '?', onConfirm: vi.fn() })
    expect(view.isTextEntry).toBe(true)
  })
})
