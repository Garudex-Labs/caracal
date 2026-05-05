// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Screen and App: alt-buffer rendering, key dispatch, and view stack management.

import { ansi, pad, size, truncate, visibleLength, type Size } from './ansi.ts'
import { parseKey, type Key } from './keys.ts'

export interface ViewContext {
  app: App
  size: Size
  status: string
}

export interface View {
  title: string
  hints(): string[]
  render(ctx: ViewContext): string[]
  onKey(key: Key, ctx: ViewContext): void | Promise<void>
  init?(app: App): void | Promise<void>
  dispose?(): void
}

export class App {
  private stack: View[] = []
  private status = ''
  private statusKind: 'info' | 'error' = 'info'
  private rendering = false
  private dirty = true
  readonly bannerLeft: string
  readonly bannerRight: string

  constructor(bannerLeft: string, bannerRight: string) {
    this.bannerLeft = bannerLeft
    this.bannerRight = bannerRight
  }

  push(view: View): void {
    this.stack.push(view)
    this.dirty = true
    if (view.init) Promise.resolve(view.init(this)).catch((err) => this.setStatus(`init: ${err?.message ?? err}`, 'error'))
  }

  pop(): void {
    if (this.stack.length > 1) {
      const view = this.stack.pop()!
      view.dispose?.()
      this.dirty = true
    } else {
      this.exit()
    }
  }

  replaceTop(view: View): void {
    const old = this.stack.pop()
    old?.dispose?.()
    this.stack.push(view)
    this.dirty = true
    if (view.init) Promise.resolve(view.init(this)).catch((err) => this.setStatus(`init: ${err?.message ?? err}`, 'error'))
  }

  current(): View {
    return this.stack[this.stack.length - 1]!
  }

  setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    this.status = text
    this.statusKind = kind
    this.dirty = true
  }

  invalidate(): void { this.dirty = true }

  async exit(code = 0): Promise<void> {
    process.stdout.write(ansi.exitAlt + ansi.reset)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.exit(code)
  }

  private renderFrame(): void {
    if (this.rendering) return
    this.rendering = true
    try {
      const sz = size()
      const view = this.current()
      const lines: string[] = []
      lines.push(this.bannerLine(sz))
      lines.push(this.titleLine(view, sz))
      const bodyHeight = Math.max(1, sz.rows - 4)
      const body = view.render({ app: this, size: { rows: bodyHeight, cols: sz.cols }, status: this.status })
      for (let i = 0; i < bodyHeight; i++) {
        const raw = body[i] ?? ''
        lines.push(pad(truncate(raw, sz.cols), sz.cols))
      }
      lines.push(this.statusLine(sz))
      lines.push(this.hintsLine(view, sz))
      process.stdout.write(ansi.home + lines.join('\n'))
    } finally {
      this.rendering = false
    }
  }

  private bannerLine(sz: Size): string {
    const left = ` ${this.bannerLeft} `
    const right = ` ${this.bannerRight} `
    const middle = Math.max(0, sz.cols - visibleLength(left) - visibleLength(right))
    return ansi.invert + left + ' '.repeat(middle) + right + ansi.reset
  }

  private titleLine(view: View, sz: Size): string {
    const crumbs = this.stack.map((v) => v.title).join(' › ')
    return ansi.bold + pad(truncate(' ' + crumbs, sz.cols), sz.cols) + ansi.reset
  }

  private statusLine(sz: Size): string {
    if (!this.status) return pad('', sz.cols)
    const color = this.statusKind === 'error' ? ansi.fg(196) : ansi.fg(244)
    return color + pad(truncate(' ' + this.status, sz.cols), sz.cols) + ansi.reset
  }

  private hintsLine(view: View, sz: Size): string {
    const hints = view.hints().concat(['?:help', 'q:quit'])
    const text = ' ' + hints.join('  ')
    return ansi.invert + pad(truncate(text, sz.cols), sz.cols) + ansi.reset
  }

  private async dispatchKey(key: Key): Promise<void> {
    if (key === 'ctrl-c' || key === 'q') return this.exit()
    await this.current().onKey(key, { app: this, size: size(), status: this.status })
  }

  async run(initial: View): Promise<void> {
    this.stack.push(initial)
    process.stdout.write(ansi.enterAlt + ansi.clear)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    if (initial.init) {
      try { await initial.init(this) } catch (err) { this.setStatus(`init: ${(err as Error)?.message ?? err}`, 'error') }
    }

    process.on('SIGWINCH', () => { this.dirty = true })
    process.on('exit', () => { process.stdout.write(ansi.exitAlt + ansi.reset) })

    const tick = setInterval(() => {
      if (this.dirty) {
        this.dirty = false
        this.renderFrame()
      }
    }, 30)
    tick.unref?.()

    process.stdin.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const key = parseKey(text)
      this.dispatchKey(key).then(() => { this.dirty = true }).catch((err) => {
        this.setStatus(`error: ${err?.message ?? err}`, 'error')
      })
    })

    this.renderFrame()
    await new Promise<void>(() => { /* loop forever; exit() terminates */ })
  }
}
