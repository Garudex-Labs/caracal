// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// DetailView mask hook hides tokens by default and reveals with v.

import { describe, it, expect, vi } from 'vitest'
import { DetailView } from '../../../../apps/tui/src/views/detail.ts'
import type { App } from '../../../../apps/tui/src/screen.ts'

function fakeApp(): App {
  return {
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
}

describe('DetailView mask hook', () => {
  it('masks fields by default and reveals with v', async () => {
    const app = fakeApp()
    const view = new DetailView({
      title: 'cred',
      load: async () => ({ resource: 'r', access_token: 'real-token' }),
      mask: (_v, path) => path[path.length - 1] === 'access_token' ? '••••' : undefined,
    })
    await view.init(app)
    let out = view.render({ app, size: { rows: 20, cols: 80 }, status: '' }).join('\n')
    expect(out).toContain('••••')
    expect(out).not.toContain('real-token')
    await view.onKey('v', { app, size: { rows: 20, cols: 80 }, status: '' })
    out = view.render({ app, size: { rows: 20, cols: 80 }, status: '' }).join('\n')
    expect(out).toContain('real-token')
  })
})
