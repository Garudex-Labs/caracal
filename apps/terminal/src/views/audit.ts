// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Live audit tail view: polls the audit endpoint and streams new events.

import type { AdminClient, AuditEvent, AuditQuery } from '@caracalai/admin'
import { ansi, pad, sanitizeAnsi, truncate, ui } from '../ansi.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { DetailView } from './detail.ts'

const POLL_MS = 2_000
const MAX_ROWS = 500

export class AuditTailView implements View {
  readonly title = 'audit (live)'
  private readonly client: AdminClient
  private readonly zoneId: string
  private events: AuditEvent[] = []
  private cursor = 0
  private offset = 0
  private decision: 'all' | 'allow' | 'deny' | 'partial'
  private paused = false
  private timer: NodeJS.Timeout | undefined
  private lastSince: string | undefined
  private app: App | undefined
  private aborted = false
  private readonly onFiltersChange?: ((filters: AuditQuery) => void) | undefined

  private readonly filters: AuditQuery
  constructor(client: AdminClient, zoneId: string, filters: AuditQuery = {}, onFiltersChange?: (filters: AuditQuery) => void) {
    this.client = client
    this.zoneId = zoneId
    this.filters = filters
    this.onFiltersChange = onFiltersChange
    this.decision = filters.decision ?? 'all'
  }

  hints(): string[] {
    return [
      `filter:${this.decision}`,
      this.filterLabel(),
      this.paused ? 'p:resume' : 'p:pause',
      'd:cycle-decision',
      'enter:explain',
      'r:reload',
      'esc:back',
    ]
  }

  async init(app: App): Promise<void> {
    await this.start(app)
  }

  dispose(): void { this.stop() }

  async start(app: App): Promise<void> {
    this.app = app
    this.aborted = false
    await this.fetchInitial()
    if (!this.aborted) this.scheduleNext()
  }

  stop(): void {
    this.aborted = true
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
  }

  private async fetchInitial(): Promise<void> {
    try {
      const rows = await this.client.audit.list(this.zoneId, {
        ...this.filters,
        limit: this.filters.limit ?? 100,
        decision: this.decision === 'all' ? undefined : this.decision,
      })
      if (this.aborted) return
      this.events = rows
      this.cursor = 0
      this.offset = 0
      this.lastSince = rows[0]?.occurred_at
      this.app?.invalidate()
    } catch (err) {
      if (this.aborted) return
      this.app?.setStatus(`audit: ${explainError(err)}`, 'error')
    }
  }

  private scheduleNext(): void {
    if (this.aborted) return
    this.timer = setTimeout(() => { void this.poll() }, POLL_MS)
    this.timer.unref?.()
  }

  private async poll(): Promise<void> {
    if (this.aborted) return
    if (this.paused) { this.scheduleNext(); return }
    try {
      const rows = await this.client.audit.list(this.zoneId, {
        ...this.filters,
        since: this.lastSince,
        limit: this.filters.limit ?? 200,
        decision: this.decision === 'all' ? undefined : this.decision,
      })
      if (this.aborted) return
      const known = new Set(this.events.map((e) => e.id))
      const fresh = rows.filter((r) => !known.has(r.id))
      if (fresh.length > 0) {
        this.events = [...fresh, ...this.events].slice(0, MAX_ROWS)
        this.lastSince = this.events[0]?.occurred_at
        this.cursor = Math.min(this.cursor, this.events.length - 1)
        this.app?.invalidate()
      }
    } catch (err) {
      if (!this.aborted) this.app?.setStatus(`audit: ${explainError(err)}`, 'error')
    } finally {
      this.scheduleNext()
    }
  }

  render(ctx: ViewContext): string[] {
    const lines: string[] = []
    if (this.events.length === 0) {
      lines.push(ui.muted(' no events yet — waiting for activity'))
      return lines
    }
    const widths = [22, 28, 8, 12, 24]
    const header = ['occurred_at', 'event_type', 'decision', 'status', 'request_id']
      .map((h, i) => pad(h, widths[i]!)).join('  ')
    lines.push(ui.muted(' ' + ansi.bold + header + ansi.reset))
    const visible = ctx.size.rows - 1
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(this.events.length, this.offset + visible); i++) {
      const ev = this.events[i]!
      const cells = [
        sanitizeAnsi(ev.occurred_at ?? '-'),
        sanitizeAnsi(ev.event_type ?? '-'),
        colorDecision(ev.decision),
        sanitizeAnsi(ev.evaluation_status ?? '-'),
        sanitizeAnsi(ev.request_id ?? '-'),
      ]
      const text = cells.map((c, idx) => pad(truncate(c, widths[idx]!), widths[idx]!)).join('  ')
      const row = ' ' + text + ' '
      lines.push(i === this.cursor ? ui.selected(row) : row)
    }
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const last = Math.max(0, this.events.length - 1)
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(last, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(last, this.cursor + 10); return }
    if (key === 'p') { this.paused = !this.paused; ctx.app.setStatus(this.paused ? 'paused' : 'streaming'); return }
    if (key === 'd') {
      const order: typeof this.decision[] = ['all', 'allow', 'deny', 'partial']
      this.decision = order[(order.indexOf(this.decision) + 1) % order.length]!
      this.onFiltersChange?.({ ...this.filters, decision: this.decision === 'all' ? undefined : this.decision })
      await this.fetchInitial()
      return
    }
    if (key === 'r') { await this.fetchInitial(); return }
    if (key === 'enter') {
      const ev = this.events[this.cursor]
      if (ev?.request_id) {
        ctx.app.push(new DetailView({
          title: `audit / ${ev.request_id}`,
          load: () => this.client.audit.byRequest(this.zoneId, ev.request_id!),
        }))
      }
      return
    }
    if (key === 'left' || key === 'esc') { ctx.app.pop() }
  }

  private filterLabel(): string {
    return compact([
      this.filters.since ? `since:${this.filters.since}` : undefined,
      this.filters.until ? `until:${this.filters.until}` : undefined,
      this.filters.request_id ? `request:${this.filters.request_id}` : undefined,
      this.filters.event_type ? `event:${this.filters.event_type}` : undefined,
      this.filters.limit ? `limit:${this.filters.limit}` : undefined,
    ]) || 'filters:none'
  }
}

function compact(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ')
}

function colorDecision(d: string | null | undefined): string {
  if (d === 'allow') return ansi.fg(76) + 'allow' + ansi.reset
  if (d === 'deny') return ansi.fg(196) + 'deny' + ansi.reset
  if (d === 'partial') return ansi.fg(214) + 'partial' + ansi.reset
  return '-'
}
