// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Generic scrollable list view with column rendering and selection.

import { ansi, copyToClipboard, pad, truncate, ui } from '../ansi.ts'
import { actions, composeActions, type ActionDefinition, type ActionFlag, type ActionPriority, type FooterAction } from '../actions.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import type { ConsoleStateStore } from '../state.ts'
import { actionInfo, openInfo, type InfoPage } from './info.ts'

export interface Column<T> {
  header: string
  width?: number
  value: (row: T) => string
}

export interface ListAction<T> {
  key: string
  label: string
  build: (row: T | undefined, app: App) => View | Promise<View>
  info?: InfoPage
  id?: string
  description?: string
  priority?: ActionPriority
  requiresSelection?: boolean
  hiddenWhen?: readonly ActionFlag[]
  disabledWhen?: readonly ActionFlag[]
  requiredCapabilities?: readonly string[]
  permissions?: readonly string[]
  visible?: (row: T | undefined) => boolean
  enabled?: (row: T | undefined) => boolean
}

export interface ListOptions<T> {
  title: string
  columns: Column<T>[]
  load: () => Promise<T[]>
  onEnter?: (app: App, row: T) => void | Promise<void>
  actions?: ListAction<T>[]
  state?: ConsoleStateStore | undefined
  stateKey?: string
  zoneId?: string
  rowKey?: (row: T) => string
  rowId?: (row: T) => string
  rowName?: (row: T) => string
  info?: InfoPage
  showInfoAction?: boolean
  showIdentityActions?: boolean
  readonly?: boolean
  capabilities?: readonly string[]
  permissions?: readonly string[]
  entityFlags?: (row: T) => readonly ActionFlag[]
}

export class ListView<T> implements View {
  readonly title: string
  private readonly columns: Column<T>[]
  private readonly loader: () => Promise<T[]>
  private readonly enter?: (app: App, row: T) => void | Promise<void>
  private readonly actions: ListAction<T>[]
  private readonly state?: ConsoleStateStore
  private readonly stateKey?: string
  private readonly zoneId?: string
  private readonly rowKey?: (row: T) => string
  private readonly rowId?: (row: T) => string
  private readonly rowName?: (row: T) => string
  private readonly info: InfoPage
  private readonly showInfoAction: boolean
  private readonly showIdentityActions: boolean
  private readonly readonlyMode: boolean
  private readonly capabilities?: readonly string[]
  private readonly permissions?: readonly string[]
  private readonly entityFlags?: (row: T) => readonly ActionFlag[]
  private rows: T[] = []
  private cursor = 0
  private offset = 0
  private loading = true
  private error: string | undefined
  private showIds = false
  private aborted = false
  private app: App | undefined

  constructor(opts: ListOptions<T>) {
    this.title = opts.title
    this.columns = opts.columns
    this.loader = opts.load
    this.enter = opts.onEnter
    this.actions = opts.actions ?? []
    this.state = opts.state
    this.stateKey = opts.stateKey
    this.zoneId = opts.zoneId
    this.rowKey = opts.rowKey
    this.rowId = opts.rowId
    this.rowName = opts.rowName
    this.info = opts.info ?? actionInfo(opts.title, 'Opening a row shows details; action keys create, edit, delete, or operate on the selected record.')
    this.showInfoAction = opts.showInfoAction === true
    this.showIdentityActions = opts.showIdentityActions === true
    this.readonlyMode = opts.readonly === true
    this.capabilities = opts.capabilities
    this.permissions = opts.permissions
    this.entityFlags = opts.entityFlags
  }

  selected(): T | undefined { return this.rows[this.cursor] }

  hints(): string[] {
    const base = ['↑/↓:move', 'enter:open', 'r:reload', 'esc:back']
    for (const a of this.actions) base.push(`${a.key}:${a.label}`)
    if (this.showInfoAction) base.push('?:info')
    if (this.showIdentityActions && this.rowId) base.push('V:reveal-id', 'I:copy-id')
    if (this.showIdentityActions && this.rowName) base.push('N:copy-name')
    return base
  }

  footerActions(): readonly FooterAction[] {
    return composeActions(this.actionDefinitions(), this.actionContext())
  }

  async init(app: App): Promise<void> { this.app = app; await this.reload() }

  dispose(): void { this.aborted = true }

  async reload(): Promise<void> {
    const app = this.app
    this.loading = true
    this.error = undefined
    app?.invalidate()
    try {
      const rows = await this.loader()
      if (this.aborted) return
      this.rows = rows
      const selectedId = this.stateKey ? this.state?.listSelection(this.stateKey, this.zoneId) : undefined
      const selectedIndex = selectedId && this.rowKey ? rows.findIndex((row) => this.rowKey!(row) === selectedId) : -1
      this.cursor = selectedIndex >= 0 ? selectedIndex : Math.min(this.cursor, Math.max(0, rows.length - 1))
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
    const lines: string[] = []
    if (this.loading) { lines.push(ui.muted(' loading...')); return lines }
    if (this.error) { lines.push(ui.error(' error: ' + this.error)); return lines }
    if (this.rows.length === 0) { lines.push(ui.muted(' No records found.')); return lines }
    const columns = this.renderColumns()
    const widths = this.computeWidths(ctx.size.cols, columns)
    lines.push(this.headerRow(widths))
    const visible = Math.max(1, ctx.size.rows - 1)
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(this.rows.length, this.offset + visible); i++) {
      const row = this.rows[i]!
      const text = columns
        .map((c, idx) => pad(truncate(c.value(row), widths[idx]!), widths[idx]!))
        .join('  ')
      const line = ' ' + text + ' '
      lines.push(i === this.cursor ? ui.selected(line) : line)
    }
    return lines
  }

  private renderColumns(): Column<T>[] {
    if (!this.showIds || !this.rowId) return this.columns
    return [...this.columns, { header: 'id', value: (row) => this.rowId!(row) }]
  }

  private computeWidths(cols: number, columns: Column<T>[]): number[] {
    const total = columns.reduce((sum, c) => sum + (c.width ?? 16) + 2, 0) - 2
    if (total <= cols - 4) return columns.map((c) => c.width ?? 16)
    const last = columns.length - 1
    const fixed = columns.slice(0, -1).reduce((s, c) => s + (c.width ?? 16) + 2, 0)
    const remaining = Math.max(8, cols - 4 - fixed)
    return columns.map((c, i) => (i === last ? remaining : (c.width ?? 16)))
  }

  private headerRow(widths: number[]): string {
    const text = this.renderColumns().map((c, i) => pad(c.header, widths[i]!)).join('  ')
    return ui.muted(' ' + ansi.bold + text + ansi.reset)
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const last = Math.max(0, this.rows.length - 1)
    const action = this.actions.find((a) => a.key === key)
    if (action) {
      const resolved = composeActions([this.listActionDefinition(action)], this.actionContext(false))
      if (resolved.length === 0 || resolved[0]?.disabled) return
      this.persistSelection()
      const view = await action.build(this.selected(), ctx.app)
      ctx.app.push(view)
      return
    }
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); this.persistSelection(); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(last, this.cursor + 1); this.persistSelection(); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); this.persistSelection(); return }
    if (key === 'pgdn') { this.cursor = Math.min(last, this.cursor + 10); this.persistSelection(); return }
    if (key === 'home' || key === 'g') { this.cursor = 0; this.persistSelection(); return }
    if (key === 'end' || key === 'G') { this.cursor = last; this.persistSelection(); return }
    if (key === 'r') return this.reload()
    if (key === '?') {
      openInfo(ctx.app, this.selectedInfo())
      return
    }
    if (key === 'V' && this.rowId) { this.showIds = !this.showIds; return }
    if (key === 'I' && this.rowId) { this.copyId(ctx.app); return }
    if (key === 'N' && this.rowName) { this.copyName(ctx.app); return }
    if (key === 'left' || key === 'esc') { ctx.app.pop(); return }
    if (key === 'enter') {
      const row = this.selected()
      this.persistSelection()
      if (row && this.enter) await this.enter(ctx.app, row)
    }
  }

  private persistSelection(): void {
    if (!this.state || !this.stateKey || !this.rowKey) return
    const row = this.selected()
    this.state.setListSelection(this.stateKey, row ? this.rowKey(row) : undefined, this.zoneId)
  }

  private copyId(app: App): void {
    const row = this.selected()
    if (!row || !this.rowId) return
    const id = this.rowId(row)
    copyToClipboard(id)
    app.setStatus(`copied id for ${this.rowName?.(row) ?? id}`)
  }

  private copyName(app: App): void {
    const row = this.selected()
    if (!row || !this.rowName) return
    const name = this.rowName(row)
    copyToClipboard(name)
    app.setStatus(`copied name ${name}`)
  }

  private selectedInfo(): InfoPage {
    const row = this.selected()
    const name = row && this.rowName ? this.rowName(row) : this.title
    return {
      ...this.info,
      title: row ? `${this.title}: ${name}` : this.info.title,
      context: row ? [
        ...(this.info.context ?? []),
        { label: 'Selected', value: name },
        { label: 'Rows', value: `${this.rows.length}` },
      ] : this.info.context,
      after: row
        ? 'Press enter for the full detail page, where complete entity pages can copy raw JSON with copy-page.'
        : this.info.after,
    }
  }

  private actionDefinitions(): ActionDefinition[] {
    const definitions: ActionDefinition[] = [
      actions.move,
      { ...actions.open, visibleWhen: () => Boolean(this.enter) },
      actions.reload,
      actions.back,
    ]
    if (this.showInfoAction) definitions.push(actions.info)
    for (const listAction of this.actions) definitions.push(this.listActionDefinition(listAction))
    if (this.showIdentityActions && this.rowId) definitions.push(actions.revealId, actions.copyId)
    if (this.showIdentityActions && this.rowName) definitions.push(actions.copyName)
    return definitions
  }

  private actionContext(includeLoading = true) {
    const flags: ActionFlag[] = []
    if (includeLoading && this.loading) flags.push('loading')
    if (this.readonlyMode) flags.push('readonly')
    if (this.error) flags.push('error')
    const row = this.selected()
    if (row) flags.push(...this.entityFlags?.(row) ?? [])
    return {
      selection: row ? 'single' as const : 'none' as const,
      flags,
      capabilities: this.capabilities,
      permissions: this.permissions,
    }
  }

  private listActionDefinition(listAction: ListAction<T>): ActionDefinition {
    return {
      id: listAction.id ?? actionId(listAction.label),
      key: listAction.key,
      label: listAction.label,
      description: listAction.description,
      priority: listAction.priority ?? listActionPriority(listAction),
      group: listActionGroup(listAction),
      requiresSelection: listAction.requiresSelection ?? listActionNeedsSelection(listAction),
      hiddenWhen: listAction.hiddenWhen ?? ['loading'],
      disabledWhen: listAction.disabledWhen,
      requiredCapabilities: listAction.requiredCapabilities,
      permissions: listAction.permissions,
      visibleWhen: () => listAction.visible ? listAction.visible(this.selected()) : true,
      enabledWhen: () => listAction.enabled ? listAction.enabled(this.selected()) : true,
      order: 100 + this.actions.indexOf(listAction),
    }
  }
}

function listActionNeedsSelection<T>(listAction: ListAction<T>): boolean {
  const label = listAction.label.toLowerCase()
  if (label === 'new' || label === 'filter' || label === 'validate' || label === 'dcr') return false
  return true
}

function listActionPriority<T>(listAction: ListAction<T>): ActionPriority {
  const label = listAction.label.toLowerCase()
  if (label === 'new' || label === 'edit' || label === 'delete' || label === 'filter' || label === 'activate' || label === 'revoke') return 'primary'
  if (label === 'validate' || label === 'version' || label === 'simulate' || label === 'traverse') return 'secondary'
  return 'utility'
}

function listActionGroup<T>(listAction: ListAction<T>): ActionDefinition['group'] {
  return listActionPriority(listAction) === 'utility' ? 'utility' : 'workflow'
}

function actionId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'action'
}
