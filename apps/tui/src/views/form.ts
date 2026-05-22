// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interactive form, confirm, and file picker views for TUI mutations.

import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ansi, pad, sanitizeAnsi, truncate, ui } from '../ansi.ts'
import { scrubTokens } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'

type FieldKind = 'text' | 'multiline' | 'secret' | 'bool' | 'list' | 'file' | 'select'

export interface Field {
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  default?: string
  options?: string[]
  validate?: (v: string) => string | undefined
  hint?: string
  pick?: (app: App, setValue: (value: string) => void, currentValue: string) => void | Promise<void>
}

export interface FormOpts {
  title: string
  fields: Field[]
  submitLabel?: string
  onSubmit: (vals: Record<string, string>, app: App) => Promise<void>
  onCancel?: (app: App) => void
}

const BRACKETED_PASTE_PATTERN = /\u001b\[(?:200|201)~/g
const ANSI_SEQUENCE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z~]/g
const NAMED_KEYS = new Set([
  'up',
  'down',
  'left',
  'right',
  'enter',
  'esc',
  'tab',
  'backspace',
  'pgup',
  'pgdn',
  'home',
  'end',
  'ctrl-c',
])

export class FormView implements View {
  readonly title: string
  readonly isTextEntry = true
  readonly abort = new AbortController()
  private readonly fields: Field[]
  private readonly submitLabel: string
  private readonly submit: FormOpts['onSubmit']
  private readonly cancel?: FormOpts['onCancel']
  private values: Record<string, string>
  private focus = 0
  private revealed = new Set<string>()
  private multilineMode = false
  private submitting = false

  constructor(opts: FormOpts) {
    this.title = opts.title
    this.fields = opts.fields
    this.submitLabel = opts.submitLabel ?? 'submit'
    this.submit = opts.onSubmit
    this.cancel = opts.onCancel
    this.values = Object.fromEntries(opts.fields.map((f) => [f.key, f.default ?? '']))
  }

  hints(): string[] {
    if (this.multilineMode) return ['esc:done', 'enter:newline']
    const base = ['tab/j/k:next', 'enter:advance/submit', 'esc:cancel', 'ctrl-o:file', 'ctrl-r:reveal']
    if (this.fields[this.focus]?.pick) base.push('ctrl-p:pick')
    return base
  }

  dispose(): void { this.abort.abort() }

  values_(): Record<string, string> { return this.values }

  render(ctx: ViewContext): string[] {
    const lines: string[] = ['']
    lines.push(' ' + ui.title(this.title))
    lines.push(' ' + ui.muted('Type or paste into fields. Required fields are marked *.'))
    lines.push('')
    for (let i = 0; i < this.fields.length; i++) {
      const f = this.fields[i]!
      const focused = i === this.focus
      const display = this.displayValue(f)
      const label = pad(f.required ? `${f.label} *` : f.label, 18)
      const cursorMark = focused ? (this.multilineMode ? '* ' : '> ') : '  '
      const text = focused
        ? ` ${ui.accent(cursorMark)}${ui.muted(label)}${display}`
        : ` ${cursorMark}${ui.muted(label)}${display}`
      const styled = truncate(text, ctx.size.cols)
      lines.push(styled)
      if (focused) {
        const hints = [f.hint, f.pick ? 'ctrl-p opens a picker' : undefined].filter((hint): hint is string => Boolean(hint))
        if (hints.length > 0) lines.push('   ' + ui.muted('hint: ' + hints.join(' · ')))
      }
    }
    lines.push('')
    const submitMark = this.focus === this.fields.length ? ansi.invert : ''
    const reset = this.focus === this.fields.length ? ansi.reset : ''
    lines.push(' ' + submitMark + ` [${this.submitLabel}] ` + reset)
    if (this.submitting) lines.push(' ' + ui.muted('submitting...'))
    return lines
  }

  private displayValue(f: Field): string {
    const raw = this.values[f.key] ?? ''
    if (f.kind === 'bool') return raw === 'true' ? '[x]' : '[ ]'
    if (f.kind === 'select') return ui.input(`[ ${sanitizeAnsi(raw || '<choose>')} ]`)
    if (f.kind === 'secret') {
      const shown = this.revealed.has(f.key) ? sanitizeAnsi(raw) : raw.length === 0 ? '' : '••••'
      return ui.input(`[ ${shown || `<${f.label}>`} ]`)
    }
    const shown = f.kind === 'multiline'
      ? sanitizeAnsi(raw.replace(/\n/g, ' ⏎ '))
      : sanitizeAnsi(raw)
    return ui.input(`[ ${shown || `<${f.label}>`} ]`)
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (this.submitting) return
    const f = this.fields[this.focus]
    if (this.multilineMode && f) {
      if (key === 'esc') { this.multilineMode = false; return }
      if (key === 'enter') { this.values[f.key] = (this.values[f.key] ?? '') + '\n'; return }
      if (key === 'backspace') {
        this.values[f.key] = (this.values[f.key] ?? '').slice(0, -1)
        return
      }
      const text = textInput(key, true)
      if (text !== undefined) {
        this.values[f.key] = (this.values[f.key] ?? '') + text
      }
      return
    }
    if (key === 'esc') {
      this.cancel?.(ctx.app)
      ctx.app.pop()
      return
    }
    if (key === '\u0012') { // ctrl-r reveals current secret
      if (f && f.kind === 'secret') {
        if (this.revealed.has(f.key)) this.revealed.delete(f.key)
        else this.revealed.add(f.key)
      }
      return
    }
    if (key === '\u000f') { // ctrl-o opens file picker
      if (f && f.kind === 'file') {
        ctx.app.push(new FilePickerView(process.cwd(), (path) => {
          this.values[f.key] = path
        }))
      }
      return
    }
    if (key === '\u0010') {
      if (f?.pick) {
        await f.pick(ctx.app, (value) => {
          this.values[f.key] = value
        }, this.values[f.key] ?? '')
      }
      return
    }
    if (key === 'tab' || key === 'down' || key === 'j' && this.notTyping(f)) {
      this.focus = Math.min(this.fields.length, this.focus + 1)
      return
    }
    if (key === 'up' || key === 'k' && this.notTyping(f)) {
      this.focus = Math.max(0, this.focus - 1)
      return
    }
    if (key === 'enter') {
      if (this.focus === this.fields.length) return this.trySubmit(ctx.app)
      if (f && f.kind === 'bool') {
        this.values[f.key] = this.values[f.key] === 'true' ? 'false' : 'true'
        return
      }
      if (f && f.kind === 'select') {
        const opts = f.options ?? []
        if (opts.length === 0) { this.focus++; return }
        const cur = opts.indexOf(this.values[f.key] ?? '')
        this.values[f.key] = opts[(cur + 1) % opts.length]!
        return
      }
      if (this.focus === this.fields.length - 1) return this.trySubmit(ctx.app)
      this.focus++
      return
    }
    if (key === 'space' && f && f.kind === 'bool') {
      this.values[f.key] = this.values[f.key] === 'true' ? 'false' : 'true'
      return
    }
    if (!f) return
    if (f.kind === 'multiline') {
      const text = textInput(key, true)
      if (text !== undefined) {
        this.multilineMode = true
        this.values[f.key] = (this.values[f.key] ?? '') + text
      } else if (key === 'backspace') {
        this.values[f.key] = (this.values[f.key] ?? '').slice(0, -1)
      }
      return
    }
    if (key === 'backspace') {
      this.values[f.key] = (this.values[f.key] ?? '').slice(0, -1)
      return
    }
    const text = textInput(key, false)
    if (text !== undefined) {
      this.values[f.key] = (this.values[f.key] ?? '') + text
    }
  }

  private notTyping(f: Field | undefined): boolean {
    return !f || f.kind === 'bool' || f.kind === 'select'
  }

  private async trySubmit(app: App): Promise<void> {
    for (const f of this.fields) {
      const v = (this.values[f.key] ?? '').trim()
      if (f.required && v.length === 0) {
        app.setStatus(`${f.label} is required`, 'error')
        this.focus = this.fields.indexOf(f)
        return
      }
      if (f.validate) {
        const msg = f.validate(this.values[f.key] ?? '')
        if (msg) {
          app.setStatus(scrubTokens(msg), 'error')
          this.focus = this.fields.indexOf(f)
          return
        }
      }
    }
    this.submitting = true
    app.invalidate()
    try {
      await this.submit({ ...this.values }, app)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      app.setStatus(scrubTokens(msg), 'error')
      this.submitting = false
      app.invalidate()
    }
  }
}

function textInput(key: Key, multiline: boolean): string | undefined {
  if (key === 'space') return ' '
  if (typeof key !== 'string' || NAMED_KEYS.has(key)) return undefined
  let text = key
    .replace(BRACKETED_PASTE_PATTERN, '')
    .replace(ANSI_SEQUENCE_PATTERN, '')
  text = multiline
    ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    : text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  return text.length > 0 ? text : undefined
}

export interface ConfirmOpts {
  message: string
  onConfirm: (app: App) => Promise<void> | void
  onCancel?: (app: App) => void
}

export class ConfirmView implements View {
  readonly title = 'confirm'
  readonly isTextEntry = true
  private readonly message: string
  private readonly confirm: ConfirmOpts['onConfirm']
  private readonly cancel?: ConfirmOpts['onCancel']
  private busy = false

  constructor(opts: ConfirmOpts) {
    this.message = opts.message
    this.confirm = opts.onConfirm
    this.cancel = opts.onCancel
  }

  hints(): string[] { return ['y:yes', 'n/esc:no'] }

  dispose(): void { /* no resources to release */ }

  render(_ctx: ViewContext): string[] {
    const tail = this.busy ? ' ' + ui.muted('working...') : ''
    return ['', ' ' + ui.warn('Confirm') + '  ' + this.message, ' ' + ui.key('y') + ui.muted(':yes  ') + ui.key('n') + ui.muted('/esc:no') + tail, '']
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (this.busy) return
    if (key === 'y' || key === 'Y') {
      this.busy = true
      ctx.app.invalidate()
      try {
        await this.confirm(ctx.app)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        ctx.app.setStatus(scrubTokens(msg), 'error')
        this.busy = false
        ctx.app.invalidate()
      }
      return
    }
    if (key === 'n' || key === 'N' || key === 'esc') {
      this.cancel?.(ctx.app)
      ctx.app.pop()
    }
  }
}

interface DirEntry {
  name: string
  isDir: boolean
}

class FilePickerView implements View {
  readonly title = 'pick file'
  readonly isTextEntry = true
  private readonly rootCwd: string
  private readonly pick: (path: string) => void
  private dir: string
  private entries: DirEntry[] = []
  private cursor = 0
  private offset = 0
  private absolutePrompt: string | undefined
  private error: string | undefined

  constructor(cwd: string, pick: (path: string) => void) {
    this.rootCwd = resolve(cwd)
    this.dir = this.rootCwd
    this.pick = pick
    this.scan()
  }

  hints(): string[] {
    if (this.absolutePrompt !== undefined) return ['enter:open', 'esc:cancel']
    return ['j/k:move', 'enter:open/pick', 'h/bs:up', ':abs', 'esc:cancel']
  }

  dispose(): void { /* nothing to release */ }

  private scan(): void {
    try {
      const items = readdirSync(this.dir, { withFileTypes: true })
      this.entries = items
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
      this.cursor = 0
      this.offset = 0
      this.error = undefined
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      this.entries = []
    }
  }

  render(ctx: ViewContext): string[] {
    const lines: string[] = []
    lines.push(' ' + ui.title('File picker'))
    lines.push(' ' + ui.muted(this.dir))
    if (this.absolutePrompt !== undefined) {
      lines.push(' ' + ui.key(':') + ' ' + ui.input(`[ ${sanitizeAnsi(this.absolutePrompt) || '<absolute path>'} ]`))
      return lines
    }
    if (this.error) { lines.push(ui.error(' error: ') + this.error); return lines }
    const visible = Math.max(1, ctx.size.rows - 3)
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(this.entries.length, this.offset + visible); i++) {
      const e = this.entries[i]!
      const text = (e.isDir ? '📁 ' : '   ') + sanitizeAnsi(e.name) + (e.isDir ? '/' : '')
      lines.push(i === this.cursor ? ui.selected(' ' + text + ' ') : ' ' + text)
    }
    return lines
  }

  onKey(key: Key, ctx: ViewContext): void {
    if (this.absolutePrompt !== undefined) {
      if (key === 'esc') { this.absolutePrompt = undefined; return }
      if (key === 'enter') {
        const path = this.absolutePrompt.trim()
        this.absolutePrompt = undefined
        if (!isAbsolute(path)) {
          ctx.app.setStatus('absolute path required (no ~ expansion)', 'error')
          return
        }
        this.pick(path)
        ctx.app.pop()
        return
      }
      if (key === 'backspace') { this.absolutePrompt = this.absolutePrompt.slice(0, -1); return }
      const text = textInput(key, false)
      if (text !== undefined) {
        this.absolutePrompt += text
      }
      return
    }
    if (key === 'esc') { ctx.app.pop(); return }
    if (key === ':') { this.absolutePrompt = ''; return }
    const last = Math.max(0, this.entries.length - 1)
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(last, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(last, this.cursor + 10); return }
    if (key === 'h' || key === 'left' || key === 'backspace') {
      const parent = resolve(this.dir, '..')
      if (!parent.startsWith(this.rootCwd) || parent === this.dir) {
        ctx.app.setStatus('refusing to leave cwd; use : for absolute path', 'error')
        return
      }
      this.dir = parent
      this.scan()
      return
    }
    if (key === 'enter') {
      const e = this.entries[this.cursor]
      if (!e) return
      const target = join(this.dir, e.name)
      if (e.isDir) { this.dir = target; this.scan(); return }
      try {
        statSync(target)
      } catch {
        ctx.app.setStatus('not a regular file', 'error')
        return
      }
      this.pick(target)
      ctx.app.pop()
    }
  }
}
