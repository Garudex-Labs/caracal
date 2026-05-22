// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Keyboard input parser: maps raw stdin bytes to named keys.

export type Key =
  | 'up' | 'down' | 'left' | 'right'
  | 'enter' | 'esc' | 'space' | 'tab' | 'backspace'
  | 'pgup' | 'pgdn' | 'home' | 'end'
  | string

export function parseKey(seq: string): Key {
  if (seq === '\r' || seq === '\n') return 'enter'
  if (seq === '\u001b') return 'esc'
  if (seq === '\u001b[A') return 'up'
  if (seq === '\u001b[B') return 'down'
  if (seq === '\u001b[C') return 'right'
  if (seq === '\u001b[D') return 'left'
  if (seq === '\u001b[5~') return 'pgup'
  if (seq === '\u001b[6~') return 'pgdn'
  if (seq === '\u001b[H' || seq === '\u001b[1~') return 'home'
  if (seq === '\u001b[F' || seq === '\u001b[4~') return 'end'
  if (seq === ' ') return 'space'
  if (seq === '\t') return 'tab'
  if (seq === '\u007f' || seq === '\b') return 'backspace'
  if (seq === '\u0003') return 'ctrl-c'
  return seq
}
