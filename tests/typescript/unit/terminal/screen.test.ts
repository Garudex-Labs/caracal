// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ANSI helpers and key parser unit tests.

import { describe, it, expect, vi } from 'vitest'
import { visibleLength, pad, sanitizeAnsi, truncate } from '../../../../apps/tui/src/ansi.ts'
import { parseKey } from '../../../../apps/tui/src/keys.ts'
import { App, type View } from '../../../../apps/tui/src/screen.ts'

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
