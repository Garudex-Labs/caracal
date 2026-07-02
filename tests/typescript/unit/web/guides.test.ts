// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the per-account guide progress store: parsing, forward-only merging, and the browser cache.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearGuidesCache,
  mergeGuides,
  parseGuides,
  readGuidesCache,
  serializeGuides,
  writeGuidesCache,
} from '../../../../apps/web/src/platform/state/guides.ts'

class LocalStorageStub {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new LocalStorageStub()
})

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('parseGuides', () => {
  it('parses a valid map and drops invalid statuses', () => {
    expect(parseGuides('{"consoleSetup":"done","other":"seen","bad":"maybe"}')).toEqual({
      consoleSetup: 'done',
      other: 'seen',
    })
  })

  it('returns empty for non-strings, malformed JSON, and non-object shapes', () => {
    expect(parseGuides(undefined)).toEqual({})
    expect(parseGuides('')).toEqual({})
    expect(parseGuides('not json')).toEqual({})
    expect(parseGuides('["done"]')).toEqual({})
    expect(parseGuides('"done"')).toEqual({})
  })
})

describe('mergeGuides', () => {
  it('keeps the furthest progress per guide regardless of argument order', () => {
    const a = { consoleSetup: 'seen' as const }
    const b = { consoleSetup: 'done' as const, other: 'seen' as const }
    expect(mergeGuides(a, b)).toEqual({ consoleSetup: 'done', other: 'seen' })
    expect(mergeGuides(b, a)).toEqual({ consoleSetup: 'done', other: 'seen' })
  })

  it('never regresses a retired guide', () => {
    expect(mergeGuides({ consoleSetup: 'done' }, { consoleSetup: 'seen' })).toEqual({
      consoleSetup: 'done',
    })
  })
})

describe('guides cache', () => {
  it('round-trips through localStorage', () => {
    writeGuidesCache({ consoleSetup: 'seen' })
    expect(readGuidesCache()).toEqual({ consoleSetup: 'seen' })
  })

  it('reads empty when nothing is stored or the entry is corrupt', () => {
    expect(readGuidesCache()).toEqual({})
    localStorage.setItem('caracal.guides', '{broken')
    expect(readGuidesCache()).toEqual({})
  })

  it('clears on demand', () => {
    writeGuidesCache({ consoleSetup: 'done' })
    clearGuidesCache()
    expect(readGuidesCache()).toEqual({})
  })
})

describe('serializeGuides', () => {
  it('produces a string parseGuides accepts', () => {
    const map = { consoleSetup: 'done' as const }
    expect(parseGuides(serializeGuides(map))).toEqual(map)
  })
})
