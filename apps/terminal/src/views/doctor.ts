// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interactive doctor diagnostics view for TUI operator health checks.

import {
  DOCTOR_SECTION_LABELS,
  DOCTOR_SECTION_ORDER,
  runDoctorDiagnostics,
  type DoctorCheck,
  type DoctorReport,
} from '@caracalai/engine'
import type { CliConfig } from '@caracalai/engine/cli'
import { pad, sanitizeAnsi, truncate, ui } from '../ansi.ts'
import { explainError } from '../errors.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { FormView, type Field } from './form.ts'

interface DoctorViewOptions {
  cfg?: CliConfig
  zoneId?: string
  zonePicker?: Field['pick']
}

type DoctorMode = 'system' | 'preflight'

export class DoctorView implements View {
  readonly title = 'doctor'
  private readonly cfg?: CliConfig
  private readonly zonePicker?: Field['pick']
  private app: App | undefined
  private zoneId: string | undefined
  private mode: DoctorMode = 'system'
  private strict = false
  private loading = true
  private error: string | undefined
  private body: string[] = [' loading...']
  private offset = 0
  private aborted = false

  constructor(opts: DoctorViewOptions = {}) {
    this.cfg = opts.cfg
    this.zoneId = opts.zoneId
    this.zonePicker = opts.zonePicker
  }

  hints(): string[] {
    return ['↑/↓:scroll', 'r:reload', 'a:all', 'z:zone', 'p:preflight', 's:strict', 'esc:back']
  }

  async init(app: App): Promise<void> {
    this.app = app
    await this.reload()
  }

  dispose(): void {
    this.aborted = true
  }

  async reload(): Promise<void> {
    const app = this.app
    this.loading = true
    this.error = undefined
    this.body = [' loading...']
    app?.invalidate()
    try {
      const report = await runDoctorDiagnostics({
        cfg: this.cfg,
        zoneId: this.mode === 'system' ? this.zoneId : undefined,
        strict: this.strict,
        preflightOnly: this.mode === 'preflight',
      })
      if (this.aborted) return
      this.body = renderDoctor(report)
      this.offset = 0
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
    if (this.loading) return [ui.muted(' loading...')]
    if (this.error) return [ui.error(' error: ') + this.error]
    const lines: string[] = []
    for (let i = this.offset; i < Math.min(this.body.length, this.offset + ctx.size.rows); i++) {
      lines.push(' ' + truncate(this.body[i] ?? '', ctx.size.cols - 1))
    }
    return lines
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    const max = Math.max(0, this.body.length - ctx.size.rows)
    if (key === 'up' || key === 'k') { this.offset = Math.max(0, this.offset - 1); return }
    if (key === 'down' || key === 'j') { this.offset = Math.min(max, this.offset + 1); return }
    if (key === 'pgup') { this.offset = Math.max(0, this.offset - 10); return }
    if (key === 'pgdn') { this.offset = Math.min(max, this.offset + 10); return }
    if (key === 'home' || key === 'g') { this.offset = 0; return }
    if (key === 'end' || key === 'G') { this.offset = max; return }
    if (key === 'r') return this.reload()
    if (key === 'a') {
      this.mode = 'system'
      this.zoneId = undefined
      await this.reload()
      return
    }
    if (key === 'p') {
      this.mode = 'preflight'
      await this.reload()
      return
    }
    if (key === 's') {
      this.strict = !this.strict
      await this.reload()
      return
    }
    if (key === 'z') {
      ctx.app.push(new FormView({
        title: 'doctor zone',
        fields: [
          { key: 'zone_id', label: 'zone', kind: 'text', default: this.zoneId, hint: 'blank checks all visible zones', pick: this.zonePicker },
        ],
        onSubmit: async (value, app) => {
          this.mode = 'system'
          this.zoneId = value.zone_id || undefined
          app.pop()
          await this.reload()
        },
      }))
      return
    }
    if (key === 'left' || key === 'esc') ctx.app.pop()
  }
}

function renderDoctor(report: DoctorReport): string[] {
  const lines: string[] = []
  lines.push(ui.title('Doctor Diagnostics'))
  lines.push('')
  lines.push(label('Status') + healthText(report))
  lines.push(label('Mode') + (report.mode === 'system' ? 'complete system check' : 'local preflight only'))
  lines.push(label('API') + ui.input(report.context.apiUrl))
  lines.push(label('Zones') + zonesText(report))
  lines.push(label('Summary') + `${ui.success(`${report.summary.ok} ok`)}  ${ui.warn(`${report.summary.warn} warn`)}  ${ui.error(`${report.summary.fail} fail`)}  ${ui.muted(`${report.summary.total} checks`)}`)
  lines.push(label('Readiness') + (report.ready ? ui.success('ready') : ui.warn('not ready')) + (report.strict ? ui.muted(' (strict)') : ''))

  for (const section of DOCTOR_SECTION_ORDER) {
    const checks = report.checks.filter((check) => check.section === section)
    if (checks.length === 0) continue
    lines.push('')
    lines.push(ui.title(DOCTOR_SECTION_LABELS[section]))
    lines.push(`  ${ui.muted(pad('status', 8))}  ${ui.muted(pad('check', checkWidth(checks)))}  ${ui.muted('detail')}`)
    for (const check of checks) lines.push(renderCheck(check, checkWidth(checks)))
  }

  const advice = uniqueAdvice(report.checks)
  if (advice.length > 0) {
    lines.push('')
    lines.push(ui.title('Next actions'))
    for (const item of advice) lines.push(`  ${ui.info('>')} ${sanitizeAnsi(item)}`)
  }

  return lines
}

function label(text: string): string {
  return `  ${ui.muted(pad(text, 12))} `
}

function healthText(report: DoctorReport): string {
  if (report.summary.fail > 0) return ui.error('unhealthy')
  if (report.summary.warn > 0) return ui.warn('attention')
  return ui.success('healthy')
}

function zonesText(report: DoctorReport): string {
  if (report.context.zoneIds.length === 0) return ui.muted('none')
  if (report.context.zoneScope === 'all') return ui.input(`all visible (${report.context.zoneIds.join(', ')})`)
  return ui.input(report.context.zoneIds.join(', '))
}

function checkWidth(checks: DoctorCheck[]): number {
  return Math.max(5, ...checks.map((check) => Math.min(32, check.check.length)))
}

function renderCheck(check: DoctorCheck, width: number): string {
  return `  ${statusText(check.status)}  ${pad(sanitizeAnsi(check.check), width)}  ${sanitizeAnsi(check.detail)}`
}

function statusText(status: DoctorCheck['status']): string {
  if (status === 'ok') return ui.success(pad('ok', 8))
  if (status === 'warn') return ui.warn(pad('warn', 8))
  return ui.error(pad('fail', 8))
}

function uniqueAdvice(checks: DoctorCheck[]): string[] {
  return [...new Set(checks.flatMap((check) => check.advice ? [check.advice] : []))]
}
