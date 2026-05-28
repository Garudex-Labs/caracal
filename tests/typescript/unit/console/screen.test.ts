// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ANSI helpers and key parser unit tests.

import { describe, it, expect, vi } from 'vitest'
import { visibleLength, pad, sanitizeAnsi, truncate } from '../../../../apps/console/src/ansi.ts'
import { actions, composeActions, renderActionFooter } from '../../../../apps/console/src/actions.ts'
import { formatDateTime, formatDateTimeOrValue } from '../../../../apps/console/src/format.ts'
import { parseKey } from '../../../../apps/console/src/keys.ts'
import { App, type View } from '../../../../apps/console/src/screen.ts'

describe('ansi visibleLength', () => {
  it('counts only printable characters, ignoring SGR escapes', () => {
    expect(visibleLength('hello')).toBe(5)
    expect(visibleLength('\u001b[1mbold\u001b[0m')).toBe(4)
    expect(visibleLength('\u001b[38;5;76mgreen\u001b[0m text')).toBe(10)
  })
})

describe('ansi pad', () => {
  it('right-pads to the requested visible width', () => {
    expect(pad('a', 4)).toBe('a   ')
    expect(pad('\u001b[1mab\u001b[0m', 4)).toBe('\u001b[1mab\u001b[0m  ')
  })

  it('returns the original string when already wide enough', () => {
    expect(pad('hello', 3)).toBe('hello')
  })
})

describe('ansi truncate', () => {
  it('appends an ellipsis when content exceeds width', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
  })

  it('preserves SGR escape codes inside the truncated region', () => {
    const out = truncate('\u001b[1mabcdef\u001b[0m', 4)
    expect(out.startsWith('\u001b[1m')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
    expect(visibleLength(out)).toBe(4)
  })

  it('passes through short strings unchanged', () => {
    expect(truncate('ab', 5)).toBe('ab')
  })
})

describe('ansi sanitizeAnsi', () => {
  it('strips ESC and other C0/C1 control bytes from untrusted strings', () => {
    expect(sanitizeAnsi('hi\u001b[2Joops')).toBe('hi[2Joops')
    expect(sanitizeAnsi('a\u0007b\u0008c\u007fd')).toBe('abcd')
    expect(sanitizeAnsi('preserve tabs\tand\nnewlines')).toBe('preserve tabs\tand\nnewlines')
  })

  it('neutralizes a malicious title-set sequence sourced from API data', () => {
    const evil = '\u001b]0;hijacked\u0007legit'
    const out = sanitizeAnsi(evil)
    expect(out.includes('\u001b')).toBe(false)
    expect(out.includes('\u0007')).toBe(false)
    expect(out).toContain('legit')
  })
})

describe('action footer', () => {
  it('groups actions and drops utility commands first under narrow widths', () => {
    const footer = renderActionFooter(composeActions([
      actions.open,
      actions.new,
      actions.edit,
      actions.delete,
      actions.reload,
      actions.info,
      actions.copyName,
      actions.revealId,
      actions.back,
      actions.quit,
    ], { selection: 'single' }), { width: 72 })
    const plain = stripSgr(footer)

    expect(plain).toContain('enter  open')
    expect(plain).toContain('n  new')
    expect(plain).toContain('|')
    expect(plain).not.toContain('copy-name')
    expect(visibleLength(footer)).toBeLessThanOrEqual(72)
  })
})

describe('datetime formatting', () => {
  it('renders ISO timestamps as readable UTC values with source labels', () => {
    expect(formatDateTime('2026-05-28T04:48:55.460Z')).toBe('28 May 2026, 04:48:55 UTC (ISO 8601)')
  })

  it('uses compact readable timestamps for narrow table columns', () => {
    expect(formatDateTimeOrValue('2026-05-28T04:48:55.460Z', { compact: true })).toBe('28 May, 04:48 UTC (ISO)')
  })

  it('preserves explicit timezone offsets', () => {
    expect(formatDateTime('2026-05-28T10:18:55+05:30')).toBe('28 May 2026, 10:18:55 UTC+05:30 (ISO 8601)')
  })
})

describe('parseKey', () => {
  it('decodes arrow keys', () => {
    expect(parseKey('\u001b[A')).toBe('up')
    expect(parseKey('\u001b[B')).toBe('down')
    expect(parseKey('\u001b[C')).toBe('right')
    expect(parseKey('\u001b[D')).toBe('left')
  })

  it('decodes navigation keys', () => {
    expect(parseKey('\u001b[5~')).toBe('pgup')
    expect(parseKey('\u001b[6~')).toBe('pgdn')
    expect(parseKey('\u001b[H')).toBe('home')
    expect(parseKey('\u001b[F')).toBe('end')
  })

  it('decodes Enter, Esc, Tab, Backspace, Ctrl-C', () => {
    expect(parseKey('\r')).toBe('enter')
    expect(parseKey('\n')).toBe('enter')
    expect(parseKey('\u001b')).toBe('esc')
    expect(parseKey('\t')).toBe('tab')
    expect(parseKey('\u007f')).toBe('backspace')
    expect(parseKey('\u0003')).toBe('ctrl-c')
  })

  it('passes through plain characters', () => {
    expect(parseKey('q')).toBe('q')
    expect(parseKey('z')).toBe('z')
  })
})

describe('App key dispatch', () => {
  function makeView(isTextEntry: boolean): { view: View; seen: string[] } {
    const seen: string[] = []
    return {
      seen,
      view: {
        title: 't',
        isTextEntry,
        hints: () => [],
        render: () => [],
        onKey: (key: string) => { seen.push(key) },
      } as View,
    }
  }

  it('omits breadcrumb text for the root view', () => {
    const app = new App('', '')
    const { view } = makeView(false)
    view.title = 'menu'
    ;(app as unknown as { stack: View[] }).stack = [view]

    const line = (app as unknown as { titleLine(sz: { rows: number; cols: number }): string }).titleLine({ rows: 10, cols: 20 })

    expect(line).toBe(' '.repeat(20))
  })

  it('shows breadcrumbs after opening a child view', () => {
    const app = new App('', '')
    const parent = makeView(false).view
    const child = makeView(false).view
    parent.title = 'menu'
    child.title = 'zones'
    ;(app as unknown as { stack: View[] }).stack = [parent, child]

    const line = (app as unknown as { titleLine(sz: { rows: number; cols: number }): string }).titleLine({ rows: 10, cols: 40 })

    expect(line).toContain('menu')
    expect(line).toContain('zones')
    expect(visibleLength(line.trimEnd())).toBe(' menu / zones'.length)
  })

  it('routes q to exit when current view is not text-entry', async () => {
    const app = new App('', '')
    const exit = vi.spyOn(app, 'exit').mockImplementation(async () => {})
    const { view, seen } = makeView(false)
    ;(app as unknown as { stack: View[] }).stack = [view]
    await (app as unknown as { dispatchKey(k: string): Promise<void> }).dispatchKey('q')
    expect(exit).toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('forwards q to the view when isTextEntry is true', async () => {
    const app = new App('', '')
    const exit = vi.spyOn(app, 'exit').mockImplementation(async () => {})
    const { view, seen } = makeView(true)
    ;(app as unknown as { stack: View[] }).stack = [view]
    await (app as unknown as { dispatchKey(k: string): Promise<void> }).dispatchKey('q')
    expect(exit).not.toHaveBeenCalled()
    expect(seen).toEqual(['q'])
  })
})

function stripSgr(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}
