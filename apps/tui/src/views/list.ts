// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Generic scrollable list view with column rendering and selection.

import { ansi, pad, truncate } from '../ansi.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'

export interface Column<T> {
  header: string
  width?: number
  value: (row: T) => string
}

export interface ListOptions<T> {
  title: string
  columns: Column<T>[]
  load: () => Promise<T[]>
  onEnter?: (app: App, row: T) => void | Promise<void>
}

export class ListView<T> implements View {
  readonly title: string
  private readonly columns: Column<T>[]
  private readonly loader: () => Promise<T[]>
  private readonly enter?: (app: App, row: T) => void | Promise<void>
  private rows: T[] = []
  private cursor = 0
  private offset = 0
  private loading = true
  private error: string | undefined
  private aborted = false

  constructor(opts: ListOptions<T>) {
    this.title = opts.title
    this.columns = opts.columns
    this.loader = opts.load
    this.enter = opts.onEnter
  }

  selected(): T | undefined { return this.rows[this.cursor] }

  hints(): string[] {
    return ['↑/↓:move', 'enter:open', 'r:reload', 'h:back']
  }

  async init(app: App): Promise<void> { await this.reload(app) }

  dispose(): void { this.aborted = true }

  async reload(app: App): Promise<void> {
    this.loading = true
    this.error = undefined
    app.invalidate()
    try {
      const rows = await this.loader()
      if (this.aborted) return
      this.rows = rows
      this.cursor = Math.min(this.cursor, Math.max(0, rows.length - 1))
    } catch (err) {
      if (this.aborted) return
      this.error = explainError(err)
    } finally {
      if (!this.aborted) {
        this.loading = false
        app.invalidate()
      }
    }
  }

  render(ctx: ViewContext): string[] {
    const lines: string[] = []
    if (this.loading) { lines.push(ansi.dim + ' loading…' + ansi.reset); return lines }
    if (this.error) { lines.push(ansi.fg(196) + ' error: ' + this.error + ansi.reset); return lines }
    if (this.rows.length === 0) { lines.push(ansi.dim + ' (no rows)' + ansi.reset); return lines }
    const widths = this.computeWidths(ctx.size.cols)
    lines.push(this.headerRow(widths))
    const visible = Math.max(1, ctx.size.rows - 1)
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(this.rows.length, this.offset + visible); i++) {
      const row = this.rows[i]!
      const text = this.columns
        .map((c, idx) => pad(truncate(c.value(row), widths[idx]!), widths[idx]!))
        .join('  ')
      lines.push(i === this.cursor ? ansi.invert + ' ' + text + ' ' + ansi.reset : ' ' + text + ' ')
    }
    return lines
  }

  private computeWidths(cols: number): number[] {
    const total = this.columns.reduce((sum, c) => sum + (c.width ?? 16) + 2, 0) - 2
    if (total <= cols - 4) return this.columns.map((c) => c.width ?? 16)
    const last = this.columns.length - 1
    const fixed = this.columns.slice(0, -1).reduce((s, c) => s + (c.width ?? 16) + 2, 0)
    const remaining = Math.max(8, cols - 4 - fixed)
    return this.columns.map((c, i) => (i === last ? remaining : (c.width ?? 16)))
  }

  private headerRow(widths: number[]): string {
    const text = this.columns.map((c, i) => pad(c.header, widths[i]!)).join('  ')
    return ansi.bold + ' ' + text + ansi.reset
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(this.rows.length - 1, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(this.rows.length - 1, this.cursor + 10); return }
    if (key === 'home' || key === 'g') { this.cursor = 0; return }
    if (key === 'end' || key === 'G') { this.cursor = this.rows.length - 1; return }
    if (key === 'r') return this.reload(ctx.app)
    if (key === 'left' || key === 'h' || key === 'esc') { ctx.app.pop(); return }
    if (key === 'enter') {
      const row = this.selected()
      if (row && this.enter) await this.enter(ctx.app, row)
    }
  }
}
