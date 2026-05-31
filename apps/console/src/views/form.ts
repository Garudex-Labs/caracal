// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interactive form, confirm, and file picker views for Console mutations.

import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ansi, copyToClipboard, pad, sanitizeAnsi, truncate, ui } from '../ansi.ts'
import { explainError, scrubTokens } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { actionInfo, fieldInfo, infoPage, openInfo, type InfoPage } from './info.ts'

type FieldKind = 'text' | 'multiline' | 'secret' | 'secret-multiline' | 'bool' | 'list' | 'file' | 'select'
type RequiredValue = boolean | ((values: Readonly<Record<string, string>>) => boolean)
type FieldDependency = string | string[] | Record<string, string | string[] | boolean>
type FormRow =
  | { kind: 'field'; field: Field }
  | { kind: 'advanced' }

export interface Field {
  key: string
  label: string
  kind: FieldKind
  required?: RequiredValue
  default?: string
  options?: string[]
  optionLabels?: Record<string, string>
  validate?: (v: string) => string | undefined
  visible?: (values: Readonly<Record<string, string>>) => boolean
  dependsOn?: FieldDependency
  advanced?: boolean
  section?: string
  hint?: string
  info?: InfoPage
  pick?: (app: App, setValue: (value: string, label?: string) => void | Promise<void>, currentValue: string, values: Readonly<Record<string, string>>) => void | Promise<void>
  resolve?: (value: string) => string | undefined | Promise<string | undefined>
}

export interface FormOpts {
  title: string
  fields: Field[]
  initialValues?: Record<string, string>
  submitLabel?: string
  onSubmit: (vals: Record<string, string>, app: App) => Promise<void>
  onCancel?: (app: App) => void
  info?: InfoPage
}

const BRACKETED_PASTE_PATTERN = /\u001b\[(?:200|201)~/g
const ANSI_SEQUENCE_PATTERN = /\u001b\[[0-9;?]*[A-Za-z~]/g
const FLOW_MARKER = '↳'
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
  private displayLabels: Record<string, string> = {}
  private focus = 0
  private revealed = new Set<string>()
  private revealedIds = new Set<string>()
  private multilineMode = false
  private submitting = false
  private readonly info: InfoPage

  constructor(opts: FormOpts) {
    this.title = opts.title
    this.fields = opts.fields.map((field) => field.advanced ? { ...field, required: false } : field)
    this.submitLabel = opts.submitLabel ?? 'submit'
    this.submit = opts.onSubmit
    this.cancel = opts.onCancel
    this.values = {
      ...Object.fromEntries(opts.fields.map((f) => [f.key, f.default ?? ''])),
      ...(opts.initialValues ?? {}),
    }
    this.info = opts.info ?? actionInfo(this.submitLabel)
  }

  hints(): string[] {
    if (this.multilineMode) return ['esc:done', 'enter:newline']
    this.clampFocus()
    const base = ['tab/↑/↓:next', 'enter:advance/submit', '?:info', 'esc:cancel']
    const row = this.visibleRows()[this.focus]
    if (row?.kind === 'advanced') base.push('→:advanced')
    const field = row?.kind === 'field' ? row.field : undefined
    if (field?.pick) base.push('→:pick')
    else if (field?.kind === 'select') base.push('→:options')
    else if (field?.kind === 'file') base.push('→:file')
    else if (field?.kind === 'secret' || field?.kind === 'secret-multiline') base.push('→:reveal')
    return base
  }

  dispose(): void { this.abort.abort() }

  values_(): Record<string, string> { return this.values }

  async init(app: App): Promise<void> {
    await this.resolveLabels(app)
  }

  render(ctx: ViewContext): string[] {
    const rows = this.visibleRows()
    this.clampFocus(rows)
    const lines: string[] = ['']
    lines.push(' ' + ui.title(this.title))
    lines.push(' ' + ui.muted(`Type or paste into fields. * required, ${FLOW_MARKER} changes visible fields.`))
    lines.push('')
    const labelWidth = this.labelWidth(rows)
    let section = ''
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      if (row.kind === 'advanced') {
        const focused = i === this.focus
        const cursorMark = focused ? '> ' : '  '
        const text = ` ${focused ? ui.accent(cursorMark) : cursorMark}${ui.muted(pad('Advanced options', 18))}${ui.input('open optional settings')}`
        lines.push(truncate(text, ctx.size.cols))
        continue
      }
      const f = row.field
      if (f.section && f.section !== section) {
        section = f.section
        lines.push(' ' + ui.accent(section))
      }
      const focused = i === this.focus
      const display = this.displayValue(f)
      const label = pad(this.fieldLabel(f), labelWidth)
      const cursorMark = focused ? (this.multilineMode ? '* ' : '> ') : '  '
      const text = focused
        ? ` ${ui.accent(cursorMark)}${ui.muted(label)}${display}`
        : ` ${cursorMark}${ui.muted(label)}${display}`
      const styled = truncate(text, ctx.size.cols)
      lines.push(styled)
    }
    lines.push('')
    const submitMark = this.focus === rows.length ? ansi.invert : ''
    const reset = this.focus === rows.length ? ansi.reset : ''
    lines.push(' ' + submitMark + ` [${this.submitLabel}] ` + reset)
    if (this.submitting) lines.push(' ' + ui.muted('submitting...'))
    return lines
  }

  private displayValue(f: Field): string {
    const raw = this.values[f.key] ?? ''
    if (f.kind === 'bool') return raw === 'true' ? '[x]' : '[ ]'
    if (f.kind === 'select') return ui.input(`[ ${sanitizeAnsi(this.selectLabel(f, raw) || '<choose>')} ]`)
    if (f.pick && raw.length > 0) {
      const label = this.displayLabels[f.key]
      if (!label) return ui.input(`[ ${sanitizeAnsi(raw)} ]`)
      if (this.revealedIds.has(f.key)) return ui.input(`[ ${sanitizeAnsi(label)} ]`) + ui.muted(` id:${sanitizeAnsi(raw)}`)
      return ui.input(`[ ${sanitizeAnsi(label)} ]`) + ui.muted(' id:hidden')
    }
    if (f.kind === 'secret' || f.kind === 'secret-multiline') {
      const value = f.kind === 'secret-multiline' ? raw.replace(/\n/g, ' ⏎ ') : raw
      const shown = this.revealed.has(f.key) ? sanitizeAnsi(value) : raw.length === 0 ? '' : '••••'
      return ui.input(`[ ${shown || `<${f.label}>`} ]`)
    }
    const shown = f.kind === 'multiline'
      ? sanitizeAnsi(raw.replace(/\n/g, ' ⏎ '))
      : sanitizeAnsi(raw)
    return ui.input(`[ ${shown || `<${f.label}>`} ]`)
  }

  private labelWidth(rows: FormRow[]): number {
    let width = 18
    for (const row of rows) {
      if (row.kind !== 'field') continue
      width = Math.max(width, this.fieldLabel(row.field).length + 2)
    }
    return width
  }

  private fieldLabel(field: Field): string {
    const parts = [field.label]
    if (this.isRequired(field)) parts.push('*')
    if (this.controlsFields(field)) parts.push(FLOW_MARKER)
    return parts.join(' ')
  }

  private selectLabel(field: Field, value: string): string {
    return field.optionLabels?.[value] ?? value
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (this.submitting) return
    const rows = this.visibleRows()
    this.clampFocus(rows)
    const row = rows[this.focus]
    const f = row?.kind === 'field' ? row.field : undefined
    if (this.multilineMode && f) {
      if (key === 'esc') { this.multilineMode = false; return }
      if (key === 'enter') { this.values[f.key] = (this.values[f.key] ?? '') + '\n'; return }
      if (key === 'backspace') {
        this.values[f.key] = (this.values[f.key] ?? '').slice(0, -1)
        delete this.displayLabels[f.key]
        return
      }
      const text = textInput(key, true)
      if (text !== undefined) {
        this.values[f.key] = (this.values[f.key] ?? '') + text
        delete this.displayLabels[f.key]
      }
      return
    }
    if (key === 'esc') {
      this.cancel?.(ctx.app)
      ctx.app.pop()
      return
    }
    if (key === '?' && !this.multilineMode) {
      openInfo(ctx.app, this.focus === rows.length ? this.info : this.rowInfo(row))
      return
    }
    if (key === 'right' && row?.kind === 'advanced') { this.openAdvanced(ctx.app); return }
    if (f?.pick && key === 'V' && (this.values[f.key] ?? '').trim()) {
      if (this.revealedIds.has(f.key)) this.revealedIds.delete(f.key)
      else this.revealedIds.add(f.key)
      return
    }
    if (f?.pick && key === 'N' && (this.values[f.key] ?? '').trim()) {
      const name = this.displayLabels[f.key] ?? this.values[f.key] ?? ''
      copyToClipboard(name)
      ctx.app.setStatus(`copied name ${name}`)
      return
    }
    if (f?.pick && key === 'I' && (this.values[f.key] ?? '').trim()) {
      copyToClipboard(this.values[f.key] ?? '')
      ctx.app.setStatus(`copied id for ${this.displayLabels[f.key] ?? f.label}`)
      return
    }
    if (key === 'right' && f?.pick) {
      await f.pick(ctx.app, async (value, label) => {
        this.values[f.key] = value
        if (label) this.displayLabels[f.key] = label
        else await this.resolveLabel(f, ctx.app)
        this.revealedIds.delete(f.key)
      }, this.values[f.key] ?? '', this.values)
      return
    }
    if (key === 'right' && f?.kind === 'select') {
      ctx.app.push(new OptionPickerView(f.label, f.options ?? [], f.optionLabels ?? {}, this.values[f.key] ?? '', (value) => {
        this.values[f.key] = value
      }, f.info ?? fieldInfo(f.label, f.kind, f.hint, {
        required: this.isRequired(f),
        picker: Boolean(f.pick),
        options: f.options?.map((value) => this.selectLabel(f, value)),
        advanced: Boolean(f.advanced),
        dependency: this.dependencyText(f),
      })))
      return
    }
    if (key === 'right' && (f?.kind === 'secret' || f?.kind === 'secret-multiline')) {
      if (this.revealed.has(f.key)) this.revealed.delete(f.key)
      else this.revealed.add(f.key)
      return
    }
    if (key === 'right' && f?.kind === 'file') {
      ctx.app.push(new FilePickerView(process.cwd(), (path) => {
        this.values[f.key] = path
      }))
      return
    }
    if (key === 'tab' || key === 'down') {
      this.focus = Math.min(rows.length, this.focus + 1)
      return
    }
    if (key === 'up') {
      this.focus = Math.max(0, this.focus - 1)
      return
    }
    if (key === 'enter') {
      if (this.focus === rows.length) return this.trySubmit(ctx.app)
      if (row?.kind === 'advanced') { this.openAdvanced(ctx.app); return }
      if (f && f.kind === 'bool') {
        this.values[f.key] = this.values[f.key] === 'true' ? 'false' : 'true'
        return
      }
      if (f && f.kind === 'select') {
        this.focus = Math.min(rows.length, this.focus + 1)
        return
      }
      if (this.focus === rows.length - 1) return this.trySubmit(ctx.app)
      this.focus++
      return
    }
    if (key === 'space' && f && f.kind === 'bool') {
      this.values[f.key] = this.values[f.key] === 'true' ? 'false' : 'true'
      return
    }
    if (!f) return
    if (f.kind === 'bool' || f.kind === 'select') return
    if (f.kind === 'multiline' || f.kind === 'secret-multiline') {
      const text = textInput(key, true)
      if (text !== undefined) {
        this.multilineMode = true
        this.values[f.key] = (this.values[f.key] ?? '') + text
        delete this.displayLabels[f.key]
      } else if (key === 'backspace') {
        this.values[f.key] = (this.values[f.key] ?? '').slice(0, -1)
        delete this.displayLabels[f.key]
      }
      return
    }
    if (key === 'backspace') {
      this.values[f.key] = (this.values[f.key] ?? '').slice(0, -1)
      delete this.displayLabels[f.key]
      return
    }
    const text = textInput(key, false)
    if (text !== undefined) {
      this.values[f.key] = (this.values[f.key] ?? '') + text
      delete this.displayLabels[f.key]
    }
  }

  private async resolveLabels(app: App): Promise<void> {
    await Promise.all(this.visibleFields().map((field) => this.resolveLabel(field, app)))
  }

  private async resolveLabel(field: Field, app: App): Promise<void> {
    if (!field.resolve) return
    const value = (this.values[field.key] ?? '').trim()
    if (!value) {
      delete this.displayLabels[field.key]
      return
    }
    try {
      const values = field.kind === 'list' ? splitCsv(value) : [value]
      const labels = await Promise.all(values.map((item) => field.resolve!(item)))
      this.displayLabels[field.key] = labels.map((label, index) => label ?? values[index]!).join(', ')
      app.invalidate()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      app.setStatus(scrubTokens(`label lookup for ${field.label}: ${msg}`), 'error')
    }
  }

  private async trySubmit(app: App): Promise<void> {
    const fields = this.activeFields()
    for (const f of fields) {
      const v = (this.values[f.key] ?? '').trim()
      if (this.isRequired(f) && v.length === 0) {
        app.setStatus(`${f.label} is required`, 'error')
        this.focusField(f)
        return
      }
      if (f.validate) {
        const msg = f.validate(this.values[f.key] ?? '')
        if (msg) {
          app.setStatus(scrubTokens(msg), 'error')
          this.focusField(f)
          return
        }
      }
    }
    this.submitting = true
    app.invalidate()
    try {
      await this.submit(this.submitValues(), app)
      this.submitting = false
      app.invalidate()
    } catch (err) {
      app.setStatus(explainError(err), 'error')
      this.submitting = false
      app.invalidate()
    }
  }

  private visibleFields(): Field[] {
    return this.visibleRows()
      .filter((row): row is { kind: 'field'; field: Field } => row.kind === 'field')
      .map((row) => row.field)
  }

  private activeFields(): Field[] {
    return this.fields.filter((field) => this.isVisible(field))
  }

  private submitValues(): Record<string, string> {
    return Object.fromEntries(this.fields.map((field) => [
      field.key,
      this.isVisible(field) ? this.values[field.key] ?? '' : '',
    ]))
  }

  private visibleRows(): FormRow[] {
    const common = this.fields
      .filter((field) => !field.advanced)
      .filter((field) => this.isVisible(field))
      .map((field): FormRow => ({ kind: 'field', field }))
    const advanced = this.advancedFields()
    if (advanced.length === 0) return common
    return [...common, { kind: 'advanced' }]
  }

  private clampFocus(rows = this.visibleRows()): void {
    this.focus = Math.min(this.focus, rows.length)
  }

  private advancedFields(): Field[] {
    return this.fields.filter((field) => field.advanced && this.isVisible(field))
  }

  private rowInfo(row: FormRow | undefined): InfoPage | undefined {
    if (row?.kind === 'advanced') {
      return infoPage({
        title: 'Advanced options',
        meaning: 'Optional settings open on their own page so the common form stays short.',
        when: 'Open this only when the common path does not express the setup you need.',
        impact: 'Advanced values override generated defaults and can affect identifiers, routing, provider behavior, or activation behavior.',
        example: 'Manual identifier, raw config JSON, shadow version, or overwrite flag.',
        valid: 'Every advanced field can be left blank or unchanged unless the field info says it is needed for your chosen scenario.',
        after: 'Saving returns to this form. Blank advanced fields keep the safe inferred defaults; filled values override the common path.',
        notes: ['Prefer picker-backed fields over manual IDs when available.', 'Leave raw JSON blank unless structured fields cannot express the provider or resource config.'],
      })
    }
    return this.fieldInfo(row?.field)
  }

  private fieldInfo(field: Field | undefined): InfoPage | undefined {
    if (!field) return this.info
    const info = field.info ?? fieldInfo(field.label, field.kind, field.hint, {
      key: field.key,
      required: this.isRequired(field),
      picker: Boolean(field.pick),
      options: field.options,
      advanced: Boolean(field.advanced),
      dependency: this.dependencyText(field),
    })
    if (!this.controlsFields(field)) return info
    return {
      ...info,
      context: [
        ...(info.context ?? []),
        { label: 'Affects fields', value: this.controlledFieldLabels(field).join(', ') },
      ],
      notes: [
        ...(info.notes ?? []),
        `${FLOW_MARKER} means changing this value can show, hide, or change validation for other fields in this form.`,
      ],
    }
  }

  private isRequired(field: Field): boolean {
    return typeof field.required === 'function' ? field.required(this.values) : field.required === true
  }

  private isVisible(field: Field): boolean {
    if (!this.matchesDependency(field)) return false
    return field.visible ? field.visible(this.values) : true
  }

  private matchesDependency(field: Field): boolean {
    const dependency = field.dependsOn
    if (!dependency) return true
    if (typeof dependency === 'string') return this.hasValue(dependency)
    if (Array.isArray(dependency)) return dependency.every((key) => this.hasValue(key))
    return Object.entries(dependency).every(([key, expected]) => {
      const value = this.values[key] ?? ''
      if (typeof expected === 'boolean') return (value === 'true') === expected
      if (Array.isArray(expected)) return expected.includes(value)
      return value === expected
    })
  }

  private hasValue(key: string): boolean {
    return (this.values[key] ?? '').trim().length > 0
  }

  private dependencyText(field: Field): string | undefined {
    const dependency = field.dependsOn
    if (!dependency) return undefined
    if (typeof dependency === 'string') return `Shown after ${dependency} has a value.`
    if (Array.isArray(dependency)) return `Shown after ${dependency.join(', ')} have values.`
    const parts = Object.entries(dependency).map(([key, expected]) => {
      if (typeof expected === 'boolean') return `${key} is ${expected ? 'enabled' : 'disabled'}`
      if (Array.isArray(expected)) return `${key} is ${expected.join(' or ')}`
      return `${key} is ${expected}`
    })
    return `Shown when ${parts.join(' and ')}.`
  }

  private controlsFields(field: Field): boolean {
    return this.fields.some((candidate) => candidate !== field && dependencyIncludes(candidate.dependsOn, field.key))
  }

  private controlledFieldLabels(field: Field): string[] {
    return this.fields
      .filter((candidate) => candidate !== field && dependencyIncludes(candidate.dependsOn, field.key))
      .map((candidate) => candidate.label)
  }

  private focusField(field: Field): void {
    const rowIndex = this.visibleRows().findIndex((row) => row.kind === 'field' && row.field.key === field.key)
    this.focus = rowIndex >= 0 ? rowIndex : Math.min(this.focus, this.visibleRows().length)
  }

  private openAdvanced(app: App): void {
    const fields = this.advancedFields().map((field) => ({ ...field, advanced: false, required: false }))
    app.push(new FormView({
      title: `${this.title} / advanced options`,
      fields,
      initialValues: this.values,
      submitLabel: 'save advanced options',
      info: infoPage({
        title: 'Advanced options',
        meaning: 'These optional settings override inferred defaults for uncommon cases.',
        when: 'Use them for manual identifiers, raw config, shadow versions, upstream credential provider binding, or enterprise-specific routing.',
        impact: 'Submitted advanced values are sent to the same API request as common fields and can change runtime behavior.',
        example: 'Set a manual resource identifier only when another system already depends on it.',
        valid: 'Leave fields blank to keep the parent form defaults.',
        after: 'Saving stores the values on the parent form and returns to the common path.',
        notes: ['Advanced options are not hidden features; they are implemented fields kept out of the common path to reduce noise.'],
      }),
      onSubmit: async (values, advancedApp) => {
        for (const field of fields) this.values[field.key] = values[field.key] ?? ''
        advancedApp.pop()
      },
    }))
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

function splitCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

export interface ConfirmOpts {
  message: string
  onConfirm: (app: App) => Promise<void> | void
  onCancel?: (app: App) => void
  info?: InfoPage
}

export class ConfirmView implements View {
  readonly title = 'confirm'
  readonly isTextEntry = true
  private readonly message: string
  private readonly confirm: ConfirmOpts['onConfirm']
  private readonly cancel?: ConfirmOpts['onCancel']
  private readonly info: InfoPage
  private busy = false

  constructor(opts: ConfirmOpts) {
    this.message = opts.message
    this.confirm = opts.onConfirm
    this.cancel = opts.onCancel
    this.info = opts.info ?? infoPage({
      title: 'Confirm action',
      meaning: 'This prompt protects a change that can alter or remove a Console object.',
      when: 'Use yes only after checking the target name and revealing the ID if needed.',
      impact: 'Confirming sends the state-changing request; canceling leaves backend state unchanged.',
      example: 'delete resource PiperNet',
      valid: 'Press y to continue, n or esc to cancel.',
      after: 'Console sends the request and shows an API error if the operation is rejected.',
      notes: ['For destructive changes, open the detail page first and use copy-page if you need a raw JSON record.'],
    })
  }

  hints(): string[] { return ['y:yes', 'n/esc:no', '?:info'] }

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
    if (key === '?') {
      openInfo(ctx.app, this.info)
      return
    }
    if (key === 'n' || key === 'N' || key === 'esc') {
      this.cancel?.(ctx.app)
      ctx.app.pop()
    }
  }
}

export interface ChoiceConfirmOption {
  key: string
  label: string
  description: string
  value: string
}

export interface ChoiceConfirmOpts {
  message: string
  options: ChoiceConfirmOption[]
  onChoose: (value: string, app: App) => Promise<void> | void
  info?: InfoPage
}

export class ChoiceConfirmView implements View {
  readonly title = 'confirm'
  readonly isTextEntry = true
  private readonly message: string
  private readonly options: ChoiceConfirmOption[]
  private readonly choose: ChoiceConfirmOpts['onChoose']
  private readonly info: InfoPage
  private busy = false

  constructor(opts: ChoiceConfirmOpts) {
    this.message = opts.message
    this.options = opts.options
    this.choose = opts.onChoose
    this.info = opts.info ?? infoPage({
      title: 'Confirm action',
      meaning: 'This prompt requires choosing how Console should apply a state-changing operation.',
      when: 'Use the option that matches the operational intent for existing runtime state.',
      impact: 'Console sends the selected operation to the backend; cancel leaves backend state unchanged.',
      example: 'revoke live DCR apps',
      valid: 'Press the key beside an option, ? for help, or esc to cancel.',
      after: 'Console submits the selected operation and shows an API error if the backend rejects it.',
    })
  }

  hints(): string[] {
    return [...this.options.map((option) => `${option.key}:${option.label}`), 'esc:cancel', '?:info']
  }

  dispose(): void { /* no resources to release */ }

  render(ctx: ViewContext): string[] {
    const lines = ['', ' ' + ui.warn('Confirm') + '  ' + this.message, '']
    for (const option of this.options) {
      lines.push(truncate(`  ${ui.key(option.key)}  ${option.label}  ${ui.muted(option.description)}`, ctx.size.cols))
    }
    if (this.busy) lines.push(' ' + ui.muted('working...'))
    lines.push('')
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (this.busy) return
    if (key === '?') {
      openInfo(ctx.app, this.info)
      return
    }
    if (key === 'esc') {
      await this.choose('cancel', ctx.app)
      return
    }
    const option = this.options.find((item) => item.key.toLowerCase() === key.toLowerCase())
    if (!option) return
    this.busy = true
    ctx.app.invalidate()
    try {
      await this.choose(option.value, ctx.app)
    } catch (err) {
      ctx.app.setStatus(explainError(err), 'error')
      this.busy = false
      ctx.app.invalidate()
    }
  }
}

class OptionPickerView implements View {
  readonly title: string
  readonly isTextEntry = true
  private readonly options: string[]
  private readonly optionLabels: Record<string, string>
  private readonly pick: (value: string) => void
  private readonly info: InfoPage
  private cursor = 0
  private query = ''

  constructor(label: string, options: string[], optionLabels: Record<string, string>, currentValue: string, pick: (value: string) => void, info: InfoPage) {
    this.title = `${label} options`
    this.options = options
    this.optionLabels = optionLabels
    this.pick = pick
    this.info = info
    const index = options.indexOf(currentValue)
    if (index >= 0) this.cursor = index
  }

  hints(): string[] { return ['↑/↓:move', 'type:search', 'enter:select', '?:info', 'esc:back'] }

  dispose(): void { /* no resources to release */ }

  render(ctx: ViewContext): string[] {
    const filtered = this.filtered()
    const lines = [
      ' ' + ui.title(this.title),
      ' ' + ui.muted('search ') + ui.input(`[ ${sanitizeAnsi(this.query) || 'type to filter'} ]`),
    ]
    if (filtered.length === 0) {
      lines.push(' ' + ui.muted('No matches. Backspace clears the search.'))
      return lines
    }
    const visible = Math.max(1, ctx.size.rows - lines.length)
    this.cursor = Math.min(this.cursor, filtered.length - 1)
    for (let i = 0; i < Math.min(filtered.length, visible); i++) {
      const value = filtered[i]!
      const label = value ? this.optionLabels[value] ?? value : '<empty>'
      const text = sanitizeAnsi(label)
      lines.push(i === this.cursor ? ui.selected(' ' + text + ' ') : ' ' + text)
    }
    return lines
  }

  onKey(key: Key, ctx: ViewContext): void {
    const filtered = this.filtered()
    const last = Math.max(0, filtered.length - 1)
    if (key === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down') { this.cursor = Math.min(last, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(last, this.cursor + 10); return }
    if (key === 'home') { this.cursor = 0; return }
    if (key === 'end') { this.cursor = last; return }
    if (key === 'backspace') {
      this.query = this.query.slice(0, -1)
      this.cursor = Math.min(this.cursor, Math.max(0, this.filtered().length - 1))
      return
    }
    if (key === 'esc' || key === 'left') { ctx.app.pop(); return }
    if (key === '?') {
      const value = filtered[this.cursor]
      openInfo(ctx.app, {
        ...this.info,
        title: value ? `${this.info.title}: ${this.optionLabel(value)}` : this.info.title,
        after: `Selecting this option sets ${this.info.title} to ${value ? this.optionLabels[value] ?? value : '<empty>'}.`,
      })
      return
    }
    if (key === 'enter') {
      const value = filtered[this.cursor]
      if (value === undefined) return
      this.pick(value)
      ctx.app.pop()
      ctx.app.setStatus(`selected ${value ? this.optionLabels[value] ?? value : '<empty>'}`)
      return
    }
    const text = textInput(key, false)
    if (text !== undefined) {
      this.query += text
      this.cursor = 0
    }
  }

  private filtered(): string[] {
    const query = this.query.trim().toLowerCase()
    if (!query) return this.options
    return this.options.filter((option) => option.toLowerCase().includes(query) || (this.optionLabels[option] ?? '').toLowerCase().includes(query))
  }

  private optionLabel(value: string): string {
    return this.optionLabels[value] ?? value
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
    if (this.absolutePrompt !== undefined) return ['enter:open', '?:info', 'esc:cancel']
    return ['j/k:move', 'enter:open/pick', 'h/bs:up', ':abs', '?:info', 'esc:cancel']
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
      if (key === '?') {
        openInfo(ctx.app, fileInfo())
        return
      }
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
    if (key === '?') {
      openInfo(ctx.app, fileInfo())
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

function fileInfo(): InfoPage {
  return infoPage({
    title: 'File picker',
    meaning: 'Choose a local file for policy content or provider JSON.',
    when: 'Use it when the source is maintained outside the Console.',
    impact: 'The selected file is read at submit time and its contents are sent for the selected object.',
    example: '/home/richard/pied-piper/policies/pipernet.rego',
    valid: 'Pick a file under the current directory, or press : and enter an absolute path.',
    after: 'The selected path is placed into the form; submit reads the file content once.',
    terms: [
      { label: 'Policy file', value: 'Rego source that is validated or saved as a policy version.' },
      { label: 'Provider JSON', value: 'Structured provider-specific configuration merged with form fields.' },
    ],
  })
}

function dependencyIncludes(dependency: FieldDependency | undefined, key: string): boolean {
  if (!dependency) return false
  if (typeof dependency === 'string') return dependency === key
  if (Array.isArray(dependency)) return dependency.includes(key)
  return Object.hasOwn(dependency, key)
}
