// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Menu zone hotkey tests cover picker launch and selected zone application.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'

import { MenuView } from '../../../../apps/console/src/views/menu.ts'
import { ConsoleStateStore } from '../../../../apps/console/src/state.ts'
import type { App } from '../../../../apps/console/src/screen.ts'
import type { AdminClient, Zone } from '@caracalai/admin'

const dirs: string[] = []
const ansiPattern = /\u001b\[[0-9;?]*[A-Za-z]/g

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, '')
}

function stateStore(): ConsoleStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'caracal-menu-zone-'))
  dirs.push(dir)
  return new ConsoleStateStore(join(dir, 'console-state.json'))
}

function fakeApp(): App {
  const pushed: unknown[] = []
  const app = {
    invalidate: vi.fn(),
    push: vi.fn((v: unknown) => { pushed.push(v) }),
    pop: vi.fn(),
    setStatus: vi.fn(),
    current: vi.fn(),
    exit: vi.fn(async () => {}),
    replaceTop: vi.fn(),
    bannerLeft: '',
    bannerRight: '',
  } as unknown as App
  ;(app as unknown as { _pushed: unknown[] })._pushed = pushed
  return app
}

function clientWithZones(zones: Zone[]): AdminClient {
  return {
    zones: {
      list: vi.fn(async () => zones),
      get: vi.fn(async () => ({})),
    },
  } as unknown as AdminClient
}

describe('menu zone hotkey', () => {
  it('renders each top-level group as one contiguous section', () => {
    const menu = new MenuView(clientWithZones([]), 'zone-1')
    const lines = menu.render({ app: fakeApp(), size: { rows: 25, cols: 100 }, status: '' }).map(stripAnsi)
    const groups = lines
      .map((line) => line.trim())
      .filter((line) => ['start', 'manage', 'observe', 'agents', 'runtime'].includes(line))

    expect(groups).toEqual(['start', 'manage', 'observe', 'agents', 'runtime'])
  })

  it('uses ordered management numbers and semantic group hotkeys', () => {
    const menu = new MenuView(clientWithZones([]), 'zone-1')
    const rendered = menu.render({ app: fakeApp(), size: { rows: 25, cols: 100 }, status: '' }).map(stripAnsi).join('\n')

    expect(rendered).toContain(' s  guided setup')
    for (const [key, label] of [
      ['1', 'zone'],
      ['2', 'application'],
      ['3', 'provider'],
      ['4', 'resource'],
      ['5', 'policy'],
      ['6', 'policy set'],
      ['7', 'grant'],
      ['8', 'session'],
      ['9', 'control'],
    ]) {
      expect(rendered).toContain(` ${key}  ${label}`)
    }
    expect(rendered).toContain(' a  audit')
    expect(rendered).toContain(' e  explain')
    expect(rendered).toContain(' r  agent session')
    expect(rendered).toContain(' g  delegation')
    expect(rendered).toContain(' d  diagnostics')
    expect(rendered).not.toContain(' c  credential')
  })

  it('opens operationally useful contextual menu help', async () => {
    const app = fakeApp()
    const menu = new MenuView(clientWithZones([]), 'zone-1')

    await menu.onKey('?', { app, size: { rows: 25, cols: 100 }, status: '' })

    const pushed = (app as unknown as { _pushed: Array<{ render: typeof menu.render }> })._pushed
    const help = pushed[pushed.length - 1]!.render({ app, size: { rows: 25, cols: 100 }, status: '' }).map(stripAnsi).join('\n')
    expect(help).toContain('Impact')
    expect(help).toContain('Context')
    expect(help).toContain('Current zone')
    expect(help).toContain('Operational notes')
  })

  it('opens the zone picker with z and applies the selected zone', async () => {
    const client = clientWithZones([
      { id: 'z1', slug: 'alpha', name: 'Alpha' },
      { id: 'z2', slug: 'beta', name: 'Beta' },
    ] as Zone[])
    const menu = new MenuView(client, undefined)
    const app = fakeApp()

    await menu.onKey('z', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const picker = pushed[pushed.length - 1] as { title: string; onKey: MenuView['onKey'] }

    expect(client.zones.list).toHaveBeenCalledOnce()
    expect(picker.title).toBe('select zone')

    await picker.onKey('down', { app, size: { rows: 25, cols: 80 }, status: '' })
    await picker.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    expect(menu.currentZoneId()).toBe('z2')
    expect(app.setStatus).toHaveBeenCalledWith('zone set to beta')
    expect(app.pop).toHaveBeenCalledOnce()
  })

  it('persists the explicitly selected zone', async () => {
    const client = clientWithZones([
      { id: 'z1', slug: 'alpha', name: 'Alpha' },
      { id: 'z2', slug: 'beta', name: 'Beta' },
    ] as Zone[])
    const state = stateStore()
    const menu = new MenuView(client, undefined, state)
    const app = fakeApp()

    await menu.onKey('z', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const picker = pushed[pushed.length - 1] as { title: string; onKey: MenuView['onKey'] }
    await picker.onKey('down', { app, size: { rows: 25, cols: 80 }, status: '' })
    await picker.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    expect(state.selectedZoneId()).toBe('z2')
    expect(state.selectedZoneSlug()).toBe('beta')
  })

  it('opens the zone picker with uppercase Z', async () => {
    const client = clientWithZones([{ id: 'z1', slug: 'alpha', name: 'Alpha' }] as Zone[])
    const menu = new MenuView(client, undefined)
    const app = fakeApp()

    await menu.onKey('Z', { app, size: { rows: 25, cols: 80 }, status: '' })

    expect(client.zones.list).toHaveBeenCalledOnce()
    expect(app.push).toHaveBeenCalledWith(expect.objectContaining({ title: 'select zone' }))
  })
})
