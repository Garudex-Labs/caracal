// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Terminal state persistence tests cover safe operator context restoration.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { TerminalStateStore } from '../../../../apps/terminal/src/state.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'caracal-terminal-state-'))
  dirs.push(dir)
  return join(dir, 'terminal-state.json')
}

describe('TerminalStateStore', () => {
  it('persists non-secret operator context with restricted file permissions', () => {
    const path = statePath()
    const state = new TerminalStateStore(path)

    state.setSelectedZone('zone-1', 'prod')
    state.setMenuCursor(4)
    state.setListSelection('applications', 'app-1', 'zone-1')
    state.setAuditFilters('zone-1', { decision: 'deny', request_id: 'req-1', limit: 25 })
    state.setSessionFilters('zone-1', { status: 'active', subject_id: 'user-1', limit: 50 })

    const loaded = TerminalStateStore.load(path)
    expect(loaded.selectedZoneId()).toBe('zone-1')
    expect(loaded.selectedZoneSlug()).toBe('prod')
    expect(loaded.menuCursor()).toBe(4)
    expect(loaded.listSelection('applications', 'zone-1')).toBe('app-1')
    expect(loaded.auditFilters('zone-1')).toMatchObject({ decision: 'deny', request_id: 'req-1', limit: 25 })
    expect(loaded.sessionFilters('zone-1')).toMatchObject({ status: 'active', subject_id: 'user-1', limit: 50 })
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('token')
  })

  it('ignores unreadable or corrupt state and recovers on the next write', () => {
    const path = statePath()
    writeFileSync(path, '{not-json', { mode: 0o600 })

    const state = TerminalStateStore.load(path)
    expect(state.selectedZoneId()).toBeUndefined()

    state.setSelectedZone('zone-2', undefined)
    expect(TerminalStateStore.load(path).selectedZoneId()).toBe('zone-2')
  })
})
