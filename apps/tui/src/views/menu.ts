// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Top-level menu listing every resource the TUI can navigate.

import type { AdminClient, Zone } from '@caracalai/admin'
import { ansi } from '../ansi.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import {
  agentsView,
  applicationsView,
  auditView,
  grantsView,
  policiesView,
  policySetsView,
  providersView,
  resourcesView,
  sessionsView,
  zonesView,
  type Ctx,
} from './factory.ts'

interface Entry {
  key: string
  label: string
  needsZone: boolean
  open: (ctx: Ctx) => View
}

const ENTRIES: Entry[] = [
  { key: '1', label: 'Zones',        needsZone: false, open: zonesView },
  { key: '2', label: 'Applications', needsZone: true,  open: applicationsView },
  { key: '3', label: 'Resources',    needsZone: true,  open: resourcesView },
  { key: '4', label: 'Providers',    needsZone: true,  open: providersView },
  { key: '5', label: 'Policies',     needsZone: true,  open: policiesView },
  { key: '6', label: 'Policy-sets',  needsZone: true,  open: policySetsView },
  { key: '7', label: 'Grants',       needsZone: true,  open: grantsView },
  { key: '8', label: 'Sessions',     needsZone: true,  open: sessionsView },
  { key: '9', label: 'Audit (live)', needsZone: true,  open: auditView },
  { key: '0', label: 'Agents',       needsZone: true,  open: agentsView },
]

export class MenuView implements View {
  readonly title = 'menu'
  private readonly client: AdminClient
  private zoneId: string | undefined
  private cursor = 0

  constructor(client: AdminClient, zoneId: string | undefined) {
    this.client = client
    this.zoneId = zoneId
  }

  hints(): string[] {
    return ['↑/↓ or 0-9:select', 'enter:open', 'z:set-zone']
  }

  currentZoneId(): string | undefined { return this.zoneId }

  setZone(id: string, slug: string | undefined, app: App): void {
    this.zoneId = id
    app.setStatus(`zone set to ${slug ?? id}`)
    app.invalidate()
  }

  render(_ctx: ViewContext): string[] {
    const lines: string[] = []
    lines.push('')
    lines.push(' ' + ansi.bold + 'Caracal' + ansi.reset + ansi.dim + '  Inspect the OSS stack interactively.' + ansi.reset)
    lines.push('')
    const zone = this.zoneId ? ansi.fg(76) + this.zoneId + ansi.reset : ansi.fg(214) + '(no zone selected)' + ansi.reset
    lines.push(' zone: ' + zone)
    lines.push('')
    for (let i = 0; i < ENTRIES.length; i++) {
      const e = ENTRIES[i]!
      const disabled = e.needsZone && !this.zoneId
      const label = `[${e.key}] ${e.label}` + (disabled ? ansi.dim + '  (zone required)' + ansi.reset : '')
      const prefix = i === this.cursor ? ansi.invert + ' ' : '  '
      const suffix = i === this.cursor ? ' ' + ansi.reset : ''
      lines.push(prefix + label + suffix)
    }
    lines.push('')
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(ENTRIES.length - 1, this.cursor + 1); return }
    const numeric = ENTRIES.findIndex((e) => e.key === key)
    if (numeric >= 0) { this.cursor = numeric; this.open(ctx.app); return }
    if (key === 'enter') { this.open(ctx.app); return }
    if (key === 'z') return this.promptZone(ctx.app)
  }

  private open(app: App): void {
    const e = ENTRIES[this.cursor]!
    if (e.needsZone && !this.zoneId) {
      app.setStatus('zone required — press z to set one or pick Zones first', 'error')
      return
    }
    app.push(e.open({
      client: this.client,
      zoneId: this.zoneId ?? '',
      onZoneSelect: (id, slug) => this.setZone(id, slug, app),
    }))
  }

  private async promptZone(app: App): Promise<void> {
    try {
      const zones = await this.client.zones.list()
      if (zones.length === 0) { app.setStatus('no zones found — run `caracal init`', 'error'); return }
      app.push(new ZonePickerView(zones, (id, slug) => this.setZone(id, slug, app)))
    } catch (err) {
      app.setStatus(`zone list: ${explainError(err)}`, 'error')
    }
  }
}

class ZonePickerView implements View {
  readonly title = 'select zone'
  private cursor = 0
  private offset = 0
  private readonly zones: Zone[]
  private readonly pick: (id: string, slug: string) => void

  constructor(zones: Zone[], pick: (id: string, slug: string) => void) {
    this.zones = zones
    this.pick = pick
  }

  hints(): string[] { return ['↑/↓:move', 'enter:select', 'h:back'] }

  render(ctx: ViewContext): string[] {
    const lines: string[] = ['', ' Pick a zone to administer:']
    const visible = Math.max(1, ctx.size.rows - 2)
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(this.zones.length, this.offset + visible); i++) {
      const z = this.zones[i]!
      const text = `${z.slug.padEnd(20)} ${z.id}  ${z.name ?? ''}`
      lines.push(i === this.cursor ? ansi.invert + ' ' + text + ' ' + ansi.reset : ' ' + text)
    }
    return lines
  }

  onKey(key: Key, ctx: ViewContext): void {
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(this.zones.length - 1, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(this.zones.length - 1, this.cursor + 10); return }
    if (key === 'home' || key === 'g') { this.cursor = 0; return }
    if (key === 'end' || key === 'G') { this.cursor = this.zones.length - 1; return }
    if (key === 'enter') {
      const z = this.zones[this.cursor]!
      this.pick(z.id, z.slug)
      ctx.app.pop()
      return
    }
    if (key === 'left' || key === 'h' || key === 'esc') ctx.app.pop()
  }
}
