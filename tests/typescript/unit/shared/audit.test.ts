// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the centralized TypeScript audit client.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditClient, type AuditEvent, type AuditStreamer, createLogger } from '../../../../packages/core/ts/src/index.js'

class FakeStreamer implements AuditStreamer {
  calls: string[][] = []
  failNext = 0
  async xadd(stream: string, ...args: string[]): Promise<string> {
    if (this.failNext > 0) {
      this.failNext--
      throw new Error('redis down')
    }
    this.calls.push([stream, ...args])
    return '1-0'
  }
}

const baseEvent: AuditEvent = {
  id: 'ev-1',
  zone_id: 'z1',
  event_type: 'authorization_decision',
  request_id: 'r1',
  decision: 'allow',
  evaluation_status: 'success',
  determining_policies_json: [],
  diagnostics_json: {},
  occurred_at: new Date().toISOString(),
}

let dir: string
const logger = createLogger('test', 'fatal')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-audit-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AuditClient', () => {
  it('rejects construction without HMAC key in production', () => {
    expect(
      () =>
        new AuditClient({
          streamer: new FakeStreamer(),
          logger,
          replayDir: dir,
          production: true,
        }),
    ).toThrow(/hmacKey is required/)
  })

  it('rejects construction with a too-short HMAC key', () => {
    expect(
      () =>
        new AuditClient({
          streamer: new FakeStreamer(),
          logger,
          replayDir: dir,
          hmacKey: Buffer.from('short'),
        }),
    ).toThrow(/at least 32 bytes/)
  })

  it('signs events when HMAC key is present', async () => {
    const s = new FakeStreamer()
    const c = new AuditClient({
      streamer: s,
      logger,
      replayDir: dir,
      hmacKey: Buffer.alloc(32, 1),
      flushTtlMs: 5,
      flushBatch: 10,
    })
    await c.start()
    c.emit(baseEvent)
    await c.close()
    expect(s.calls.length).toBe(1)
    const fields = s.calls[0]!.slice(2)
    const sigIdx = fields.indexOf('sig')
    expect(sigIdx).toBeGreaterThan(-1)
    expect(fields[sigIdx + 1]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('persists batch to disk on sink failure', async () => {
    const s = new FakeStreamer()
    s.failNext = 100
    const c = new AuditClient({
      streamer: s,
      logger,
      replayDir: dir,
      flushTtlMs: 5,
    })
    await c.start()
    c.emit(baseEvent)
    await c.close()
    const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'))
    expect(files.length).toBeGreaterThan(0)
  })

  it('drops emit when buffer is full', async () => {
    const s = new FakeStreamer()
    s.failNext = 1_000_000
    const c = new AuditClient({
      streamer: s,
      logger,
      replayDir: dir,
      bufferCap: 2,
      flushBatch: 1_000_000,
      flushTtlMs: 1_000_000,
    })
    await c.start()
    for (let i = 0; i < 10; i++) c.emit(baseEvent)
    expect(c.dropped()).toBeGreaterThan(0)
    await c.close()
  })

  it('replays persisted batches on start', async () => {
    const s1 = new FakeStreamer()
    s1.failNext = 100
    const c1 = new AuditClient({ streamer: s1, logger, replayDir: dir, flushTtlMs: 5 })
    await c1.start()
    c1.emit(baseEvent)
    await c1.close()
    expect(readdirSync(dir).filter((f) => f.endsWith('.ndjson')).length).toBe(1)

    const s2 = new FakeStreamer()
    const c2 = new AuditClient({ streamer: s2, logger, replayDir: dir, flushTtlMs: 5 })
    await c2.start()
    await c2.close()
    expect(s2.calls.length).toBe(1)
    expect(readdirSync(dir).filter((f) => f.endsWith('.ndjson')).length).toBe(0)
  })
})
