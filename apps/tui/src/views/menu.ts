// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Top-level menu listing every resource the TUI can navigate.

import type { AdminClient, Zone } from '@caracalai/admin'
import {
  buildRunEnv,
  checkMcpGovernance,
  controlKeyCreate,
  controlKeyGet,
  controlKeyList,
  controlKeyRevoke,
  controlKeyRotate,
  credentialRead,
  runExec,
} from '@caracalai/engine'
import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'
import {
  resolveCliConfigPath,
  type CliConfig,
} from '@caracalai/engine/cli'
import { pad, truncate, ui } from '../ansi.ts'
import { explainError, maskSecretField } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { DetailView } from './detail.ts'
import { FormView } from './form.ts'
import {
  agentsView,
  applicationsView,
  auditView,
  delegationsView,
  grantsView,
  policiesView,
  policySetsView,
  providersView,
  resourcesView,
  sessionsView,
  zonesView,
  type Ctx,
} from './factory.ts'
import { StreamView } from './stream.ts'

interface Entry {
  key: string
  label: string
  group: string
  description: string
  needsZone: boolean
  open: (ctx: Ctx, app: App) => View
}

function loadCliConfig(): CliConfig | undefined {
  const path = resolveCliConfigPath()
  if (!path) return undefined
  return parse(readFileSync(path, 'utf8')) as unknown as CliConfig
}

function tokenizeArgv(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | undefined
  for (const ch of input) {
    if (ch === '\u0000') throw new Error('argv contains NUL byte')
    if (quote) {
      if (ch === quote) { quote = undefined; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ' ' || ch === '\t') {
      if (cur.length > 0) { tokens.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (quote) throw new Error('unterminated quote in argv')
  if (cur.length > 0) tokens.push(cur)
  return tokens
}

function parseEnv(list: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of list.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
    const eq = pair.indexOf('=')
    if (eq < 0) throw new Error(`env entry "${pair}" missing '='`)
    out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

const BASE_ENTRIES: Entry[] = [
  { key: '1', label: 'zone',       group: 'admin', description: 'Manage zones', needsZone: false, open: zonesView },
  { key: '2', label: 'app',        group: 'admin', description: 'Manage applications', needsZone: true, open: applicationsView },
  { key: '3', label: 'resource',   group: 'admin', description: 'Manage protected resources', needsZone: true, open: resourcesView },
  { key: '4', label: 'provider',   group: 'admin', description: 'Manage identity providers', needsZone: true, open: providersView },
  { key: '5', label: 'policy',     group: 'admin', description: 'Manage policies', needsZone: true, open: policiesView },
  { key: '6', label: 'policy-set', group: 'admin', description: 'Manage policy sets', needsZone: true, open: policySetsView },
  { key: '7', label: 'grant',      group: 'admin', description: 'Manage grants', needsZone: true, open: grantsView },
  { key: '8', label: 'session',    group: 'admin', description: 'List sessions', needsZone: true, open: sessionsView },
  { key: '9', label: 'audit',      group: 'observability', description: 'Search audit events', needsZone: true, open: auditView },
  { key: 'x', label: 'explain',    group: 'observability', description: 'Explain an audit request', needsZone: true, open: auditExplainEntry },
  { key: '0', label: 'agent',      group: 'multiagent', description: 'Manage agent sessions', needsZone: true, open: agentsView },
  { key: 'g', label: 'delegation', group: 'multiagent', description: 'Manage delegation edges', needsZone: true, open: delegationsView },
  { key: 'c', label: 'credential', group: 'runtime', description: 'Read a resource credential', needsZone: false, open: credentialEntry },
  { key: 'u', label: 'run',        group: 'runtime', description: 'Run a command with RESOURCE_TOKEN', needsZone: false, open: runEntry },
  { key: 't', label: 'control',    group: 'admin', description: 'Manage control API credentials', needsZone: true, open: controlEntry },
]

function menuEntries(): Entry[] {
  return BASE_ENTRIES
}

function auditExplainEntry(ctx: Ctx): View {
  return new FormView({
    title: 'audit explain',
    fields: [{ key: 'request_id', label: 'request_id', kind: 'text', required: true }],
    onSubmit: async (v, app) => {
      app.pop()
      app.push(new DetailView({
        title: `audit / ${v.request_id}`,
        load: () => ctx.client.audit.byRequest(ctx.zoneId, v.request_id!),
      }))
    },
  })
}

function credentialEntry(): View {
  return new FormView({
    title: 'credential read',
    fields: [
      { key: 'resource', label: 'resource', kind: 'text', required: true },
      { key: 'ttl', label: 'ttl seconds', kind: 'text' },
    ],
    onSubmit: async (v, app) => {
      const cfg = loadCliConfig()
      if (!cfg) throw new Error('caracal.toml not found')
      const ttl = v.ttl ? Number(v.ttl) : undefined
      const token = await credentialRead({ cfg, resource: v.resource!, ttlSeconds: ttl })
      app.pop()
      app.push(new DetailView({
        title: `credential / ${v.resource}`,
        load: async () => ({ resource: v.resource, access_token: token }),
        mask: maskSecretField,
      }))
    },
  })
}

function runEntry(): View {
  return new FormView({
    title: 'run',
    fields: [
      { key: 'argv', label: 'argv', kind: 'text', required: true, hint: 'space-separated argv (quotes group tokens); spawn() — not a shell — so no globbing or pipes' },
      { key: 'env', label: 'env (KEY=VAL csv)', kind: 'list' },
    ],
    onSubmit: async (v, app) => {
      const argv = tokenizeArgv(v.argv ?? '')
      if (argv.length === 0) throw new Error('argv is empty')
      const extraEnv = v.env ? parseEnv(v.env) : undefined
      const cfg = loadCliConfig()
      if (!cfg) throw new Error('caracal.toml not found')
      app.pop()
      app.push(new StreamView({
        title: `run ${argv[0]}`,
        spawn: async (onLine) => {
          checkMcpGovernance(argv, cfg, (line) => onLine(line))
          const env = await buildRunEnv(cfg, { onLine: (line) => onLine(line) })
          const handle = runExec({
            argv, env: { ...env, ...extraEnv }, onLine: (line) => onLine(line), forwardSignals: false,
          })
          return { dispose: handle.dispose, exitCode: handle.exitCode }
        },
      }))
    },
  })
}

function controlEntry(ctx: Ctx): View {
  return new ControlMenuView(ctx)
}

class ControlMenuView implements View {
  readonly title = 'control'
  private cursor = 0
  private readonly ctx: Ctx
  private readonly items: { key: string; label: string; build: () => View }[]

  constructor(ctx: Ctx) {
    this.ctx = ctx
    this.items = [
      { key: 'l', label: 'list keys',  build: () => this.listView() },
      { key: 'g', label: 'get key', build: () => this.getForm() },
      { key: 'c', label: 'create key', build: () => this.createForm() },
      { key: 'r', label: 'rotate key', build: () => this.rotateForm() },
      { key: 'v', label: 'revoke key', build: () => this.revokeForm() },
    ]
  }

  hints(): string[] { return ['↑/↓:select', 'enter:open', 'esc:back'] }

  render(_ctx: ViewContext): string[] {
    const lines: string[] = ['', ' ' + ui.title('Control API keys'), ' ' + ui.muted('Manage control API credentials for the selected zone.'), '']
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]!
      const mark = i === this.cursor ? ui.accent('>') : ' '
      lines.push(` ${mark} ${ui.key(it.key)} ${it.label}`)
    }
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (key === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(this.items.length - 1, this.cursor + 1); return }
    if (key === 'left' || key === 'esc') { ctx.app.pop(); return }
    const direct = this.items.findIndex((it) => it.key === key)
    if (direct >= 0) { ctx.app.push(this.items[direct]!.build()); return }
    if (key === 'enter') { ctx.app.push(this.items[this.cursor]!.build()) }
  }

  private listView(): View {
    return new DetailView({
      title: 'control / keys',
      load: () => controlKeyList(this.ctx.client, this.ctx.zoneId),
    })
  }

  private createForm(): View {
    const { client, zoneId } = this.ctx
    return new FormView({
      title: 'control key create',
      fields: [
        { key: 'name', label: 'name', kind: 'text', required: true },
        { key: 'client_secret', label: 'client_secret', kind: 'secret' },
      ],
      onSubmit: async (v, app) => {
        const result = await controlKeyCreate(client, zoneId, {
          name: v.name!,
          clientSecret: v.client_secret || undefined,
        })
        app.pop()
        app.push(new DetailView({
          title: `control / ${result.application.id}`,
          load: async () => ({
            id: result.application.id,
            name: result.application.name,
            client_id: result.application.id,
            client_secret: result.clientSecret,
            traits: result.application.traits,
            note: 'store client_secret now — it cannot be retrieved later',
          }),
          mask: maskSecretField,
        }))
      },
    })
  }

  private getForm(): View {
    const { client, zoneId } = this.ctx
    return new FormView({
      title: 'control key get',
      fields: [{ key: 'id', label: 'application id', kind: 'text', required: true }],
      onSubmit: async (v, app) => {
        app.pop()
        app.push(new DetailView({
          title: `control / ${v.id}`,
          load: () => controlKeyGet(client, zoneId, v.id!),
        }))
      },
    })
  }

  private rotateForm(): View {
    const { client, zoneId } = this.ctx
    return new FormView({
      title: 'control key rotate',
      fields: [{ key: 'id', label: 'application id', kind: 'text', required: true }],
      onSubmit: async (v, app) => {
        const result = await controlKeyRotate(client, zoneId, v.id!)
        app.pop()
        app.push(new DetailView({
          title: `control / ${result.application.id}`,
          load: async () => ({
            id: result.application.id,
            client_secret: result.clientSecret,
            note: 'store client_secret now — it cannot be retrieved later',
          }),
          mask: maskSecretField,
        }))
      },
    })
  }

  private revokeForm(): View {
    const { client, zoneId } = this.ctx
    return new FormView({
      title: 'control key revoke',
      fields: [{ key: 'id', label: 'application id', kind: 'text', required: true }],
      onSubmit: async (v, app) => {
        await controlKeyRevoke(client, zoneId, v.id!)
        app.pop()
        app.setStatus(`revoked control key ${v.id}`)
      },
    })
  }
}

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
    return ['↑/↓ or hot-key:select', 'enter:open', 'z:set-zone']
  }

  currentZoneId(): string | undefined { return this.zoneId }

  async init(app: App): Promise<void> {
    if (!this.zoneId) return
    try {
      await this.client.zones.get(this.zoneId)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 404) {
        const stale = this.zoneId
        this.zoneId = undefined
        app.setStatus(`configured zone ${stale} no longer exists — press z to pick another or open Zones to create one`, 'error')
        app.invalidate()
      }
    }
  }

  setZone(id: string, slug: string | undefined, app: App): void {
    this.zoneId = id
    app.setStatus(`zone set to ${slug ?? id}`)
    app.invalidate()
  }

  render(_ctx: ViewContext): string[] {
    const lines: string[] = []
    lines.push('')
    lines.push(' ' + ui.title('Caracal') + '  ' + ui.muted('Inspect and manage identity resources.'))
    const zone = this.zoneId ? ui.success(this.zoneId) : ui.warn('no zone selected')
    lines.push(' ' + ui.muted('zone') + '  ' + zone)
    lines.push(' ' + ui.muted('Use arrow keys or hotkeys. Press z to choose a zone.'))
    lines.push('')
    let group = ''
    const entries = menuEntries()
    if (this.cursor >= entries.length) this.cursor = Math.max(0, entries.length - 1)
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      if (e.group !== group) {
        group = e.group
        lines.push(' ' + ui.accent(group))
      }
      const disabled = e.needsZone && !this.zoneId
      const mark = i === this.cursor ? ui.accent('>') : ' '
      const label = pad(e.label, 12)
      const disabledText = disabled ? '  ' + ui.warn('zone required') : ''
      lines.push(` ${mark} ${ui.key(e.key)} ${label} ${ui.muted(e.description)}${disabledText}`)
    }
    lines.push('')
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const entries = menuEntries()
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(entries.length - 1, this.cursor + 1); return }
    const direct = entries.findIndex((e) => e.key === key)
    if (direct >= 0) { this.cursor = direct; this.open(ctx.app); return }
    if (key === 'enter') { this.open(ctx.app); return }
    if (key === 'z') return this.promptZone(ctx.app)
  }

  private open(app: App): void {
    const entries = menuEntries()
    const e = entries[this.cursor]!
    if (e.needsZone && !this.zoneId) {
      app.setStatus('zone required — press z to set one or pick Zones first', 'error')
      return
    }
    const ctx: Ctx = {
      client: this.client,
      zoneId: this.zoneId ?? '',
      onZoneSelect: (id, slug) => this.setZone(id, slug, app),
    }
    app.push(e.open(ctx, app))
  }

  private async promptZone(app: App): Promise<void> {
    try {
      const zones = await this.client.zones.list()
      if (zones.length === 0) { app.setStatus('no zones — open Zones (n) to create one, or run `caracal zone create --name <n>`', 'error'); return }
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

  hints(): string[] { return ['↑/↓:move', 'enter:select', 'esc:back'] }

  render(ctx: ViewContext): string[] {
    const lines: string[] = ['', ' ' + ui.title('Pick a zone to administer'), '']
    const visible = Math.max(1, ctx.size.rows - 2)
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(this.zones.length, this.offset + visible); i++) {
      const z = this.zones[i]!
      const mark = i === this.cursor ? ui.accent('>') : ' '
      const text = `${pad(z.slug, 20)} ${ui.muted(z.id)}  ${truncate(z.name ?? '', Math.max(10, ctx.size.cols - 60))}`
      lines.push(` ${mark} ${text}`)
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
    if (key === 'left' || key === 'esc') ctx.app.pop()
  }
}

// Resolved at module load — referenced via ENTRIES so tokenizer is testable.
export const __testInternals = { tokenizeArgv, parseEnv }
