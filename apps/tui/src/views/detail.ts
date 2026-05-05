// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JSON detail view: pretty-printed scrollable inspection of a single record.

import { ansi } from '../ansi.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'

export interface DetailOptions {
  title: string
  load: () => Promise<unknown>
}

export class DetailView implements View {
  readonly title: string
  private readonly loader: () => Promise<unknown>
  private body: string[] = [' loading…']
  private offset = 0
  private loading = true
  private error: string | undefined

  constructor(opts: DetailOptions) {
    this.title = opts.title
    this.loader = opts.load
  }

  hints(): string[] { return ['↑/↓:scroll', 'r:reload', 'h:back'] }

  async init(app: App): Promise<void> {
    await this.reload(app)
  }

  async reload(app: App): Promise<void> {
    this.loading = true
    this.error = undefined
    this.body = [' loading…']
    app.invalidate()
    try {
      const data = await this.loader()
      this.body = JSON.stringify(data, null, 2).split('\n')
      this.offset = 0
    } catch (err) {
      this.error = explainError(err)
    } finally {
      this.loading = false
      app.invalidate()
    }
  }

  render(ctx: ViewContext): string[] {
    if (this.loading) return [ansi.dim + ' loading…' + ansi.reset]
    if (this.error) return [ansi.fg(196) + ' error: ' + this.error + ansi.reset]
    const lines: string[] = []
    for (let i = this.offset; i < Math.min(this.body.length, this.offset + ctx.size.rows); i++) {
      lines.push(' ' + this.body[i])
    }
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const max = Math.max(0, this.body.length - ctx.size.rows + 1)
    if (key === 'up' || key === 'k') { this.offset = Math.max(0, this.offset - 1); return }
    if (key === 'down' || key === 'j') { this.offset = Math.min(max, this.offset + 1); return }
    if (key === 'pgup') { this.offset = Math.max(0, this.offset - 10); return }
    if (key === 'pgdn') { this.offset = Math.min(max, this.offset + 10); return }
    if (key === 'home' || key === 'g') { this.offset = 0; return }
    if (key === 'end' || key === 'G') { this.offset = max; return }
    if (key === 'r') return this.reload(ctx.app)
    if (key === 'left' || key === 'h' || key === 'esc') ctx.app.pop()
  }
}
