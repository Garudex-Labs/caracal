// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the grouped multi-select Control permission picker.

import { describe, expect, it, vi } from 'vitest'
import type { App, View, ViewContext } from '../../../../apps/console/src/screen.ts'
import { ScopePickerView } from '../../../../apps/console/src/views/scopePicker.ts'

const permissions = [
  { command: 'agent', subcommand: 'list', action: 'read', scope: 'control:agent:read' },
  { command: 'agent', subcommand: 'get', action: 'read', scope: 'control:agent:read' },
  { command: 'agent', subcommand: 'suspend', action: 'write', scope: 'control:agent:write' },
  { command: 'agent', subcommand: 'terminate', action: 'delete', scope: 'control:agent:delete' },
  { command: 'policy', subcommand: 'list', action: 'read', scope: 'control:policy:read' },
  { command: 'policy', subcommand: 'create', action: 'write', scope: 'control:policy:write' },
]

function fakeApp(): App {
  return {
    invalidate: vi.fn(),
    push: vi.fn(),
    pop: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as App
}

const ctx = (app: App): ViewContext => ({ app, size: { rows: 25, cols: 120 }, status: '' })

function text(view: View, app: App): string {
  return view.render(ctx(app)).join('\n').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

describe('ScopePickerView', () => {
  it('renders collapsed wildcard groups without leaf scopes', () => {
    const app = fakeApp()
    const view = new ScopePickerView({ title: 'control permissions', permissions, selected: [], onSave: vi.fn() })
    const rendered = text(view, app)
    expect(rendered).toContain('control:agent:*')
    expect(rendered).toContain('control:policy:*')
    expect(rendered).not.toContain('control:agent:read')
  })

  it('toggles every action in a group with one keystroke and saves sorted scopes', async () => {
    const app = fakeApp()
    const onSave = vi.fn()
    const view = new ScopePickerView({ title: 'control permissions', permissions, selected: [], onSave })

    await view.onKey('space', ctx(app))
    await view.onKey('enter', ctx(app))

    expect(onSave).toHaveBeenCalledWith(['control:agent:delete', 'control:agent:read', 'control:agent:write'])
    expect(app.pop).toHaveBeenCalled()
  })

  it('reveals a group then toggles a single action', async () => {
    const app = fakeApp()
    const onSave = vi.fn()
    const view = new ScopePickerView({ title: 'control permissions', permissions, selected: [], onSave })

    await view.onKey('right', ctx(app))
    expect(text(view, app)).toContain('control:agent:read')

    await view.onKey('down', ctx(app))
    await view.onKey('space', ctx(app))
    await view.onKey('esc', ctx(app))

    expect(onSave).toHaveBeenCalledWith(['control:agent:delete'])
  })

  it('shows a partial marker when only some actions in a group are selected', () => {
    const app = fakeApp()
    const view = new ScopePickerView({ title: 'control permissions', permissions, selected: ['control:agent:read'], onSave: vi.fn() })
    const line = text(view, app).split('\n').find((row) => row.includes('control:agent:*'))
    expect(line).toContain('[~]')
    expect(line).toContain('1/3')
  })

  it('deselects a fully selected group on toggle', async () => {
    const app = fakeApp()
    const onSave = vi.fn()
    const view = new ScopePickerView({
      title: 'control permissions',
      permissions,
      selected: ['control:agent:read', 'control:agent:write', 'control:agent:delete'],
      onSave,
    })

    await view.onKey('space', ctx(app))
    await view.onKey('enter', ctx(app))

    expect(onSave).toHaveBeenCalledWith([])
  })
})
