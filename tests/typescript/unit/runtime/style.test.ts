// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime style tests cover color flags, semantic writers, and token scrubbing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  colorOn,
  printError,
  printHeader,
  printInfo,
  printStep,
  printSuccess,
  printWarn,
  style,
} from '../../../../apps/runtime/src/style.ts'

const ansi = /\u001b\[[0-9;]*m/g
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

beforeEach(() => {
  // Exercise each precedence case independently of the invoking terminal/CI.
  for (const key of ['NO_COLOR', 'CARACAL_NO_COLOR', 'CARACAL_COLOR', 'FORCE_COLOR']) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
})

function setTTY(stream: NodeJS.WriteStream, value: boolean): void {
  Object.defineProperty(stream, 'isTTY', { value, configurable: true })
}

describe('runtime style helpers', () => {
  it('honors color environment flags before TTY detection', () => {
    setTTY(process.stdout, true)
    vi.stubEnv('NO_COLOR', '1')
    expect(colorOn()).toBe(false)

    vi.stubEnv('NO_COLOR', undefined)
    setTTY(process.stdout, false)
    vi.stubEnv('CARACAL_COLOR', '1')
    expect(colorOn()).toBe(true)

    vi.stubEnv('CARACAL_COLOR', undefined)
    vi.stubEnv('FORCE_COLOR', '1')
    expect(style.selected('chosen')).toMatch(ansi)
    vi.stubEnv('CARACAL_NO_COLOR', 'true')
    expect(style.selected('chosen')).toBe('chosen')
  })

  it('renders all semantic style functions without color when disabled', () => {
    vi.stubEnv('NO_COLOR', '1')

    expect([
      style.success('a'),
      style.warn('a'),
      style.error('a'),
      style.info('a'),
      style.progress('a'),
      style.prompt('a'),
      style.header('a'),
      style.title('a'),
      style.label('a'),
      style.code('a'),
      style.diffAdd('a'),
      style.diffRemove('a'),
      style.debug('a'),
      style.accent('a'),
      style.dim('a'),
      style.kbd('a'),
      style.selected('a'),
      style.brand('a'),
      style.section('a'),
      style.command('a'),
      style.flag('a'),
    ]).toEqual(Array.from({ length: 21 }, () => 'a'))
  })

  it('writes semantic messages and scrubs secrets on stderr', () => {
    vi.stubEnv('NO_COLOR', '1')
    let stdout = ''
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })

    printSuccess('ready')
    printWarn('careful')
    printInfo('hello')
    printStep('next')
    printHeader('Runtime')
    printError('failed Bearer abcdefghijklmnopqrstuvwxyz')

    expect(stdout).toContain('ready')
    expect(stdout).toContain('careful')
    expect(stdout).toContain('hello')
    expect(stdout).toContain('next')
    expect(stdout).toContain('Runtime')
    expect(stderr).toContain('failed ***')
  })
})
