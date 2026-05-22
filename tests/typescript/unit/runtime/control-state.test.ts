// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for persisted Control lifecycle state migration and validation.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { controlStateFile, readControlState, setControlEnabled, setControlMounted } from '../../../../packages/engine/src/controlState.ts'

let dir: string | undefined

function tempHome(): string {
  dir = mkdtempSync(join(tmpdir(), 'caracal-control-state-'))
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('control lifecycle state', () => {
  it('migrates prior engine-written state without blocking lifecycle actions', () => {
    const home = tempHome()
    const file = controlStateFile(home)
    writeFileSync(file, JSON.stringify({
      enabled: true,
      managedBy: 'engine',
      updatedAt: '2026-05-21T05:27:57.962Z',
      service: 'control',
      profile: 'control',
      port: 8087,
      endpoint: 'http://localhost:8087',
      healthUrl: 'http://localhost:8087/health',
      readyUrl: 'http://localhost:8087/ready',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
      bind: '127.0.0.1',
    }) + '\n')

    expect(readControlState(home)).toMatchObject({
      mounted: true,
      enabled: true,
      managedBy: 'engine',
      service: 'control',
      profile: 'control',
    })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      mounted: true,
      enabled: true,
    })
  })

  it('rejects malformed state instead of guessing lifecycle intent', () => {
    const home = tempHome()
    writeFileSync(controlStateFile(home), '{"enabled":true}\n')

    expect(() => readControlState(home)).toThrow(/invalid Control state/)
  })

  it('persists mounted disabled state for fast future enablement', () => {
    const home = tempHome()

    expect(setControlMounted(true, false, { home })).toMatchObject({
      mounted: true,
      enabled: false,
      mountedAt: expect.any(String),
      service: 'control',
      invokeUrl: 'http://localhost:8087/v1/control/invoke',
    })
    expect(readControlState(home)).toMatchObject({
      mounted: true,
      enabled: false,
      mountedAt: expect.any(String),
    })
  })

  it('toggles endpoint state without creating mounted runtime state', () => {
    const home = tempHome()

    expect(setControlEnabled(true, { home })).toBeUndefined()
    expect(readControlState(home)).toBeUndefined()

    const mounted = setControlMounted(true, false, { home })!
    expect(setControlEnabled(true, { home })).toMatchObject({
      mounted: true,
      enabled: true,
      mountedAt: mounted.mountedAt,
    })
  })
})
