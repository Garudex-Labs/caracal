// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Grouped multi-select picker for Control API permission scopes.

import type { ControlPermission } from '@caracalai/engine'
import { pad, sanitizeAnsi, truncate, ui } from '../ansi.ts'
import { action, composeActions, type FooterAction } from '../actions.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { openInfo, type InfoPage } from './info.ts'

interface ScopeLeaf {
  scope: string
  action: string
  operations: string[]
}

interface ScopeGroup {
  command: string
  wildcard: string
  children: ScopeLeaf[]
}

interface VisibleRow {
  group: ScopeGroup
  leaf?: ScopeLeaf
}

export interface ScopePickerOptions {
  title: string
  permissions: readonly ControlPermission[]
  selected: readonly string[]
  onSave: (scopes: string[]) => void | Promise<void>
}

const toggleScope = action({ id: 'scope-toggle', key: 'space', label: 'toggle', priority: 'primary', group: 'workflow' })
const revealGroup = action({ id: 'scope-reveal', key: '→', label: 'reveal', priority: 'primary', group: 'workflow' })
const collapseGroup = action({ id: 'scope-collapse', key: '←', label: 'collapse', priority: 'secondary', group: 'secondary' })
const saveScopes = action({ id: 'scope-save', key: 'enter', label: 'save', priority: 'primary', group: 'workflow' })
const moveScopes = action({ id: 'scope-move', key: '↑/↓', label: 'move', priority: 'secondary', group: 'secondary' })
const infoScopes = action({ id: 'scope-info', key: '?', label: 'help', priority: 'secondary', group: 'secondary' })
const backScopes = action({ id: 'scope-back', key: 'esc', label: 'back', priority: 'secondary', group: 'navigation' })

export class ScopePickerView implements View {
  readonly title: string
  private readonly groups: ScopeGroup[]
  private readonly selected: Set<string>
  private readonly expanded = new Set<string>()
  private readonly onSave: (scopes: string[]) => void | Promise<void>
  private cursor = 0
  private offset = 0

  constructor(opts: ScopePickerOptions) {
    this.title = opts.title
    this.groups = buildGroups(opts.permissions)
    this.selected = new Set(opts.selected)
    this.onSave = opts.onSave
  }

  hints(): string[] {
    return ['↑/↓:move', 'space:toggle', '→:reveal', '←:collapse', 'enter:save', '?:info', 'esc:back']
  }

  footerActions(): readonly FooterAction[] {
    return composeActions([moveScopes, toggleScope, revealGroup, collapseGroup, saveScopes, infoScopes, backScopes])
  }

  render(ctx: ViewContext): string[] {
    const rows = this.visible()
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1)
    const lines: string[] = [
      ' ' + ui.title(this.title),
      ' ' + ui.muted(`${this.selected.size} scope${this.selected.size === 1 ? '' : 's'} selected — toggle a group to grant every action, or reveal it to choose individual actions`),
      '',
    ]
    const visibleCount = Math.max(1, Math.min(rows.length, ctx.size.rows - lines.length))
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visibleCount) this.offset = this.cursor - visibleCount + 1
    for (let i = this.offset; i < Math.min(rows.length, this.offset + visibleCount); i++) {
      lines.push(this.renderRow(rows[i]!, i === this.cursor, ctx.size.cols))
    }
    if (rows.length > visibleCount) lines.push(' ' + ui.muted(`showing ${visibleCount} of ${rows.length} rows`))
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const rows = this.visible()
    const last = Math.max(0, rows.length - 1)
    if (key === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down') { this.cursor = Math.min(last, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(last, this.cursor + 10); return }
    if (key === 'home') { this.cursor = 0; return }
    if (key === 'end') { this.cursor = last; return }
    if (key === '?') { this.openHelp(ctx.app); return }
    const row = rows[this.cursor]
    if (!row) {
      if (key === 'enter' || key === 'esc' || key === 'left') await this.commit(ctx.app)
      return
    }
    if (key === 'space') { this.toggle(row); return }
    if (key === 'right') {
      if (!row.leaf) this.expanded.add(row.group.command)
      return
    }
    if (key === 'left') {
      if (this.expanded.has(row.group.command)) {
        this.expanded.delete(row.group.command)
        this.cursor = this.groupIndex(row.group)
        return
      }
      await this.commit(ctx.app)
      return
    }
    if (key === 'enter' || key === 'esc') { await this.commit(ctx.app); return }
  }

  private visible(): VisibleRow[] {
    const rows: VisibleRow[] = []
    for (const group of this.groups) {
      rows.push({ group })
      if (this.expanded.has(group.command)) {
        for (const leaf of group.children) rows.push({ group, leaf })
      }
    }
    return rows
  }

  private groupIndex(group: ScopeGroup): number {
    return this.visible().findIndex((row) => row.group === group && !row.leaf)
  }

  private toggle(row: VisibleRow): void {
    if (row.leaf) {
      if (this.selected.has(row.leaf.scope)) this.selected.delete(row.leaf.scope)
      else this.selected.add(row.leaf.scope)
      return
    }
    const full = row.group.children.every((leaf) => this.selected.has(leaf.scope))
    for (const leaf of row.group.children) {
      if (full) this.selected.delete(leaf.scope)
      else this.selected.add(leaf.scope)
    }
  }

  private async commit(app: App): Promise<void> {
    await this.onSave([...this.selected].sort())
    app.pop()
    app.setStatus(`selected ${this.selected.size} control scope${this.selected.size === 1 ? '' : 's'}`)
  }

  private renderRow(row: VisibleRow, active: boolean, cols: number): string {
    const mark = active ? ui.accent('>') : ' '
    if (!row.leaf) {
      const selected = row.group.children.filter((leaf) => this.selected.has(leaf.scope)).length
      const total = row.group.children.length
      const box = selected === 0 ? '[ ]' : selected === total ? ui.success('[x]') : ui.warn('[~]')
      const arrow = this.expanded.has(row.group.command) ? '▾' : '▸'
      const verbs = row.group.children.map((leaf) => leaf.action).join(', ')
      const head = `${box} ${arrow} ${pad(row.group.wildcard, 26)}`
      const detail = ui.muted(`${selected}/${total} actions: ${verbs}`)
      return ` ${mark} ${head}${truncate(detail, Math.max(10, cols - 36))}`
    }
    const box = this.selected.has(row.leaf.scope) ? ui.success('[x]') : '[ ]'
    const head = `${box} ${pad(sanitizeAnsi(row.leaf.scope), 30)}`
    const detail = ui.muted(`covers: ${row.leaf.operations.join(', ') || row.leaf.action}`)
    return `   ${mark}   ${head}${truncate(detail, Math.max(10, cols - 42))}`
  }

  private openHelp(app: App): void {
    openInfo(app, scopeHelp(this.selected.size))
  }
}

function buildGroups(permissions: readonly ControlPermission[]): ScopeGroup[] {
  const byCommand = new Map<string, Map<string, ScopeLeaf>>()
  for (const permission of permissions) {
    let leaves = byCommand.get(permission.command)
    if (!leaves) {
      leaves = new Map()
      byCommand.set(permission.command, leaves)
    }
    let leaf = leaves.get(permission.scope)
    if (!leaf) {
      leaf = { scope: permission.scope, action: permission.action, operations: [] }
      leaves.set(permission.scope, leaf)
    }
    if (permission.subcommand && !leaf.operations.includes(permission.subcommand)) {
      leaf.operations.push(permission.subcommand)
    }
  }
  return [...byCommand.entries()]
    .map(([command, leaves]) => ({
      command,
      wildcard: `control:${command}:*`,
      children: [...leaves.values()].sort((left, right) => left.scope.localeCompare(right.scope)),
    }))
    .sort((left, right) => left.command.localeCompare(right.command))
}

function scopeHelp(count: number): InfoPage {
  return {
    title: 'Control permissions',
    meaning: 'Each scope is one command/action pair a Control API key may invoke, such as control:agent:read.',
    when: 'Grant the least set of scopes the automation needs; a key can never exceed the scopes selected here.',
    impact: 'Selecting a group grants every action under that command; revealing a group lets you grant single actions.',
    example: 'control:agent:* grants read, write, and delete on agent sessions.',
    valid: 'Toggle groups or revealed actions with space; press enter or esc to keep the selection.',
    after: `${count} scope${count === 1 ? '' : 's'} will be written to the key when you submit the form.`,
    terms: [
      { label: 'Group', value: 'All actions for one command, shown as control:<command>:*.' },
      { label: 'Action', value: 'A single verb (read, write, or delete) the key is allowed to call.' },
    ],
  }
}
