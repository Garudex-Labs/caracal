// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the gate-file state that toggles the in-process Control surface.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  controlGateFile,
  controlRuntimeSettings,
  isControlEnabled,
  setControlEnabled,
} from '../../../../packages/engine/src/controlState.ts'

let dir: string | undefined

function tempHome(): string {
  dir = mkdtempSync(join(tmpdir(), 'caracal-control-state-'))
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('control gate state', () => {
  it('reports disabled until the gate file is written', () => {
    const home = tempHome()
    expect(isControlEnabled(home)).toBe(false)
  })

  it('writes the gate file with restrictive permissions on enable', () => {
    const home = tempHome()
    const settings = setControlEnabled(true, { home })

    expect(isControlEnabled(home)).toBe(true)
    expect(existsSync(controlGateFile(home))).toBe(true)
    expect(readFileSync(controlGateFile(home), 'utf8')).toBe('enabled\n')
    expect(settings.invokeUrl).toBe('http://localhost:3000/v1/control/invoke')
  })

  it('removes the gate file on disable', () => {
    const home = tempHome()
    setControlEnabled(true, { home })
    setControlEnabled(false, { home })

    expect(isControlEnabled(home)).toBe(false)
    expect(existsSync(controlGateFile(home))).toBe(false)
  })

  it('derives runtime endpoints from the API port', () => {
    const settings = controlRuntimeSettings({ port: 4100 })
    expect(settings).toMatchObject({
      port: 4100,
      endpoint: 'http://localhost:4100',
      healthUrl: 'http://localhost:4100/health',
      readyUrl: 'http://localhost:4100/ready',
      invokeUrl: 'http://localhost:4100/v1/control/invoke',
      bind: '127.0.0.1',
    })
  })

  it('rejects an out-of-range API port', () => {
    expect(() => controlRuntimeSettings({ port: 70_000 })).toThrow(/API_PORT/)
  })
})
