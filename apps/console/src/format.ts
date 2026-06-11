// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared display formatters for Console values.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/

export interface DateTimeFormatOptions {
  compact?: boolean
}

export function formatDateTime(value: string | Date, opts: DateTimeFormatOptions = {}): string | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined
    return renderDateTime({
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
      zone: 'UTC',
    }, opts)
  }

  const match = ISO_DATE_TIME.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, zone] = match
  const sourceZone = zoneText(zone)
  if (!sourceZone) return undefined
  return renderDateTime({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? '0'),
    zone: sourceZone,
  }, opts)
}

export function formatDateTimeOrValue(value: string | Date, opts: DateTimeFormatOptions = {}): string {
  return formatDateTime(value, opts) ?? String(value)
}

const RELATIVE_TIME = /^(\d+)\s*(s|m|h|d|w)$/i
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const RELATIVE_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

export function resolveTimeInput(value: string | undefined, now: Date = new Date()): string | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (text.toLowerCase() === 'now') return now.toISOString()
  const relative = RELATIVE_TIME.exec(text)
  if (relative) {
    const amount = Number(relative[1])
    const unit = RELATIVE_UNIT_MS[relative[2]!.toLowerCase()]!
    return new Date(now.getTime() - amount * unit).toISOString()
  }
  if (CANONICAL_ISO.test(text)) return text
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('enter a relative time like 15m, 2h, or 7d, an ISO timestamp, or a date')
  }
  return parsed.toISOString()
}

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  zone: string
}

function renderDateTime(parts: DateParts, opts: DateTimeFormatOptions): string {
  const month = MONTHS[parts.month - 1] ?? String(parts.month).padStart(2, '0')
  const zone = opts.compact ? compactZone(parts.zone) : parts.zone
  const time = opts.compact
    ? `${two(parts.hour)}:${two(parts.minute)}`
    : `${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)}`
  const date = opts.compact
    ? `${parts.day} ${month}`
    : `${parts.day} ${month} ${parts.year}`
  return `${date}, ${time} ${zone}`
}

function zoneText(zone: string | undefined): string | undefined {
  if (zone === 'Z') return 'UTC'
  if (/^[+-]\d{2}:\d{2}$/.test(zone ?? '')) return `UTC${zone}`
  return undefined
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

function compactZone(zone: string): string {
  return zone.startsWith('UTC+') || zone.startsWith('UTC-') ? zone.slice(3) : zone
}
