// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ANSI escape sequences and a minimal screen abstraction for the TUI.

const ESC = '\u001b['

export const ansi = {
  enterAlt: `${ESC}?1049h${ESC}?25l`,
  exitAlt: `${ESC}?25h${ESC}?1049l`,
  clear: `${ESC}2J${ESC}H`,
  home: `${ESC}H`,
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  invert: `${ESC}7m`,
  fg(c: number): string { return `${ESC}38;5;${c}m` },
  bg(c: number): string { return `${ESC}48;5;${c}m` },
  move(row: number, col: number): string { return `${ESC}${row};${col}H` },
  clearLine: `${ESC}2K`,
}

export const ui = {
  accent: (s: string): string => ansi.fg(201) + s + ansi.reset,
  accentSoft: (s: string): string => ansi.fg(141) + s + ansi.reset,
  success: (s: string): string => ansi.fg(76) + s + ansi.reset,
  warn: (s: string): string => ansi.fg(214) + s + ansi.reset,
  error: (s: string): string => ansi.fg(196) + s + ansi.reset,
  info: (s: string): string => ansi.fg(44) + s + ansi.reset,
  muted: (s: string): string => ansi.fg(244) + s + ansi.reset,
  title: (s: string): string => ansi.bold + s + ansi.reset,
  selected: (s: string): string => ansi.bg(55) + ansi.fg(255) + s + ansi.reset,
  key: (s: string): string => ansi.bg(55) + ansi.fg(255) + ` ${s} ` + ansi.reset,
  border: (s: string): string => ansi.fg(238) + s + ansi.reset,
  input: (s: string): string => ansi.fg(225) + s + ansi.reset,
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g
// C0 (excluding TAB/LF) and DEL plus C1 control bytes; ESC drives every
// terminal escape sequence so stripping it neuters the entire family.
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

export function visibleLength(s: string): number {
  return s.replace(ANSI_PATTERN, '').length
}

export function sanitizeAnsi(s: string): string {
  return s.replace(CONTROL_PATTERN, '')
}

export function pad(s: string, width: number): string {
  const len = visibleLength(s)
  if (len >= width) return s
  return s + ' '.repeat(width - len)
}

export function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s
  if (width <= 1) return s.slice(0, width)
  let out = ''
  let count = 0
  let i = 0
  while (i < s.length && count < width - 1) {
    if (s[i] === '\u001b') {
      const m = s.slice(i).match(/^\u001b\[[0-9;?]*[A-Za-z]/)
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    out += s[i]
    count++
    i++
  }
  return out + '…'
}

export function frame(title: string, body: readonly string[], cols: number): string[] {
  const width = Math.max(20, cols)
  const inner = Math.max(1, width - 4)
  const safeTitle = title.length > 0 ? ` ${title} ` : ''
  const topFill = Math.max(0, inner - visibleLength(safeTitle))
  const top = ui.border('+-') + ui.accent(truncate(safeTitle, inner)) + ui.border('-'.repeat(topFill) + '-+')
  const bottom = ui.border('+' + '-'.repeat(width - 2) + '+')
  const lines = [top]
  for (const raw of body) {
    lines.push(ui.border('| ') + pad(truncate(raw, inner), inner) + ui.border(' |'))
  }
  lines.push(bottom)
  return lines
}

export function hintText(hint: string): string {
  const idx = hint.indexOf(':')
  if (idx <= 0) return ui.muted(hint)
  return ui.key(hint.slice(0, idx)) + ui.muted(hint.slice(idx))
}

export interface Size {
  rows: number
  cols: number
}

export function size(): Size {
  return {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  }
}
