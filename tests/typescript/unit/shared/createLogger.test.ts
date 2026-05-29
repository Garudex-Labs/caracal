// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the structured JSON logger: level gating, redaction, trace fields, and child binding.

import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, runWithTrace } from '../../../../packages/core/ts/src/logging.js'

const SAVED = { ...process.env }

function capturingStream() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const raw of chunk.toString().split('\n')) {
        if (raw.trim()) lines.push(JSON.parse(raw))
      }
      cb()
    },
  })
  return { stream, lines }
}

afterEach(() => {
  process.env = { ...SAVED }
})

describe('createLogger', () => {
  it('emits bound base fields and the message', () => {
    const { stream, lines } = capturingStream()
    const log = createLogger('svc', { level: 'info', stream, hostname: 'h1', pid: 7, version: '1.2.3', env: 'test' })
    log.info('hello', { a: 1 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'info', service: 'svc', hostname: 'h1', pid: 7, version: '1.2.3', env: 'test', msg: 'hello', a: 1 })
  })

  it('drops records below the configured level', () => {
    const { stream, lines } = capturingStream()
    const log = createLogger('svc', { level: 'warn', stream })
    log.debug('debug-msg')
    log.info('info-msg')
    log.warn('warn-msg')
    log.error('error-msg')
    expect(lines.map((l) => l.msg)).toEqual(['warn-msg', 'error-msg'])
  })

  it('redacts secret-bearing fields', () => {
    const { stream, lines } = capturingStream()
    const log = createLogger('svc', { level: 'info', stream })
    log.info('auth', { password: 'hunter2', nested: { token: 'abc' }, ok: 'visible' })
    expect(lines[0].password).toBe('***')
    expect((lines[0].nested as Record<string, unknown>).token).toBe('***')
    expect(lines[0].ok).toBe('visible')
  })

  it('attaches trace ids when run inside a trace context', () => {
    const { stream, lines } = capturingStream()
    const log = createLogger('svc', { level: 'info', stream })
    runWithTrace({ traceId: 'tid', spanId: 'sid' }, () => log.info('traced'))
    expect(lines[0].trace_id).toBe('tid')
    expect(lines[0].span_id).toBe('sid')
  })

  it('creates child loggers that merge and redact bound fields', () => {
    const { stream, lines } = capturingStream()
    const child = createLogger('svc', { level: 'info', stream }).with({ requestId: 'r1', token: 'leak' })
    child.info('child-msg')
    expect(lines[0].requestId).toBe('r1')
    expect(lines[0].token).toBe('***')
  })

  it('falls back to the environment level when none is supplied', () => {
    process.env.CARACAL_LOG_LEVEL = 'error'
    const { stream, lines } = capturingStream()
    const log = createLogger('svc', { stream })
    log.warn('suppressed')
    log.error('shown')
    expect(lines.map((l) => l.msg)).toEqual(['shown'])
  })

  it('reports emitted counts through the metrics hook', () => {
    const { stream } = capturingStream()
    const log = createLogger('svc', { level: 'info', stream })
    const before = log.metrics().emitted
    log.info('count-me')
    expect(log.metrics().emitted).toBeGreaterThan(before)
  })
})
