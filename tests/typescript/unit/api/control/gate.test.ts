// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Control runtime gate: presence of the gate file toggles invoke access.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { fileGate } from '../../../../../apps/api/src/control/gate.js'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('fileGate', () => {
  it('is disabled when no path is configured', () => {
    expect(fileGate(undefined).enabled()).toBe(false)
  })

  it('is disabled when the configured file is absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'gate-'))
    expect(fileGate(join(dir, 'missing')).enabled()).toBe(false)
  })

  it('is enabled when the configured file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'gate-'))
    const path = join(dir, 'enabled')
    writeFileSync(path, '')
    expect(fileGate(path).enabled()).toBe(true)
  })
})
