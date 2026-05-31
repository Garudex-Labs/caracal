// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Top-level menu listing every resource the Console can navigate.

import type { AdminClient, Zone } from '@caracalai/admin'
import {
  applyControlLifecycleAction,
  authorizeControlManagementAccess,
  controlKeyCreate,
  controlKeyGet,
  controlKeyList,
  controlKeyRevoke,
  controlKeyRotate,
  controlPermissions,
  controlServiceStatus,
  DEFAULT_CONTROL_AUDIENCE,
  credentialRead,
  readControlState,
  resolveStackPaths,
  type ControlLifecycleAction,
  type ControlLifecycleResult,
  type ControlKeyRecord,
  type ControlServiceStatus,
  type StackMode,
  type StackPaths,
} from '@caracalai/engine'
import {
  resolveStsUrl,
} from '@caracalai/engine/runtime-config'
import { pad, ui } from '../ansi.ts'
import { explainError, maskSecretField } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import type { ConsoleStateStore } from '../state.ts'
import { DetailView } from './detail.ts'
import { DoctorView } from './doctor.ts'
import { ConfirmView, FormView, type Field } from './form.ts'
import { actionInfo, infoPage, openInfo, type InfoPage } from './info.ts'
import { firstSetupView } from './setup.ts'
import { appendCsv, EntityPickerView, pickFromList } from './picker.ts'
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
import { CARACAL_CONSOLE_MODE, CARACAL_CONSOLE_SHA, CARACAL_CONSOLE_VERSION } from '../version.gen.ts'

interface Entry {
  key: string
  label: string
  group: string
  description: string
  needsZone: boolean
  open: (ctx: Ctx, app: App) => View
  info?: InfoPage
}

function controlAudience(): string {
  return process.env.CONTROL_AUDIENCE ?? DEFAULT_CONTROL_AUDIENCE
}

function resolveControlStackMode(): StackMode {
  const override = process.env.CARACAL_MODE
  if (override === 'dev' || override === 'rc' || override === 'stable') return override
  if (override) throw new Error(`CARACAL_MODE must be 'dev', 'rc', or 'stable' (got '${override}')`)
  return CARACAL_CONSOLE_MODE
}

function controlComposeEnv(paths: StackPaths): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    CARACAL_MODE: paths.mode,
    CARACAL_SECRETS_DIR: paths.secretsDir,
  }
  if (paths.mode !== 'dev') {
    env.CARACAL_VERSION = CARACAL_CONSOLE_VERSION
    env.CARACAL_REGISTRY = process.env.CARACAL_REGISTRY
  } else {
    env.CARACAL_DEV_SHA = CARACAL_CONSOLE_SHA
    env.CARACAL_DEV_VERSION = CARACAL_CONSOLE_VERSION
  }
  return env
}

function splitList(list: string): string[] {
  return list.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

const BASE_ENTRIES: Entry[] = [
  { key: 's', label: 'guided setup', group: 'start', description: 'Create the first agent app, protected resource, access policy, and runtime profile', needsZone: false, open: firstSetupView },
  { key: '1', label: 'zone',       group: 'manage', description: 'Manage zones', needsZone: false, open: zonesView },
  { key: '2', label: 'application', group: 'manage', description: 'Manage agent applications', needsZone: true, open: applicationsView },
  { key: '3', label: 'provider',   group: 'manage', description: 'Manage provider credential sources', needsZone: true, open: providersView },
  { key: '4', label: 'resource',   group: 'manage', description: 'Manage protected resources', needsZone: true, open: resourcesView },
  { key: '5', label: 'policy',     group: 'manage', description: 'Manage access policies', needsZone: true, open: policiesView },
  { key: '6', label: 'policy set', group: 'manage', description: 'Manage active policy sets', needsZone: true, open: policySetsView },
  { key: '7', label: 'grant',      group: 'manage', description: 'Manage access grants', needsZone: true, open: grantsView },
  { key: '8', label: 'session',    group: 'manage', description: 'List active authority sessions', needsZone: true, open: sessionsView },
  { key: '9', label: 'control',    group: 'manage', description: 'Manage the Control automation service', needsZone: true, open: controlEntry },
  { key: 'a', label: 'audit',      group: 'observe', description: 'Search audit events', needsZone: true, open: auditView },
  { key: 'e', label: 'explain',    group: 'observe', description: 'Explain an audit decision', needsZone: true, open: auditExplainEntry },
  { key: 'r', label: 'agent session', group: 'agents', description: 'Manage agent sessions', needsZone: true, open: agentsView },
  { key: 'g', label: 'delegation', group: 'agents', description: 'Manage delegated permissions', needsZone: true, open: delegationsView },
  { key: 'd', label: 'diagnostics', group: 'runtime', description: 'Run operator diagnostics', needsZone: false, open: doctorEntry },
]

function menuEntries(): Entry[] {
  return BASE_ENTRIES
}

function auditExplainEntry(ctx: Ctx): View {
  return new FormView({
    title: 'audit explain',
    fields: [{ key: 'request_id', label: 'request ID', kind: 'text', required: true }],
    onSubmit: async (v, app) => {
      app.pop()
      app.push(new DetailView({
        title: `audit / ${v.request_id}`,
        load: () => ctx.client.audit.explain(ctx.zoneId, v.request_id!),
      }))
    },
  })
}

function doctorEntry(ctx: Ctx): View {
  return new DoctorView({ zoneId: ctx.zoneId, zonePicker: zoneFieldPicker(ctx.client) })
}

function zoneFieldPicker(client: AdminClient): Field['pick'] {
  return pickFromList<Zone>(
    'pick zone',
    () => client.zones.list(),
    [
      { header: 'name', width: 24, value: (row) => row.name },
      { header: 'slug', width: 20, value: (row) => row.slug },
    ],
    (row) => row.id,
    (row) => row.name,
  )
}

function controlKeyPicker(client: AdminClient, zoneId: string): Field['pick'] {
  return pickFromList<ControlKeyRecord>(
    'pick control key',
    () => controlKeyList(client, zoneId),
    [
      { header: 'name', width: 24, value: (row) => row.name },
      { header: 'client_id', value: (row) => row.client_id },
    ],
    (row) => row.client_id,
    (row) => row.name,
  )
}

function controlPermissionPicker(): Field['pick'] {
  return pickFromList(
    'pick control permission',
    async () => controlPermissions(),
    [
      { header: 'resource', width: 16, value: (row) => row.command },
      { header: 'action', width: 8, value: (row) => row.action },
      { header: 'operation', width: 18, value: (row) => row.subcommand || '-' },
      { header: 'scope', value: (row) => row.scope },
    ],
    (row) => row.scope,
    (row) => row.scope,
    appendCsv,
  )
}

function parseSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) throw new Error('seconds must be an integer')
  return parsed
}

function expiresInDays(value: string | undefined): string | undefined {
  if (!value) return undefined
  const days = Number.parseInt(value, 10)
  if (!Number.isFinite(days) || days < 1) throw new Error('expiry must be at least one day')
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function controlEntry(ctx: Ctx): View {
  return new ControlMenuView(ctx)
}

class ControlMenuView implements View {
  readonly title = 'control'
  private cursor = 0
  private readonly ctx: Ctx
  private status: Pick<ControlServiceStatus, 'mounted' | 'enabled'> | undefined

  constructor(ctx: Ctx) {
    this.ctx = ctx
  }

  async init(app: App): Promise<void> {
    try {
      authorizeControlManagementAccess()
      const paths = resolveStackPaths({ mode: resolveControlStackMode() })
      this.status = await controlServiceStatus({ paths, env: controlComposeEnv(paths), timeoutMs: 300 })
      app.invalidate()
    } catch (err) {
      app.setStatus(`control status: ${explainError(err)}`, 'error')
    }
  }

  private items(): { key: string; label: string; build: () => View }[] {
    const state = this.lifecycleState()
    const mounted = state.mounted
    const enabled = state.enabled
    return [
      { key: 'm', label: mounted ? 'unmount runtime' : 'mount runtime', build: () => this.lifecycleConfirm(mounted ? 'unmount' : 'mount') },
      { key: 'e', label: !mounted ? 'enable endpoint (mount first)' : enabled ? 'disable endpoint' : 'enable endpoint', build: () => mounted ? this.lifecycleConfirm(enabled ? 'disable' : 'enable') : this.statusView() },
      { key: 's', label: 'management status', build: () => this.statusView() },
      { key: 'l', label: 'list keys', build: () => this.listView() },
      { key: 'g', label: 'get key', build: () => this.getForm() },
      { key: 'c', label: 'create key', build: () => this.createForm() },
      { key: 't', label: 'issue invocation token', build: () => this.tokenForm() },
      { key: 'r', label: 'rotate key', build: () => this.rotateForm() },
      { key: 'v', label: 'revoke key', build: () => this.revokeForm() },
    ]
  }

  private lifecycleState(): { mounted: boolean; enabled: boolean } {
    if (this.status) return this.status
    try {
      const state = readControlState()
      return { mounted: state?.mounted === true, enabled: state?.enabled === true }
    } catch {
      return { mounted: false, enabled: false }
    }
  }

  hints(): string[] { return ['↑/↓:select', 'enter:open', '?:info', 'esc:back'] }

  render(_ctx: ViewContext): string[] {
    const lines: string[] = [
      '',
      ' ' + ui.title('Control API'),
      ' ' + ui.muted('Toggle runtime mount state, toggle endpoint exposure, and manage credentials.'),
      '',
    ]
    const items = this.items()
    if (this.cursor >= items.length) this.cursor = Math.max(0, items.length - 1)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      const mark = i === this.cursor ? ui.accent('>') : ' '
      lines.push(` ${mark} ${ui.key(it.key)} ${it.label}`)
    }
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const items = this.items()
    if (key === 'up') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(items.length - 1, this.cursor + 1); return }
    if (key === 'left' || key === 'esc') { ctx.app.pop(); return }
    if (key === '?') {
      const item = items[this.cursor]
      if (item) openInfo(ctx.app, actionInfo(`Control ${item.label}`, 'The selected Control action changes runtime exposure or manages Control API credentials.'))
      return
    }
    const direct = items.findIndex((it) => it.key === key)
    if (direct >= 0) { ctx.app.push(items[direct]!.build()); return }
    if (key === 'enter') { ctx.app.push(items[this.cursor]!.build()) }
  }

  private listView(): View {
    return new DetailView({
      title: 'control / keys',
      load: () => controlKeyList(this.ctx.client, this.ctx.zoneId),
    })
  }

  private lifecycleView(action: ControlLifecycleAction): View {
    return new ControlLifecycleView({
      title: `control / ${action}`,
      action,
      run: async (onLine) => {
        authorizeControlManagementAccess()
        const paths = resolveStackPaths({ mode: resolveControlStackMode() })
        const result = await applyControlLifecycleAction({ paths, action, env: controlComposeEnv(paths), onLine })
        this.status = result
        return result
      },
    })
  }

  private statusView(): View {
    return new ControlStatusView({
      title: 'control / status',
      load: async () => {
        authorizeControlManagementAccess()
        const paths = resolveStackPaths({ mode: resolveControlStackMode() })
        const status = await controlServiceStatus({ paths, env: controlComposeEnv(paths) })
        this.status = status
        return status
      },
    })
  }

  private lifecycleConfirm(action: ControlLifecycleAction): View {
    return new ConfirmView({
      message: `Confirm Control ${action} through the managed engine lifecycle?`,
      onConfirm: async (app) => {
        app.pop()
        app.push(this.lifecycleView(action))
      },
    })
  }

  private createForm(): View {
    const { client, zoneId } = this.ctx
    return new FormView({
      title: 'control key create',
      fields: [
        { key: 'name', label: 'name', kind: 'text', required: true },
        { key: 'scopes', label: 'permissions', kind: 'list', required: true, pick: controlPermissionPicker(), hint: 'right arrow adds one command/action permission' },
        { key: 'max_ttl_seconds', label: 'max token TTL', kind: 'select', options: ['300', '600', '900'], default: '300' },
        { key: 'expires_in_days', label: 'expires in days', kind: 'select', options: ['1', '7', '30', '90'], default: '30' },
      ],
      onSubmit: async (v, app) => {
        const result = await controlKeyCreate(client, zoneId, {
          name: v.name!,
          scopes: splitList(v.scopes ?? ''),
          maxTtlSeconds: parseSeconds(v.max_ttl_seconds),
          expiresAt: expiresInDays(v.expires_in_days),
        })
        app.pop()
        app.push(new DetailView({
          title: `control / ${result.clientId}`,
          load: async () => ({
            name: result.name,
            client_id: result.clientId,
            client_secret: result.clientSecret,
            resource: result.resource.identifier,
            allowed_scopes: result.allowedScopes,
            max_ttl_seconds: result.maxTtlSeconds,
            expires_at: result.expiresAt,
            restrictions: ['zone-bound', 'application-only', 'no-subject-token', 'no-delegation'],
            note: 'store client_secret now - it cannot be retrieved later',
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
      fields: [{ key: 'id', label: 'control key', kind: 'text', required: true, pick: controlKeyPicker(client, zoneId) }],
      onSubmit: async (v, app) => {
        app.pop()
        app.push(new DetailView({
          title: `control / ${v.id}`,
          load: () => controlKeyGet(client, zoneId, v.id!),
          mask: maskSecretField,
          copyPage: true,
        }))
      },
    })
  }

  private tokenForm(): View {
    const { client, zoneId } = this.ctx
    return new FormView({
      title: 'control token issue',
      fields: [
        { key: 'id', label: 'control key', kind: 'text', required: true, pick: controlKeyPicker(client, zoneId) },
        { key: 'client_secret', label: 'client secret', kind: 'secret', required: true, hint: 'paste the one-time secret from create or rotate' },
        { key: 'scopes', label: 'permissions', kind: 'list', required: true, pick: controlPermissionPicker(), hint: 'must be granted on the selected key' },
        { key: 'ttl_seconds', label: 'token TTL', kind: 'select', options: ['300', '600', '900'], default: '300' },
      ],
      onSubmit: async (v, app) => {
        const record = await controlKeyGet(client, zoneId, v.id!)
        const resource = controlAudience()
        const scopes = splitList(v.scopes ?? '')
        const allowed = new Set(record.allowed_scopes)
        if (scopes.length === 0) throw new Error('at least one control permission is required')
        for (const scope of scopes) {
          if (!allowed.has(scope)) throw new Error(`control key ${record.client_id} does not grant ${scope}`)
        }
        const ttlSeconds = parseSeconds(v.ttl_seconds)
        if (record.max_ttl_seconds !== undefined && ttlSeconds !== undefined && ttlSeconds > record.max_ttl_seconds) {
          throw new Error(`token TTL exceeds control key maximum of ${record.max_ttl_seconds} seconds`)
        }
        const accessToken = await credentialRead({
          cfg: {
            zone_url: resolveStsUrl(),
            zone_id: zoneId,
            application_id: record.client_id,
            app_client_secret: v.client_secret!,
          },
          resource,
          scopes,
          ttlSeconds,
        })
        app.pop()
        app.push(new DetailView({
          title: `control token / ${record.client_id}`,
          load: async () => ({
            client_id: record.client_id,
            resource,
            scopes,
            token_type: 'Bearer',
            access_token: accessToken,
            invoke_path: '/v1/control/invoke',
            restrictions: record.restrictions,
          }),
          mask: maskSecretField,
        }))
      },
    })
  }

  private rotateForm(): View {
    const { client, zoneId } = this.ctx
    return new FormView({
      title: 'control key rotate',
      fields: [{ key: 'id', label: 'control key', kind: 'text', required: true, pick: controlKeyPicker(client, zoneId) }],
      onSubmit: async (v, app) => {
        const result = await controlKeyRotate(client, zoneId, v.id!)
        app.pop()
        app.push(new DetailView({
          title: `control / ${result.clientId}`,
          load: async () => ({
            client_id: result.clientId,
            client_secret: result.clientSecret,
            note: 'store client_secret now - it cannot be retrieved later',
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
      fields: [{ key: 'id', label: 'control key', kind: 'text', required: true, pick: controlKeyPicker(client, zoneId) }],
      onSubmit: async (v, app) => {
        await controlKeyRevoke(client, zoneId, v.id!)
        app.pop()
        app.setStatus(`revoked control key ${v.id}`)
      },
    })
  }
}

interface ControlStatusViewOptions {
  title: string
  load: () => Promise<ControlServiceStatus>
}

class ControlStatusView implements View {
  readonly title: string
  private readonly loadStatus: () => Promise<ControlServiceStatus>
  private status: ControlServiceStatus | undefined
  private loading = true
  private error: string | undefined
  private app: App | undefined
  private aborted = false

  constructor(opts: ControlStatusViewOptions) {
    this.title = opts.title
    this.loadStatus = opts.load
  }

  hints(): string[] { return ['r:reload', 'esc:back'] }

  async init(app: App): Promise<void> {
    this.app = app
    await this.reload()
  }

  dispose(): void { this.aborted = true }

  private async reload(): Promise<void> {
    this.loading = true
    this.error = undefined
    this.app?.invalidate()
    try {
      const status = await this.loadStatus()
      if (this.aborted) return
      this.status = status
    } catch (err) {
      if (this.aborted) return
      this.error = explainError(err)
    } finally {
      if (!this.aborted) {
        this.loading = false
        this.app?.invalidate()
      }
    }
  }

  render(_ctx: ViewContext): string[] {
    if (this.loading) return ['', ' ' + ui.muted('Loading Control status...')]
    if (this.error) return ['', ' ' + ui.error('error: ') + this.error]
    if (!this.status) return ['', ' ' + ui.warn('Control status unavailable')]
    return renderControlStatus(this.status, undefined)
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (key === 'r') return this.reload()
    if (key === 'left' || key === 'esc') ctx.app.pop()
  }
}

interface ControlLifecycleViewOptions {
  title: string
  action: ControlLifecycleAction
  run: (onLine: (line: string, stream: 'stdout' | 'stderr') => void) => Promise<ControlLifecycleResult>
}

class ControlLifecycleView implements View {
  readonly title: string
  private readonly action: ControlLifecycleAction
  private readonly runAction: ControlLifecycleViewOptions['run']
  private result: ControlLifecycleResult | undefined
  private loading = true
  private error: string | undefined
  private lineCount = 0
  private app: App | undefined
  private aborted = false

  constructor(opts: ControlLifecycleViewOptions) {
    this.title = opts.title
    this.action = opts.action
    this.runAction = opts.run
  }

  hints(): string[] { return ['esc:back'] }

  private progress(): string {
    if (this.action === 'enable') return 'opening endpoint gate'
    if (this.action === 'disable') return 'closing endpoint gate'
    if (this.action === 'unmount') return 'detaching Control runtime'
    return 'loading Control runtime'
  }

  async init(app: App): Promise<void> {
    this.app = app
    app.setStatus(`control ${this.action}: ${this.progress()}`)
    app.invalidate()
    try {
      const result = await this.runAction(() => {
        this.lineCount++
      })
      if (this.aborted) return
      this.result = result
      app.setStatus(result.summary)
    } catch (err) {
      if (this.aborted) return
      this.error = explainError(err)
      app.setStatus(`control ${this.action}: ${this.error}`, 'error')
    } finally {
      if (!this.aborted) {
        this.loading = false
        app.invalidate()
      }
    }
  }

  dispose(): void { this.aborted = true }

  render(_ctx: ViewContext): string[] {
    if (this.loading) {
      const progress = this.progress()
      return [
        '',
        ' ' + ui.title(`Control ${this.action}`),
        ' ' + ui.muted(progress),
        '',
        ` ${ui.muted('state')} ${ui.info('in progress')}`,
      ]
    }
    if (this.error) return ['', ' ' + ui.error('error: ') + this.error]
    if (!this.result) return ['', ' ' + ui.warn('Control action did not produce a result')]
    const eventSummary = (this.action === 'mount' || this.action === 'unmount') && this.lineCount > 0
      ? `${this.lineCount} runtime line${this.lineCount === 1 ? '' : 's'} captured`
      : undefined
    return renderControlStatus(this.result, eventSummary)
  }

  onKey(key: Key, ctx: ViewContext): void {
    if (key === 'left' || key === 'esc') ctx.app.pop()
  }
}

function controlStateText(state: ControlServiceStatus['state']): string {
  if (state === 'enabled') return ui.success(state)
  if (state === 'disabled') return ui.warn(state)
  return ui.muted(state)
}

function controlServiceText(service: ControlServiceStatus['service'] | ControlLifecycleResult['service']): string {
  if (service === 'ok' || service === 'running') return ui.success(service)
  if (service === 'gated') return ui.warn(service)
  if (service === 'down') return ui.error(service)
  return ui.muted(service)
}

function renderControlStatus(
  status: ControlServiceStatus | ControlLifecycleResult,
  eventSummary: string | undefined,
): string[] {
  const lines = ['', ' ' + ui.title('Control API management'), '']
  lines.push(` ${ui.muted('state')}      ${controlStateText(status.state)}`)
  lines.push(` ${ui.muted('runtime')}    ${controlServiceText(status.service)}`)
  lines.push(` ${ui.muted('mounted')}    ${status.mounted ? ui.success('yes') : ui.muted('no')}`)
  lines.push(` ${ui.muted('enabled')}    ${status.enabled ? ui.success('yes') : ui.muted('no')}`)
  const endpoint = status.enabled ? ui.input(status.invokeUrl) : ui.muted(`not exposed (${status.invokeUrl})`)
  lines.push(` ${ui.muted('endpoint')}   ${endpoint}`)
  lines.push(` ${ui.muted('lifecycle')}  ${status.lifecycle}`)
  lines.push(` ${ui.muted('optimize')}   ${status.optimization}`)
  if ('detail' in status) lines.push(` ${ui.muted('health')}     ${status.detail}`)
  if (eventSummary) lines.push(` ${ui.muted('events')}     ${eventSummary}`)
  lines.push(` ${ui.muted('state file')} ${status.marker}`)
  lines.push('')
  return lines
}

export class MenuView implements View {
  readonly title = 'menu'
  private readonly client: AdminClient
  private readonly state?: ConsoleStateStore | undefined
  private zoneId: string | undefined
  private zoneLabel: string | undefined
  private cursor = 0

  constructor(client: AdminClient, zoneId: string | undefined, state?: ConsoleStateStore) {
    this.client = client
    this.state = state
    this.zoneId = zoneId
    this.zoneLabel = state?.selectedZoneSlug()
    this.cursor = state?.menuCursor() ?? 0
  }

  hints(): string[] {
    return ['↑/↓ or hot-key:select', 'enter:open', 'z:set-zone', '?:info']
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
        this.state?.clearSelectedZone()
        app.setStatus(`configured zone ${stale} no longer exists: press z to pick another or open Zones to create one`, 'error')
        app.invalidate()
      }
    }
  }

  setZone(id: string, slug: string | undefined, app: App): void {
    this.zoneId = id
    this.zoneLabel = slug ?? id
    this.state?.setSelectedZone(id, slug)
    app.setStatus(`zone set to ${slug ?? id}`)
    app.invalidate()
  }

  render(_ctx: ViewContext): string[] {
    const lines: string[] = []
    lines.push('')
    const zone = this.zoneId ? ui.success(this.zoneLabel ?? this.zoneId) : ui.warn('no zone selected')
    lines.push(' ' + ui.muted('zone') + '  ' + zone)
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
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); this.state?.setMenuCursor(this.cursor); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(entries.length - 1, this.cursor + 1); this.state?.setMenuCursor(this.cursor); return }
    if (key === 'z' || key === 'Z') return this.promptZone(ctx.app)
    if (key === '?') {
      const entry = entries[this.cursor]
      if (entry) openInfo(ctx.app, entry.info ?? menuInfo(entry, this.zoneLabel ?? this.zoneId))
      return
    }
    const direct = entries.findIndex((e) => e.key === key)
    if (direct >= 0) { this.cursor = direct; this.state?.setMenuCursor(this.cursor); this.open(ctx.app); return }
    if (key === 'enter') { this.state?.setMenuCursor(this.cursor); this.open(ctx.app); return }
  }

  private open(app: App): void {
    const entries = menuEntries()
    const e = entries[this.cursor]!
    if (e.needsZone && !this.zoneId) {
      app.setStatus('zone required: press z to set one or pick Zones first', 'error')
      return
    }
    const ctx: Ctx = {
      client: this.client,
      zoneId: this.zoneId ?? '',
      onZoneSelect: (id, slug) => this.setZone(id, slug, app),
      state: this.state,
    }
    app.push(e.open(ctx, app))
  }

  private async promptZone(app: App): Promise<void> {
    try {
      const zones = await this.client.zones.list()
      if (zones.length === 0) { app.setStatus('no zones: open Zones (n) to create one', 'error'); return }
      app.push(new EntityPickerView<Zone>({
        title: 'select zone',
        load: async () => zones,
        rows: zones,
        value: (row) => row.id,
        label: (row) => row.name,
        description: (row) => `slug:${row.slug}`,
        onPick: (id) => {
          const zone = zones.find((row) => row.id === id)
          this.setZone(id, zone?.slug, app)
        },
      }))
    } catch (err) {
      app.setStatus(`zone list: ${explainError(err)}`, 'error')
    }
  }
}

function menuInfo(entry: Entry, zone: string | undefined): InfoPage {
  const help = menuHelp(entry.label)
  return infoPage({
    title: entry.label,
    meaning: help.meaning,
    when: entry.needsZone ? `${help.when} The active zone decides which objects are visible and mutable.` : help.when,
    impact: help.impact,
    example: help.example,
    valid: entry.needsZone ? 'Requires an active zone; press z to select one or open Zones first.' : 'No active zone is required.',
    after: 'The selected section opens with contextual actions. Complete entity detail pages can copy raw JSON with copy-page.',
    context: [
      { label: 'Current zone', value: zone ?? 'none selected' },
      { label: 'Scope', value: entry.needsZone ? 'zone-scoped management' : 'global or local workflow' },
    ],
    terms: help.terms,
    notes: help.notes,
  })
}

function menuHelp(label: string): Pick<InfoPage, 'meaning' | 'when' | 'impact' | 'example' | 'terms' | 'notes'> {
  switch (label) {
    case 'guided setup':
      return {
        meaning: 'Guided setup creates the minimum connected objects needed for a working Caracal path.',
        when: 'Use it when bootstrapping a zone or validating that app, resource, policy, grant, and runtime profile concepts fit together.',
        impact: 'The workflow creates or reuses real Control API objects and ends with an operational setup summary.',
        example: 'Create Pied Piper zone, Son of Anton app, PiperNet resource, policy, grant, and profile.',
        terms: [{ label: 'Profile', value: 'Runtime configuration used by workloads or SDKs to request tokens.' }],
        notes: ['Guided setup favors implemented defaults and hides uncommon advanced fields until requested.'],
      }
    case 'zone':
      return {
        meaning: 'Zones are trust boundaries that own applications, resources, policies, grants, sessions, audit, and agents.',
        when: 'Use Zones before any zone-scoped workflow or when separating environments and tenants.',
        impact: 'Selecting a zone changes the active management scope for the rest of Console.',
        example: 'Pied Piper Production',
        terms: [{ label: 'DCR', value: 'Dynamic Client Registration; zone-level switch for API-driven app registration.' }],
      }
    case 'application':
      return {
        meaning: 'Applications are client identities for workloads, agents, gateways, or automation.',
        when: 'Use managed apps for known durable software and DCR apps for dynamic or self-registering clients.',
        impact: 'Managed creation provisions a stable token application; DCR uses the zone-gated dynamic registration path and can expire clients.',
        example: 'Son of Anton',
        terms: [{ label: 'DCR', value: 'Dynamic Client Registration for self-service, high-churn, or ephemeral clients.' }],
      }
    case 'provider':
      return {
        meaning: 'Providers describe upstream credential systems that Caracal can call.',
        when: 'Use this before Gateway flows that need OAuth 2.0 authorization-code, OAuth 2.0 client-credentials, API-key, or bearer-token upstream auth.',
        impact: 'Provider config controls token endpoints, sealed credential material, OAuth token endpoint hosts, and upstream credential headers.',
        example: 'Hooli OAuth',
        terms: [{ label: 'Token endpoint', value: 'The upstream HTTPS endpoint used to issue or refresh OAuth 2.0 provider tokens.' }],
      }
    case 'resource':
      return {
        meaning: 'Resources are protected APIs, services, audiences, or Gateway targets.',
        when: 'Use this to define what applications request access to and which scopes exist.',
        impact: 'Resource identifiers and scopes become part of grants, policy input, token audiences, Gateway application bindings, and upstream credential provider bindings.',
        example: 'resource://pipernet',
        terms: [{ label: 'Scope', value: 'A named permission string evaluated by grants and policies.' }],
      }
    case 'policy':
      return {
        meaning: 'Policies are authorization logic used to evaluate requests.',
        when: 'Use this to create, validate, and version access rules.',
        impact: 'Policy versions can affect authorization once included in an active policy set.',
        example: 'allow PiperNet read for Pied Piper operators',
        terms: [{ label: 'Version', value: 'An immutable policy content snapshot.' }],
      }
    case 'policy set':
      return {
        meaning: 'Policy sets group policy versions and control what policy bundle is active.',
        when: 'Use this to promote tested policy versions into live authorization.',
        impact: 'Activating a policy-set version changes future authorization decisions.',
        example: 'PiperNet baseline v3',
        terms: [{ label: 'Manifest', value: 'The policy-version list included in a policy-set version.' }],
      }
    case 'grant':
      return {
        meaning: 'Grants bind one subject, application, resource, and scope set into explicit authority.',
        when: 'Use this for known users or workloads that need scoped access.',
        impact: 'Grants allow authority to be requested; policies can still narrow or deny a request.',
        example: 'Richard Hendricks can read resource://pipernet through Son of Anton',
        terms: [{ label: 'Subject', value: 'The user, workload, or actor receiving authority.' }],
      }
    case 'session':
      return {
        meaning: 'Sessions show tracked authority contexts created by token exchange, delegation, or agents.',
        when: 'Use this to inspect active, expired, or revoked authority.',
        impact: 'Session status explains whether related tokens or authority paths can continue.',
        example: 'Richard Hendricks active until 28 May, 04:48 UTC',
        terms: [{ label: 'TTL', value: 'Time to live; how long authority remains valid.' }],
      }
    case 'control':
      return {
        meaning: 'Control is the authenticated automation surface for scripts and CI that manage Caracal.',
        when: 'Use this to enable Control, create keys, rotate secrets, or issue invocation tokens.',
        impact: 'Control keys can automate management workflows and should be scoped tightly.',
        example: 'issue token with zones:read resources:write',
        terms: [{ label: 'Invocation token', value: 'Short-lived token used to call the Control API.' }],
        notes: ['Control secrets are shown once; copy them immediately.'],
      }
    case 'audit':
      return {
        meaning: 'Audit records explain what happened, when it happened, and how authorization evaluated.',
        when: 'Use this during incident response, policy debugging, and operational verification.',
        impact: 'Audit is read-only evidence; it does not change authorization state.',
        example: 'deny token_exchange req_123',
        terms: [{ label: 'Decision', value: 'Authorization result such as allow, deny, or partial.' }],
      }
    case 'explain':
      return {
        meaning: 'Explain loads a focused decision explanation for one audit request ID.',
        when: 'Use it when you already have a request ID from logs, audit tail, or an error report.',
        impact: 'The result helps identify the determining policies, missing grants, or evaluation status.',
        example: 'req_01HX...',
        terms: [{ label: 'Request ID', value: 'Correlation identifier for one evaluated request.' }],
      }
    case 'agent session':
      return {
        meaning: 'Agent sessions are Coordinator records for agent runs and their child work.',
        when: 'Use this to inspect status, tree shape, suspend, resume, or terminate agent sessions.',
        impact: 'Suspend and terminate can affect live work; tree/detail views are read-only.',
        example: 'Son of Anton running depth 1',
        terms: [{ label: 'Depth', value: 'Distance from the root agent session.' }],
      }
    case 'delegation':
      return {
        meaning: 'Delegation tracks authority passed from one session to another.',
        when: 'Use this to trace, traverse, or revoke delegated authority.',
        impact: 'Revoking a delegation can interrupt downstream authority paths.',
        example: 'Son of Anton session delegates resource://pipernet to Fiona',
        terms: [{ label: 'Edge', value: 'A directed authority link between two sessions.' }],
      }
    case 'diagnostics':
      return {
        meaning: 'Diagnostics check local service readiness, selected-zone visibility, and operational preflight state.',
        when: 'Use this when the Console or local stack appears unhealthy.',
        impact: 'Diagnostics are read-only and report failures or warnings for operator action.',
        example: 'strict readiness before a PiperNet launch smoke run',
        terms: [{ label: 'Preflight', value: 'A readiness check before running a workflow.' }],
      }
    default:
      return {
        meaning: entryLikeMeaning(label),
        when: 'Use this from the Console menu when it matches the operational task at hand.',
        impact: 'Console opens a focused page with contextual actions and validation.',
        example: `Open ${label}`,
      }
  }
}

function entryLikeMeaning(label: string): string {
  return `${label} opens a focused Console workflow for an implemented Caracal surface.`
}
