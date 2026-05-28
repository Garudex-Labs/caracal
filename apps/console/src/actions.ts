// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Declarative command action registry and responsive footer renderer.

import { pad, ui, visibleLength } from './ansi.ts'

export type ActionPriority = 'primary' | 'secondary' | 'utility'
export type ActionGroup = 'workflow' | 'secondary' | 'navigation' | 'utility'
export type SelectionState = 'none' | 'single' | 'multiple'
export type ActionFlag = 'loading' | 'readonly' | 'protected_entity' | 'error' | 'advanced' | 'debug'

export interface ActionContext {
  selection?: SelectionState
  flags?: readonly ActionFlag[]
  capabilities?: readonly string[]
  permissions?: readonly string[]
  expanded?: boolean
}

export interface ActionDefinition {
  id: string
  key: string
  label: string
  priority: ActionPriority
  group?: ActionGroup
  description?: string
  requiresSelection?: boolean | SelectionState
  requiredCapabilities?: readonly string[]
  permissions?: readonly string[]
  hiddenWhen?: readonly ActionFlag[]
  disabledWhen?: readonly ActionFlag[]
  visibleWhen?: (ctx: ActionContext) => boolean
  enabledWhen?: (ctx: ActionContext) => boolean
  order?: number
}

export interface FooterAction extends ActionDefinition {
  disabled: boolean
}

export interface FooterRenderOptions {
  width: number
}

const priorityRank: Record<ActionPriority, number> = {
  primary: 0,
  secondary: 1,
  utility: 2,
}

const groupRank: Record<ActionGroup, number> = {
  workflow: 0,
  secondary: 1,
  navigation: 2,
  utility: 3,
}

let registryOrder = 0

function defineAction(action: Omit<ActionDefinition, 'order'>): ActionDefinition {
  return { ...action, order: registryOrder++ }
}

export const actions = {
  move: defineAction({ id: 'move', key: '↑/↓', label: 'move', priority: 'secondary', group: 'secondary', requiresSelection: true }),
  scroll: defineAction({ id: 'scroll', key: '↑/↓', label: 'scroll', priority: 'secondary', group: 'secondary' }),
  search: defineAction({ id: 'search', key: 'type', label: 'search', priority: 'primary', group: 'workflow' }),
  open: defineAction({ id: 'open', key: 'enter', label: 'open', priority: 'primary', group: 'workflow', requiresSelection: true }),
  select: defineAction({ id: 'select', key: 'enter', label: 'select', priority: 'primary', group: 'workflow', requiresSelection: true }),
  submit: defineAction({ id: 'submit', key: 'enter', label: 'submit', priority: 'primary', group: 'workflow' }),
  confirm: defineAction({ id: 'confirm', key: 'y', label: 'yes', priority: 'primary', group: 'workflow' }),
  new: defineAction({ id: 'new', key: 'n', label: 'new', priority: 'primary', group: 'workflow', hiddenWhen: ['loading'] }),
  edit: defineAction({ id: 'edit', key: 'e', label: 'edit', priority: 'primary', group: 'workflow', requiresSelection: true, hiddenWhen: ['loading', 'readonly'] }),
  delete: defineAction({ id: 'delete', key: 'd', label: 'delete', priority: 'primary', group: 'workflow', requiresSelection: true, hiddenWhen: ['loading', 'readonly', 'protected_entity'] }),
  reload: defineAction({ id: 'reload', key: 'r', label: 'reload', priority: 'secondary', group: 'secondary', hiddenWhen: ['loading'] }),
  info: defineAction({ id: 'info', key: '?', label: 'help', priority: 'secondary', group: 'secondary' }),
  revealId: defineAction({ id: 'reveal-id', key: 'V', label: 'reveal-id', priority: 'utility', group: 'utility', requiresSelection: true }),
  reveal: defineAction({ id: 'reveal', key: 'v', label: 'reveal', priority: 'utility', group: 'utility' }),
  mask: defineAction({ id: 'mask', key: 'v', label: 'mask', priority: 'utility', group: 'utility' }),
  copyId: defineAction({ id: 'copy-id', key: 'I', label: 'copy-id', priority: 'secondary', group: 'secondary', requiresSelection: true }),
  copyPage: defineAction({ id: 'copy-page', key: 'Y', label: 'copy-page', priority: 'secondary', group: 'secondary' }),
  copyName: defineAction({ id: 'copy-name', key: 'N', label: 'copy-name', priority: 'utility', group: 'utility', requiresSelection: true }),
  filter: defineAction({ id: 'filter', key: 'f', label: 'filter', priority: 'primary', group: 'workflow', hiddenWhen: ['loading'] }),
  back: defineAction({ id: 'back', key: 'esc', label: 'back', priority: 'secondary', group: 'navigation' }),
  cancel: defineAction({ id: 'cancel', key: 'esc', label: 'cancel', priority: 'secondary', group: 'navigation' }),
  quit: defineAction({ id: 'quit', key: 'q', label: 'quit', priority: 'secondary', group: 'navigation' }),
}

export function action(definition: Omit<ActionDefinition, 'order'>): ActionDefinition {
  return defineAction(definition)
}

export function composeActions(definitions: readonly ActionDefinition[], ctx: ActionContext = {}): FooterAction[] {
  return definitions
    .map((definition) => resolveAction(definition, ctx))
    .filter((resolved): resolved is FooterAction => Boolean(resolved))
    .sort(compareActions)
}

export function footerActionsFromHints(hints: readonly string[]): FooterAction[] {
  return composeActions(hints.map((hint, index) => actionFromHint(hint, index)))
}

export function renderActionFooter(actions: readonly FooterAction[], opts: FooterRenderOptions): string {
  const width = Math.max(0, opts.width - 1)
  const shown = [...actions]
  let hidden = 0
  while (shown.length > 0 && visibleLength(renderActions(shown, hidden)) > width) {
    const index = lowestValueIndex(shown)
    shown.splice(index, 1)
    hidden++
  }
  const text = renderActions(shown, hidden)
  return pad(' ' + text, opts.width)
}

function resolveAction(definition: ActionDefinition, ctx: ActionContext): FooterAction | undefined {
  const flags = new Set(ctx.flags ?? [])
  if (!matchesSelection(definition.requiresSelection, ctx.selection ?? 'none')) return undefined
  if (definition.hiddenWhen?.some((flag) => flags.has(flag))) return undefined
  if (!hasEvery(ctx.capabilities, definition.requiredCapabilities)) return undefined
  if (!hasEvery(ctx.permissions, definition.permissions)) return undefined
  if (definition.visibleWhen && !definition.visibleWhen(ctx)) return undefined
  const disabled = Boolean(definition.disabledWhen?.some((flag) => flags.has(flag)) || (definition.enabledWhen && !definition.enabledWhen(ctx)))
  return { ...definition, group: definition.group ?? groupFor(definition), disabled }
}

function matchesSelection(required: ActionDefinition['requiresSelection'], selection: SelectionState): boolean {
  if (!required) return true
  if (required === true) return selection !== 'none'
  return selection === required
}

function hasEvery(current: readonly string[] | undefined, required: readonly string[] | undefined): boolean {
  if (!required || required.length === 0) return true
  const available = new Set(current ?? [])
  return required.every((item) => available.has(item))
}

function compareActions(left: FooterAction, right: FooterAction): number {
  const group = groupRank[left.group ?? groupFor(left)] - groupRank[right.group ?? groupFor(right)]
  if (group !== 0) return group
  const priority = priorityRank[left.priority] - priorityRank[right.priority]
  if (priority !== 0) return priority
  return (left.order ?? 0) - (right.order ?? 0)
}

function groupFor(action: ActionDefinition): ActionGroup {
  if (action.id === 'back' || action.id === 'cancel' || action.id === 'quit') return 'navigation'
  if (action.priority === 'utility') return 'utility'
  if (action.priority === 'secondary') return 'secondary'
  return 'workflow'
}

function renderActions(list: readonly FooterAction[], hidden: number): string {
  const parts: string[] = []
  let group: ActionGroup | undefined
  for (const item of list) {
    const current = item.group ?? groupFor(item)
    if (group !== undefined && current !== group) parts.push(ui.muted('|'))
    group = current
    parts.push(renderAction(item))
  }
  if (hidden > 0) parts.push(ui.muted(`+${hidden}`))
  return parts.join('  ')
}

function renderAction(action: FooterAction): string {
  const label = ` ${action.label}`
  if (action.disabled) return ui.muted(`[${action.key}]${label}`)
  return ui.key(action.key) + ui.muted(label)
}

function lowestValueIndex(actions: readonly FooterAction[]): number {
  let index = actions.length - 1
  let rank = -1
  for (let i = 0; i < actions.length; i++) {
    const value = priorityRank[actions[i]!.priority]
    if (value >= rank) {
      rank = value
      index = i
    }
  }
  return index
}

function actionFromHint(hint: string, index: number): ActionDefinition {
  const split = hint.indexOf(':')
  const key = split > 0 ? hint.slice(0, split) : ''
  const label = split > 0 ? hint.slice(split + 1) : hint
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || key.toLowerCase() || `hint-${index}`
  return {
    id,
    key: key || label,
    label,
    priority: inferPriority(id, key, label),
    group: inferGroup(id, key, label),
    order: 1_000 + index,
  }
}

function inferPriority(id: string, key: string, label: string): ActionPriority {
  const text = `${id} ${key} ${label}`.toLowerCase()
  if (/\b(open|select|submit|create|new|yes|deploy|filter|pick)\b/.test(text)) return 'primary'
  if (/\b(reload|help|info|back|cancel|quit|move|scroll|next|page|tail)\b/.test(text)) return 'secondary'
  return 'utility'
}

function inferGroup(id: string, key: string, label: string): ActionGroup {
  const text = `${id} ${key} ${label}`.toLowerCase()
  if (/\b(back|cancel|quit|esc|no)\b/.test(text)) return 'navigation'
  if (/\b(reload|help|info|move|scroll|next|page|tail)\b/.test(text)) return 'secondary'
  if (/\b(copy|reveal|debug|advanced|strict|abs)\b/.test(text)) return 'utility'
  return 'workflow'
}
