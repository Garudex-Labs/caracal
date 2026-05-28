// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reusable searchable entity picker helpers for Console form fields.

import { copyToClipboard, pad, sanitizeAnsi, truncate, ui } from '../ansi.ts'
import { actions, composeActions, type FooterAction } from '../actions.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App } from '../screen.ts'
import type { View, ViewContext } from '../screen.ts'
import type { Field } from './form.ts'
import { actionInfo, openInfo, type InfoPage } from './info.ts'
import type { Column } from './list.ts'

export interface EntityOption {
  value: string
  label: string
  description?: string | undefined
  icon?: string | undefined
  searchText?: string | undefined
}

export interface EntityPickerOptions<T> {
  title: string
  load: () => Promise<T[]>
  rows?: T[] | undefined
  value: (row: T) => string
  label: (row: T) => string
  description?: (row: T) => string | undefined
  icon?: (row: T) => string | undefined
  merge?: (current: string, picked: string) => string
  onPick: (value: string, label?: string) => void | Promise<void>
  info?: InfoPage
}

const PAGE_SIZE = 100

export function pickFromList<T>(
  title: string,
  load: () => Promise<T[]>,
  columns: Column<T>[],
  value: (row: T) => string,
  label: (row: T) => string,
  merge?: (current: string, picked: string) => string,
): Field['pick'] {
  return (app: App, setValue: (value: string, label?: string) => void | Promise<void>, currentValue: string) => {
    app.push(new EntityPickerView<T>({
      title,
      load,
      value,
      label,
      description: (row) => summarizeColumns(row, columns, value(row), label(row)),
      onPick: (picked, pickedLabel) => {
        const next = merge ? merge(currentValue, picked) : picked
        return setValue(next, merge ? undefined : pickedLabel)
      },
    }))
  }
}

export class EntityPickerView<T> implements View {
  readonly title: string
  readonly isTextEntry = true
  private readonly loader: () => Promise<T[]>
  private readonly value: (row: T) => string
  private readonly label: (row: T) => string
  private readonly description?: (row: T) => string | undefined
  private readonly icon?: (row: T) => string | undefined
  private readonly pick: (value: string, label?: string) => void | Promise<void>
  private readonly info: InfoPage
  private options: EntityOption[] = []
  private cursor = 0
  private offset = 0
  private query = ''
  private loading = true
  private error: string | undefined
  private showIds = false
  private aborted = false
  private app: App | undefined

  constructor(opts: EntityPickerOptions<T>) {
    this.title = opts.title
    this.loader = opts.load
    this.value = opts.value
    this.label = opts.label
    this.description = opts.description
    this.icon = opts.icon
    this.pick = opts.onPick
    this.info = opts.info ?? actionInfo(opts.title, 'Selecting a row fills the parent field with the hidden internal value while showing the readable label.')
    if (opts.rows) {
      this.options = this.buildOptions(opts.rows)
      this.loading = false
    }
  }

  hints(): string[] {
    return ['↑/↓:move', 'type:search', 'enter:select', '?:info', 'V:reveal-id', 'N:copy-name', 'I:copy-id', 'esc:back']
  }

  footerActions(): readonly FooterAction[] {
    return composeActions([
      actions.search,
      actions.move,
      actions.select,
      actions.info,
      actions.revealId,
      actions.copyName,
      actions.copyId,
      actions.back,
    ], {
      selection: this.filtered()[this.cursor] ? 'single' : 'none',
      flags: this.loading ? ['loading'] : this.error ? ['error'] : undefined,
    })
  }

  async init(app: App): Promise<void> {
    this.app = app
    if (!this.loading) return
    await this.reload()
  }

  dispose(): void { this.aborted = true }

  private async reload(): Promise<void> {
    const app = this.app
    this.loading = true
    this.error = undefined
    app?.invalidate()
    try {
      const rows = await this.loader()
      if (this.aborted) return
      this.options = this.buildOptions(rows)
      this.cursor = Math.min(this.cursor, Math.max(0, this.filtered().length - 1))
      this.offset = Math.min(this.offset, this.cursor)
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

  render(ctx: ViewContext): string[] {
    if (this.loading) return [ui.muted(' loading...')]
    if (this.error) return [ui.error(' error: ') + this.error]
    const filtered = this.filtered()
    const lines: string[] = [
      ' ' + ui.title(this.title),
      ' ' + ui.muted('search ') + ui.input(`[ ${sanitizeAnsi(this.query) || 'type to filter'} ]`),
    ]
    if (filtered.length === 0) {
      lines.push(' ' + ui.muted('No matches. Backspace clears the search.'))
      return lines
    }
    const visible = Math.max(1, Math.min(PAGE_SIZE, ctx.size.rows - lines.length))
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(filtered.length, this.offset + visible); i++) {
      const option = filtered[i]!
      const mark = i === this.cursor ? ui.accent('>') : ' '
      const label = sanitizeAnsi(`${option.icon ? `${option.icon} ` : ''}${option.label}`)
      const description = option.description ? ui.muted('  ' + sanitizeAnsi(option.description)) : ''
      const id = this.showIds ? ui.muted('  id:' + sanitizeAnsi(option.value)) : ui.muted('  id:hidden')
      lines.push(` ${mark} ${pad(truncate(label, 30), 30)}${truncate(description + id, Math.max(10, ctx.size.cols - 40))}`)
    }
    if (filtered.length > PAGE_SIZE) lines.push(' ' + ui.muted(`showing ${PAGE_SIZE} of ${filtered.length} matches; keep typing to narrow`))
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const filtered = this.filtered()
    const last = Math.max(0, filtered.length - 1)
    if (key === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down') { this.cursor = Math.min(last, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(last, this.cursor + 10); return }
    if (key === 'home') { this.cursor = 0; return }
    if (key === 'end') { this.cursor = last; return }
    if (key === 'V') { this.showIds = !this.showIds; return }
    if (key === 'N') { this.copyName(ctx.app); return }
    if (key === 'I') { this.copyId(ctx.app); return }
    if (key === '?') { this.openInfo(ctx.app); return }
    if (key === 'backspace') {
      this.query = this.query.slice(0, -1)
      this.cursor = Math.min(this.cursor, Math.max(0, this.filtered().length - 1))
      return
    }
    if (key === 'esc' || key === 'left') { ctx.app.pop(); return }
    if (key === 'enter') {
      const option = filtered[this.cursor]
      if (!option) return
      await this.pick(option.value, option.label)
      ctx.app.pop()
      ctx.app.setStatus(`selected ${option.label}`)
      return
    }
    const text = searchText(key)
    if (text !== undefined) {
      this.query += text
      this.cursor = 0
      this.offset = 0
    }
  }

  private filtered(): EntityOption[] {
    const query = this.query.trim().toLowerCase()
    if (!query) return this.options
    return this.options.filter((option) => option.searchText?.includes(query))
  }

  private copyName(app: App): void {
    const option = this.filtered()[this.cursor]
    if (!option) return
    copyToClipboard(option.label)
    app.setStatus(`copied name ${option.label}`)
  }

  private copyId(app: App): void {
    const option = this.filtered()[this.cursor]
    if (!option) return
    copyToClipboard(option.value)
    app.setStatus(`copied id for ${option.label}`)
  }

  private openInfo(app: App): void {
    const option = this.filtered()[this.cursor]
    openInfo(app, {
      ...this.info,
      title: option ? `${this.title}: ${option.label}` : this.info.title,
      impact: option
        ? 'Picking this row stores its raw internal value in the parent field while the form may show a readable label.'
        : this.info.impact,
      example: option ? option.label : this.info.example,
      valid: 'Use search text to narrow results; press enter to select the highlighted row.',
      after: option
        ? `The parent field stores the internal ID for ${option.label}, with the ID hidden unless you reveal it.`
        : this.info.after,
      context: option ? [
        ...(this.info.context ?? []),
        { label: 'Selected', value: option.label },
        { label: 'Matches', value: `${this.filtered().length}` },
      ] : this.info.context,
      terms: option ? [
        ...(this.info.terms ?? []),
        { label: 'Internal ID', value: 'The stable backend value saved in the form, even when Console displays a friendly name.' },
      ] : this.info.terms,
    })
  }

  private disambiguate(options: EntityOption[]): EntityOption[] {
    const counts = new Map<string, number>()
    for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1)
    return options.map((option) => {
      if ((counts.get(option.label) ?? 0) < 2) return option
      const suffix = shortValue(option.value)
      return {
        ...option,
        label: `${option.label} (${suffix})`,
        searchText: `${option.searchText ?? ''} ${suffix}`,
      }
    })
  }

  private buildOptions(rows: T[]): EntityOption[] {
    return this.disambiguate(rows.map((row) => {
      const label = this.label(row)
      const value = this.value(row)
      const description = this.description?.(row)
      return {
        value,
        label,
        description,
        icon: this.icon?.(row),
        searchText: [label, value, description].filter((part): part is string => Boolean(part)).join(' ').toLowerCase(),
      }
    }))
  }
}

function summarizeColumns<T>(row: T, columns: Column<T>[], picked: string, pickedLabel: string): string | undefined {
  const values = columns
    .filter((column) => column.header.toLowerCase() !== 'id')
    .map((column) => [column.header, column.value(row)] as const)
    .filter(([, text]) => text !== picked && text !== pickedLabel && text !== '-')
    .slice(0, 3)
    .map(([header, text]) => `${header}:${text}`)
  return values.length > 0 ? values.join('  ') : undefined
}

function searchText(key: Key): string | undefined {
  if (typeof key !== 'string') return undefined
  if (key.length !== 1) return undefined
  if (key < ' ' || key === '\u007f') return undefined
  return sanitizeAnsi(key)
}

function shortValue(value: string): string {
  if (value.length <= 12) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

export function appendCsv(current: string, picked: string): string {
  const values = current.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
  return values.includes(picked) ? values.join(',') : [...values, picked].join(',')
}
