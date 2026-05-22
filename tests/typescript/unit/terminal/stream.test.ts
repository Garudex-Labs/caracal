// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// StreamView line buffering, ANSI scrubbing, and dispose-handle tests.

import { describe, it, expect, vi } from 'vitest'
import { StreamView } from '../../../../apps/tui/src/views/stream.ts'
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

describe('StreamView', () => {
  it('buffers lines and renders the tail', async () => {
    let push: ((l: string) => void) | undefined
    const view = new StreamView({
      title: 'x',
      spawn: (onLine) => {
        push = onLine
        return { dispose: vi.fn(), exitCode: new Promise(() => {}) }
      },
    })
    const app = fakeApp()
    await view.init(app)
    push!('line1')
    push!('line2')
    const lines = view.render({ app, size: { rows: 5, cols: 80 }, status: '' }).join('\n')
    expect(lines).toContain('line1')
    expect(lines).toContain('line2')
  })

  it('strips ANSI escapes from incoming lines', async () => {
    let push: ((l: string) => void) | undefined
    const view = new StreamView({
      title: 'x',
      spawn: (onLine) => {
        push = onLine
        return { dispose: vi.fn(), exitCode: new Promise(() => {}) }
      },
    })
    const app = fakeApp()
    await view.init(app)
    push!('hi\u001b[2Joops')
    const buf = (view as unknown as { buf: string[] }).buf.join('\n')
    expect(buf).not.toContain('\u001b')
    expect(buf).toContain('oops')
  })

  it('dispose calls the underlying handle dispose', async () => {
    const dispose = vi.fn()
    const view = new StreamView({
      title: 'x',
      spawn: () => ({ dispose, exitCode: new Promise(() => {}) }),
    })
    await view.init(fakeApp())
    view.dispose()
    expect(dispose).toHaveBeenCalled()
  })
})
