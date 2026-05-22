// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Screen and App: alt-buffer rendering, key dispatch, and view stack management.

import { ansi, frame, hintText, pad, size, truncate, ui, visibleLength, type Size } from './ansi.ts'
import { explainError } from './errors.ts'
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
  readonly isTextEntry?: boolean
}

export class App {
  private stack: View[] = []
  private status = ''
  private statusKind: 'info' | 'error' = 'info'
  private rendering = false
  private dirty = true
  private exiting = false
  private renderTimer: NodeJS.Timeout | undefined
  private exitHandlerInstalled = false
  readonly bannerLeft: string
  private bannerRightFn: () => string

  constructor(bannerLeft: string, bannerRight: string | (() => string)) {
    this.bannerLeft = bannerLeft
    this.bannerRightFn = typeof bannerRight === 'function' ? bannerRight : () => bannerRight
  }

  // Synchronous best-effort terminal restoration registered on process 'exit'
  // so the user is never stranded in raw mode + alt buffer if any path skips
  // the async exit() (uncaught throws, top-level rejections, fatal sync code).
  private installSynchronousExitGuard(): void {
    if (this.exitHandlerInstalled) return
    this.exitHandlerInstalled = true
    process.once('exit', () => {
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch { /* ignore */ }
      try { process.stdout.write(ansi.exitAlt + ansi.reset) } catch { /* ignore */ }
    })
  }

  get bannerRight(): string { return this.bannerRightFn() }

  setBannerRight(fn: () => string): void {
    this.bannerRightFn = fn
    this.dirty = true
  }

  push(view: View): void {
    this.stack.push(view)
    this.dirty = true
    if (view.init) {
      Promise.resolve(view.init(this)).catch((err) => this.setStatus(`init: ${explainError(err)}`, 'error'))
    }
  }

  pop(): void {
    if (this.stack.length > 1) {
      const view = this.stack.pop()!
      try { view.dispose?.() } catch { /* ignore dispose errors */ }
      this.status = ''
      this.dirty = true
    } else {
      void this.exit()
    }
  }

  replaceTop(view: View): void {
    const old = this.stack.pop()
    try { old?.dispose?.() } catch { /* ignore */ }
    this.stack.push(view)
    this.dirty = true
    if (view.init) {
      Promise.resolve(view.init(this)).catch((err) => this.setStatus(`init: ${explainError(err)}`, 'error'))
    }
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
    if (this.exiting) return
    this.exiting = true
    if (this.renderTimer) { clearInterval(this.renderTimer); this.renderTimer = undefined }
    while (this.stack.length > 0) {
      const v = this.stack.pop()!
      try { v.dispose?.() } catch { /* ignore */ }
    }
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false) } catch { /* ignore */ }
    }
    process.stdin.pause()
    await new Promise<void>((resolve) => {
      process.stdout.write(ansi.exitAlt + ansi.reset, () => resolve())
    })
    process.exit(code)
  }

  private renderFrame(): void {
    if (this.rendering || this.exiting) return
    this.rendering = true
    try {
      const sz = size()
      const view = this.current()
      const lines: string[] = []
      const bodyHeight = Math.max(1, sz.rows - 6)
      const bodyWidth = Math.max(20, sz.cols - 4)
      const body = view.render({ app: this, size: { rows: bodyHeight, cols: bodyWidth }, status: this.status })
      lines.push(this.bannerLine(sz))
      lines.push(this.titleLine(sz))
      const bodyLines: string[] = []
      for (let i = 0; i < bodyHeight; i++) {
        const raw = body[i] ?? ''
        bodyLines.push(raw)
      }
      lines.push(...frame(view.title, bodyLines, sz.cols))
      lines.push(this.statusLine(sz))
      lines.push(this.hintsLine(view, sz))
      process.stdout.write(ansi.home + lines.join('\r\n'))
    } finally {
      this.rendering = false
    }
  }

  private bannerLine(sz: Size): string {
    const bg = ansi.bg(55)
    const left = ` ${ansi.bold}${this.bannerLeft}${ansi.reset}${bg} `
    const right = ` ${ansi.fg(225)}${this.bannerRight}${ansi.reset}${bg} `
    const middle = Math.max(0, sz.cols - visibleLength(left) - visibleLength(right))
    return bg + left + ' '.repeat(middle) + right + ansi.reset
  }

  private titleLine(sz: Size): string {
    const crumbs = this.stack.map((v, i) => i === this.stack.length - 1 ? ui.accent(v.title) : ui.muted(v.title)).join(ui.muted(' / '))
    return pad(truncate(' ' + crumbs, sz.cols), sz.cols)
  }

  private statusLine(sz: Size): string {
    if (!this.status) return pad(ui.muted(' ready'), sz.cols)
    const color = this.statusKind === 'error' ? ui.error : ui.info
    return color(pad(truncate(' ' + this.status, sz.cols), sz.cols))
  }

  private hintsLine(view: View, sz: Size): string {
    const hints = view.hints().concat(['q:quit'])
    const text = ' ' + hints.map(hintText).join('  ')
    return pad(truncate(text, sz.cols), sz.cols)
  }

  private async dispatchKey(key: Key): Promise<void> {
    if (key === 'ctrl-c') return this.exit()
    if (key === 'q' && !this.current().isTextEntry) return this.exit()
    await this.current().onKey(key, { app: this, size: size(), status: this.status })
  }

  async run(initial: View): Promise<void> {
    this.installSynchronousExitGuard()
    this.stack.push(initial)
    process.stdout.write(ansi.enterAlt + ansi.clear)
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    if (initial.init) {
      try { await initial.init(this) } catch (err) { this.setStatus(`init: ${explainError(err)}`, 'error') }
    }

    process.on('SIGWINCH', () => { this.dirty = true })
    process.on('SIGTERM', () => { void this.exit(0) })
    process.on('SIGHUP', () => { void this.exit(0) })
    process.on('uncaughtException', (err) => {
      this.setStatus(`fatal: ${explainError(err)}`, 'error')
      void this.exit(1)
    })
    process.on('unhandledRejection', (reason) => {
      this.setStatus(`fatal: ${explainError(reason)}`, 'error')
      void this.exit(1)
    })

    this.renderTimer = setInterval(() => {
      if (this.dirty) {
        this.dirty = false
        this.renderFrame()
      }
    }, 30)
    this.renderTimer.unref?.()

    process.stdin.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const key = parseKey(text)
      this.dispatchKey(key)
        .then(() => { this.dirty = true })
        .catch((err) => { this.setStatus(`error: ${explainError(err)}`, 'error') })
    })

    this.renderFrame()
    await new Promise<void>(() => { /* loop forever; exit() terminates */ })
  }
}
