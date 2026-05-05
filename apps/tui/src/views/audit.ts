// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Live audit tail view: polls the audit endpoint and streams new events.

import type { AdminClient, AuditEvent } from '@caracalai/admin'
import { ansi, pad, truncate } from '../ansi.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { detailViewFor } from './factory.ts'

const POLL_MS = 2_000
const MAX_ROWS = 500

export class AuditTailView implements View {
  readonly title = 'audit (live)'
  private readonly client: AdminClient
  private readonly zoneId: string
  private events: AuditEvent[] = []
  private cursor = 0
  private offset = 0
  private decision: 'all' | 'allow' | 'deny' | 'partial' = 'all'
  private paused = false
  private timer: NodeJS.Timeout | undefined
  private lastSince: string | undefined
  private app: App | undefined

  constructor(client: AdminClient, zoneId: string) {
    this.client = client
    this.zoneId = zoneId
  }

  hints(): string[] {
    return [
      `filter:${this.decision}`,
      this.paused ? 'p:resume' : 'p:pause',
      'd:cycle-decision',
      'enter:explain',
      'r:reload',
      'h:back',
    ]
  }

  async init(app: App): Promise<void> {
    await this.start(app)
  }

  dispose(): void { this.stop() }

  async start(app: App): Promise<void> {
    this.app = app
    await this.fetchInitial()
    this.scheduleNext()
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
  }

  private async fetchInitial(): Promise<void> {
    try {
      const rows = await this.client.audit.list(this.zoneId, {
        limit: 100,
        decision: this.decision === 'all' ? undefined : this.decision,
      })
      this.events = rows
      this.lastSince = rows[0]?.occurred_at
      this.app?.invalidate()
    } catch (err) {
      this.app?.setStatus(`audit: ${explainError(err)}`, 'error')
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => { void this.poll() }, POLL_MS)
    this.timer.unref?.()
  }

  private async poll(): Promise<void> {
    if (this.paused) { this.scheduleNext(); return }
    try {
      const rows = await this.client.audit.list(this.zoneId, {
        since: this.lastSince,
        limit: 200,
        decision: this.decision === 'all' ? undefined : this.decision,
      })
      const fresh = rows.filter((r) => !this.events.some((e) => e.id === r.id))
      if (fresh.length > 0) {
        this.events = [...fresh, ...this.events].slice(0, MAX_ROWS)
        this.lastSince = this.events[0]?.occurred_at
        this.app?.invalidate()
      }
    } catch (err) {
      this.app?.setStatus(`audit: ${explainError(err)}`, 'error')
    } finally {
      this.scheduleNext()
    }
  }

  render(ctx: ViewContext): string[] {
    const lines: string[] = []
    if (this.events.length === 0) {
      lines.push(ansi.dim + ' (no events yet — waiting for activity)' + ansi.reset)
      return lines
    }
    const widths = [22, 28, 8, 12, 24]
    const header = ['occurred_at', 'event_type', 'decision', 'status', 'request_id']
      .map((h, i) => pad(h, widths[i]!)).join('  ')
    lines.push(ansi.bold + ' ' + header + ansi.reset)
    const visible = ctx.size.rows - 1
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + visible) this.offset = this.cursor - visible + 1
    for (let i = this.offset; i < Math.min(this.events.length, this.offset + visible); i++) {
      const ev = this.events[i]!
      const cells = [
        ev.occurred_at ?? '-',
        ev.event_type ?? '-',
        colorDecision(ev.decision),
        ev.evaluation_status ?? '-',
        ev.request_id ?? '-',
      ]
      const text = cells.map((c, idx) => pad(truncate(c, widths[idx]!), widths[idx]!)).join('  ')
      lines.push(i === this.cursor ? ansi.invert + ' ' + text + ' ' + ansi.reset : ' ' + text + ' ')
    }
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(this.events.length - 1, this.cursor + 1); return }
    if (key === 'pgup') { this.cursor = Math.max(0, this.cursor - 10); return }
    if (key === 'pgdn') { this.cursor = Math.min(this.events.length - 1, this.cursor + 10); return }
    if (key === 'p') { this.paused = !this.paused; ctx.app.setStatus(this.paused ? 'paused' : 'streaming'); return }
    if (key === 'd') {
      const order: typeof this.decision[] = ['all', 'allow', 'deny', 'partial']
      this.decision = order[(order.indexOf(this.decision) + 1) % order.length]!
      await this.fetchInitial()
      return
    }
    if (key === 'r') { await this.fetchInitial(); return }
    if (key === 'enter') {
      const ev = this.events[this.cursor]
      if (ev?.request_id) {
        ctx.app.push(detailViewFor(`audit / ${ev.request_id}`, () => this.client.audit.byRequest(this.zoneId, ev.request_id!)))
      }
      return
    }
    if (key === 'left' || key === 'h' || key === 'esc') { this.stop(); ctx.app.pop() }
  }
}

function colorDecision(d: string | null | undefined): string {
  if (d === 'allow') return ansi.fg(76) + 'allow' + ansi.reset
  if (d === 'deny') return ansi.fg(196) + 'deny' + ansi.reset
  if (d === 'partial') return ansi.fg(214) + 'partial' + ansi.reset
  return '-'
}
