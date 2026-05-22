// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Structured detail view for scrollable operator inspection of records.

import { pad, sanitizeAnsi, ui } from '../ansi.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'

export interface DetailOptions {
  title: string
  load: () => Promise<unknown>
  mask?: (value: unknown, path: string[]) => string | undefined
}

export class DetailView implements View {
  readonly title: string
  private readonly loader: () => Promise<unknown>
  private readonly mask?: (value: unknown, path: string[]) => string | undefined
  private data: unknown
  private body: string[] = [' loading…']
  private offset = 0
  private loading = true
  private error: string | undefined
  private aborted = false
  private revealed = false
  private app: App | undefined

  constructor(opts: DetailOptions) {
    this.title = opts.title
    this.loader = opts.load
    this.mask = opts.mask
  }

  hints(): string[] {
    const base = ['↑/↓:scroll', 'r:reload', 'esc:back']
    if (this.mask) base.push(this.revealed ? 'v:mask' : 'v:reveal')
    return base
  }

  async init(app: App): Promise<void> { this.app = app; await this.reload() }

  dispose(): void { this.aborted = true }

  async reload(): Promise<void> {
    const app = this.app
    this.loading = true
    this.error = undefined
    this.body = [' loading…']
    app?.invalidate()
    try {
      const data = await this.loader()
      if (this.aborted) return
      this.data = data
      this.rebuild()
      this.offset = 0
    } catch (err) {
      if (this.aborted) return
      this.error = explainError(err)
    } finally {
      if (!this.aborted) {
        this.loading = false
        app?.invalidate()
      }
    }
  }

  private rebuild(): void {
    this.body = renderDetail(this.data, this.mask, this.revealed)
  }

  render(ctx: ViewContext): string[] {
    if (this.loading) return [ui.muted(' loading...')]
    if (this.error) return [ui.error(' error: ') + this.error]
    const lines: string[] = []
    for (let i = this.offset; i < Math.min(this.body.length, this.offset + ctx.size.rows); i++) {
      lines.push(' ' + this.body[i])
    }
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const max = Math.max(0, this.body.length - ctx.size.rows)
    if (key === 'up' || key === 'k') { this.offset = Math.max(0, this.offset - 1); return }
    if (key === 'down' || key === 'j') { this.offset = Math.min(max, this.offset + 1); return }
    if (key === 'pgup') { this.offset = Math.max(0, this.offset - 10); return }
    if (key === 'pgdn') { this.offset = Math.min(max, this.offset + 10); return }
    if (key === 'home' || key === 'g') { this.offset = 0; return }
    if (key === 'end' || key === 'G') { this.offset = max; return }
    if (key === 'r') return this.reload()
    if (key === 'v' && this.mask) {
      this.revealed = !this.revealed
      this.rebuild()
      ctx.app.invalidate()
      return
    }
    if (key === 'left' || key === 'esc') ctx.app.pop()
  }
}

type DetailMask = (value: unknown, path: string[]) => string | undefined

const LABEL_WIDTH = 22
const ACRONYMS = new Set(['api', 'dcr', 'id', 'json', 'jwt', 'mcp', 'oidc', 'oauth', 'pkce', 'terminal', 'url'])
const GOOD_VALUES = new Set([
  'active', 'allow', 'allowed', 'enabled', 'healthy', 'managed', 'mounted', 'ok', 'passed', 'ready', 'running', 'success',
  'succeeded', 'valid',
])
const WARN_VALUES = new Set(['disabled', 'expired', 'gated', 'partial', 'pending', 'revoked', 'suspended', 'unmounted', 'warning'])
const BAD_VALUES = new Set(['blocked', 'deny', 'denied', 'down', 'error', 'failed', 'forbidden', 'invalid', 'terminated', 'unhealthy'])

function renderDetail(value: unknown, mask: DetailMask | undefined, revealed: boolean): string[] {
  const lines = renderNode('Details', value, [], mask, revealed, 0, true)
  return lines.length > 0 ? lines : [ui.muted(' No data')]
}

function renderNode(
  title: string,
  value: unknown,
  path: string[],
  mask: DetailMask | undefined,
  revealed: boolean,
  depth: number,
  root = false,
): string[] {
  const masked = maskedValue(value, path, mask, revealed)
  if (masked !== undefined || isScalar(value)) return renderField(root ? 'Value' : title, masked ?? value, path, depth)
  if (Array.isArray(value)) return renderArray(root ? 'Items' : title, value, path, mask, revealed, depth)
  return renderObject(root ? 'Overview' : title, value as Record<string, unknown>, path, mask, revealed, depth, root)
}

function renderObject(
  title: string,
  value: Record<string, unknown>,
  path: string[],
  mask: DetailMask | undefined,
  revealed: boolean,
  depth: number,
  root: boolean,
): string[] {
  const lines = section(title, depth)
  const entries = Object.entries(value)
  if (entries.length === 0) {
    lines.push(indented(ui.muted('No fields'), depth + 1))
    return lines
  }

  const fields = entries.filter(([key, child]) => {
    const childPath = [...path, key]
    return maskedValue(child, childPath, mask, revealed) !== undefined || isScalar(child)
  })
  const groups = entries.filter(([key, child]) => {
    const childPath = [...path, key]
    return maskedValue(child, childPath, mask, revealed) === undefined && !isScalar(child)
  })

  for (const [key, child] of fields) {
    lines.push(...renderField(formatLabel(key), maskedValue(child, [...path, key], mask, revealed) ?? child, [...path, key], depth + 1))
  }

  const groupDepth = root ? depth : depth + 1
  for (const [key, child] of groups) {
    lines.push(...renderNode(formatLabel(key), child, [...path, key], mask, revealed, groupDepth))
  }
  return lines
}

function renderArray(
  title: string,
  value: unknown[],
  path: string[],
  mask: DetailMask | undefined,
  revealed: boolean,
  depth: number,
): string[] {
  const lines = section(`${title} (${value.length})`, depth)
  if (value.length === 0) {
    lines.push(indented(ui.muted('No items'), depth + 1))
    return lines
  }
  if (value.every((item, index) => maskedValue(item, [...path, String(index)], mask, revealed) !== undefined || isScalar(item))) {
    const formatted = value
      .map((item, index) => formatScalar(maskedValue(item, [...path, String(index)], mask, revealed) ?? item, [...path, String(index)]))
      .join(ui.muted(', '))
    lines.push(indented(formatted, depth + 1))
    return lines
  }
  for (let i = 0; i < value.length; i++) {
    lines.push(...renderNode(`#${i + 1}`, value[i], [...path, String(i)], mask, revealed, depth + 1))
  }
  return lines
}

function renderField(label: string, value: unknown, path: string[], depth: number): string[] {
  const prefix = indented(ui.muted(pad(label, LABEL_WIDTH)), depth)
  if (typeof value === 'string' && value.includes('\n')) {
    const lines = [prefix]
    for (const line of value.split('\n')) lines.push(indented(ui.input(sanitizeAnsi(line) || ' '), depth + 1))
    return lines
  }
  return [prefix + ' ' + formatScalar(value, path)]
}

function formatScalar(value: unknown, path: string[]): string {
  if (value === null || value === undefined) return ui.muted('none')
  if (typeof value === 'boolean') return value ? ui.success('yes') : ui.muted('no')
  if (typeof value === 'number' || typeof value === 'bigint') return ui.info(String(value))
  if (value instanceof Date) return ui.input(value.toISOString())
  if (typeof value !== 'string') return ui.input(sanitizeAnsi(String(value)))

  const text = sanitizeAnsi(value)
  if (text.length === 0) return ui.muted('empty')
  const lower = text.toLowerCase()
  if (isStatusPath(path)) {
    if (GOOD_VALUES.has(lower)) return ui.success(text)
    if (WARN_VALUES.has(lower)) return ui.warn(text)
    if (BAD_VALUES.has(lower)) return ui.error(text)
  }
  return ui.input(text)
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== 'object' || value instanceof Date
}

function maskedValue(value: unknown, path: string[], mask: DetailMask | undefined, revealed: boolean): string | undefined {
  if (!mask || revealed) return undefined
  return mask(value, path)
}

function section(title: string, depth: number): string[] {
  return ['', indented(ui.title(title), depth)]
}

function indented(text: string, depth: number): string {
  return '  '.repeat(depth) + text
}

function isStatusPath(path: string[]): boolean {
  const key = path[path.length - 1]?.toLowerCase() ?? ''
  return key.includes('status') || key.includes('state') || key.includes('decision') || key === 'service' || key === 'valid'
}

function formatLabel(raw: string): string {
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (spaced.length === 0) return raw
  return spaced.split(/\s+/).map((word) => {
    const lower = word.toLowerCase()
    if (ACRONYMS.has(lower)) return lower.toUpperCase()
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  }).join(' ')
}
