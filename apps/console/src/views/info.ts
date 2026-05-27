// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Focused contextual info pages for Console controls and fields.

import { pad, sanitizeAnsi, ui } from '../ansi.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'

export interface InfoPage {
  title: string
  meaning: string
  when: string
  example?: string
  valid: string
  after: string
}

export function infoPage(page: InfoPage): InfoPage {
  return page
}

export function fieldInfo(label: string, kind: string, hint?: string): InfoPage {
  const title = label || 'Field'
  return {
    title,
    meaning: hint ?? `${title} is used by this Console action.`,
    when: 'Use this when the default or selected value does not already express what you need.',
    example: exampleFor(kind, title),
    valid: validFor(kind),
    after: 'After submit, Console sends this value to the Control API and shows the result or any validation error.',
  }
}

export function actionInfo(label: string, after = 'After confirmation, Console runs the action and refreshes the current view.'): InfoPage {
  return {
    title: label,
    meaning: `${label} runs the selected Console action.`,
    when: 'Use it after reviewing the visible values and any advanced settings that apply.',
    example: label.toLowerCase().includes('create') ? 'Create resource' : label,
    valid: 'The action is valid when required fields are complete and selected objects still exist.',
    after,
  }
}

export function openInfo(app: App, page: InfoPage | undefined): void {
  if (!page) {
    app.setStatus('no info page for this item yet', 'error')
    return
  }
  app.push(new InfoView(page))
}

export class InfoView implements View {
  readonly title: string
  readonly isTextEntry = true
  private readonly page: InfoPage
  private offset = 0

  constructor(page: InfoPage) {
    this.page = page
    this.title = `info / ${page.title}`
  }

  hints(): string[] { return ['↑/↓:scroll', 'esc:back'] }

  render(ctx: ViewContext): string[] {
    const body = this.bodyLines()
    return body.slice(this.offset, this.offset + ctx.size.rows)
  }

  onKey(key: Key, ctx: ViewContext): void {
    const max = Math.max(0, this.bodyLines().length - ctx.size.rows)
    if (key === 'up' || key === 'k') { this.offset = Math.max(0, this.offset - 1); return }
    if (key === 'down' || key === 'j') { this.offset = Math.min(max, this.offset + 1); return }
    if (key === 'esc' || key === 'left') ctx.app.pop()
  }

  private bodyLines(): string[] {
    const lines = [
      '',
      ' ' + ui.title(this.page.title),
      '',
      infoLine('Means', this.page.meaning),
      infoLine('Use when', this.page.when),
    ]
    if (this.page.example) lines.push(infoLine('Example', this.page.example))
    lines.push(
      infoLine('Valid input', this.page.valid),
      infoLine('After submit', this.page.after),
      '',
    )
    return lines
  }
}

function infoLine(label: string, value: string): string {
  return ' ' + ui.muted(pad(label, 14)) + ' ' + sanitizeAnsi(value)
}

function exampleFor(kind: string, label: string): string {
  if (kind === 'bool') return 'yes'
  if (kind === 'list') return 'read,write'
  if (kind === 'secret') return '••••'
  if (kind === 'file') return '/home/team/policy.rego'
  if (kind === 'select') return 'Choose one of the listed options.'
  if (label.toLowerCase().includes('url')) return 'https://api.example.com'
  if (label.toLowerCase().includes('identifier')) return 'resource://payments-api'
  return 'payments-api'
}

function validFor(kind: string): string {
  if (kind === 'bool') return 'Toggle on or off.'
  if (kind === 'list') return 'Comma-separated values; empty items are ignored.'
  if (kind === 'secret') return 'Paste the exact secret value; it is masked by default.'
  if (kind === 'file') return 'Pick a readable file or enter an absolute path.'
  if (kind === 'select') return 'One of the options shown in the picker.'
  if (kind === 'multiline') return 'Plain text content; pasted newlines are preserved.'
  return 'Non-empty text when the field is marked required.'
}
