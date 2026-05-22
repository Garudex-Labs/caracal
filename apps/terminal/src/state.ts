// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Persistent non-secret TUI state for restoring operator context across launches.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installedHome } from '@caracalai/core'

export interface AuditFilterState {
  decision?: 'allow' | 'deny' | 'partial' | undefined
  since?: string | undefined
  until?: string | undefined
  request_id?: string | undefined
  event_type?: string | undefined
  limit?: number | undefined
}

export interface SessionFilterState {
  status?: 'active' | 'revoked' | 'expired' | undefined
  subject_id?: string | undefined
  limit?: number | undefined
}

interface PersistedState {
  version: 1
  selectedZone?: { id: string; slug?: string | undefined } | undefined
  navigation?: { menuCursor?: number | undefined } | undefined
  lists?: Record<string, { selectedId?: string | undefined }> | undefined
  filters?: {
    audit?: Record<string, AuditFilterState> | undefined
    sessions?: Record<string, SessionFilterState> | undefined
  } | undefined
}

const STATE_VERSION = 1
const MAX_TEXT = 256

export class TuiStateStore {
  private readonly path: string
  private state: PersistedState

  constructor(path = defaultStatePath(), state?: PersistedState) {
    this.path = path
    this.state = normalizeState(state)
  }

  static load(path = defaultStatePath()): TuiStateStore {
    try {
      if (!existsSync(path)) return new TuiStateStore(path)
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return new TuiStateStore(path, normalizeState(parsed))
    } catch {
      return new TuiStateStore(path)
    }
  }

  selectedZoneId(): string | undefined {
    return this.state.selectedZone?.id
  }

  selectedZoneSlug(): string | undefined {
    return this.state.selectedZone?.slug
  }

  setSelectedZone(id: string, slug: string | undefined): void {
    this.state.selectedZone = { id: cleanText(id), slug: cleanOptional(slug) }
    this.save()
  }

  clearSelectedZone(): void {
    delete this.state.selectedZone
    this.save()
  }

  menuCursor(): number | undefined {
    return this.state.navigation?.menuCursor
  }

  setMenuCursor(cursor: number): void {
    this.state.navigation = { ...this.state.navigation, menuCursor: nonNegativeInt(cursor) }
    this.save()
  }

  listSelection(key: string, zoneId?: string): string | undefined {
    return this.state.lists?.[scopedKey(key, zoneId)]?.selectedId
  }

  setListSelection(key: string, selectedId: string | undefined, zoneId?: string): void {
    this.state.lists = this.state.lists ?? {}
    const stateKey = scopedKey(key, zoneId)
    if (selectedId) this.state.lists[stateKey] = { selectedId: cleanText(selectedId) }
    else delete this.state.lists[stateKey]
    this.save()
  }

  auditFilters(zoneId: string): AuditFilterState {
    return { ...(this.state.filters?.audit?.[zoneId] ?? {}) }
  }

  setAuditFilters(zoneId: string, filters: AuditFilterState): void {
    this.state.filters = this.state.filters ?? {}
    this.state.filters.audit = this.state.filters.audit ?? {}
    this.state.filters.audit[zoneId] = cleanAuditFilters(filters)
    this.save()
  }

  sessionFilters(zoneId: string): SessionFilterState {
    return { ...(this.state.filters?.sessions?.[zoneId] ?? {}) }
  }

  setSessionFilters(zoneId: string, filters: SessionFilterState): void {
    this.state.filters = this.state.filters ?? {}
    this.state.filters.sessions = this.state.filters.sessions ?? {}
    this.state.filters.sessions[zoneId] = cleanSessionFilters(filters)
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}

function defaultStatePath(): string {
  return join(installedHome(), 'tui-state.json')
}

function normalizeState(value: unknown): PersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { version: STATE_VERSION }
  const raw = value as PersistedState
  if (raw.version !== STATE_VERSION) return { version: STATE_VERSION }
  return {
    version: STATE_VERSION,
    selectedZone: raw.selectedZone?.id ? { id: cleanText(raw.selectedZone.id), slug: cleanOptional(raw.selectedZone.slug) } : undefined,
    navigation: raw.navigation?.menuCursor !== undefined ? { menuCursor: nonNegativeInt(raw.navigation.menuCursor) } : undefined,
    lists: cleanLists(raw.lists),
    filters: {
      audit: cleanFilterMap(raw.filters?.audit, cleanAuditFilters),
      sessions: cleanFilterMap(raw.filters?.sessions, cleanSessionFilters),
    },
  }
}

function cleanLists(lists: PersistedState['lists']): PersistedState['lists'] {
  if (!lists || typeof lists !== 'object') return undefined
  const out: PersistedState['lists'] = {}
  for (const [key, value] of Object.entries(lists)) {
    if (value?.selectedId) out[cleanText(key)] = { selectedId: cleanText(value.selectedId) }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function cleanFilterMap<T>(value: Record<string, T> | undefined, clean: (filters: T) => T): Record<string, T> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, T> = {}
  for (const [key, filters] of Object.entries(value)) out[cleanText(key)] = clean(filters)
  return Object.keys(out).length > 0 ? out : undefined
}

function cleanAuditFilters(filters: AuditFilterState): AuditFilterState {
  return {
    decision: filters.decision === 'allow' || filters.decision === 'deny' || filters.decision === 'partial' ? filters.decision : undefined,
    since: cleanOptional(filters.since),
    until: cleanOptional(filters.until),
    request_id: cleanOptional(filters.request_id),
    event_type: cleanOptional(filters.event_type),
    limit: optionalPositiveInt(filters.limit),
  }
}

function cleanSessionFilters(filters: SessionFilterState): SessionFilterState {
  return {
    status: filters.status === 'active' || filters.status === 'revoked' || filters.status === 'expired' ? filters.status : undefined,
    subject_id: cleanOptional(filters.subject_id),
    limit: optionalPositiveInt(filters.limit),
  }
}

function scopedKey(key: string, zoneId: string | undefined): string {
  return zoneId ? `${cleanText(zoneId)}:${cleanText(key)}` : cleanText(key)
}

function cleanText(value: string): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_TEXT)
}

function cleanOptional(value: string | undefined): string | undefined {
  if (!value) return undefined
  const clean = cleanText(value)
  return clean.length > 0 ? clean : undefined
}

function nonNegativeInt(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0
}

function optionalPositiveInt(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value && value > 0 ? value : undefined
}
