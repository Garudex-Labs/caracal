// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Control audit sink: payload construction, HMAC signing, and Redis emit paths.

import { createHmac } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { buildAuditPayload, newRequestId, RedisSink, type AuditEvent } from '../../../../../apps/api/src/control/audit.js'

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    at: new Date('2026-01-02T03:04:05.000Z'),
    zoneId: 'zone-1',
    clientId: 'app-1',
    subject: 'user-1',
    jti: 'jti-1',
    command: 'agent',
    subcommand: 'spawn',
    decision: 'allow',
    reason: 'ok',
    requestId: 'req-1',
    ...overrides,
  }
}

describe('newRequestId', () => {
  it('returns 32 hex characters and is unique per call', () => {
    const a = newRequestId()
    const b = newRequestId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildAuditPayload', () => {
  it('produces id and data with the embedded event fields', () => {
    const values = buildAuditPayload(event(), undefined)
    expect(values.id).toBe('req-1')
    const data = JSON.parse(values.data)
    expect(data.zone_id).toBe('zone-1')
    expect(data.event_type).toBe('control.invoke')
    expect(data.decision).toBe('allow')
    expect(data.occurred_at).toBe('2026-01-02T03:04:05.000Z')
    expect(data.metadata_json).toMatchObject({
      subject: 'user-1',
      jti: 'jti-1',
      client_id: 'app-1',
      command: 'agent',
      subcommand: 'spawn',
      reason: 'ok',
    })
  })

  it('records the authorizing actor as subject-asserted attribution', () => {
    const values = buildAuditPayload(event({ authorizedBy: 'account-7' }), undefined)
    expect(JSON.parse(values.data).metadata_json.authorized_by).toBe('account-7')
  })

  it('signs the data with HMAC-SHA256 when a key is supplied', () => {
    const key = Buffer.from('secret-key')
    const values = buildAuditPayload(event(), key)
    const expected = createHmac('sha256', key).update(values.data).digest('hex')
    expect(values.sig).toBe(expected)
  })

  it('omits the signature for an empty key', () => {
    expect(buildAuditPayload(event(), Buffer.alloc(0)).sig).toBeUndefined()
    expect(buildAuditPayload(event(), undefined).sig).toBeUndefined()
  })

  it('falls back to a generated id and unknown zone when fields are missing', () => {
    const values = buildAuditPayload(event({ requestId: '', zoneId: undefined }), undefined)
    expect(values.id).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(values.data).zone_id).toBe('unknown')
  })

  it('defaults optional metadata fields to empty strings', () => {
    const values = buildAuditPayload(
      event({ clientId: undefined, command: undefined, subcommand: undefined, reason: undefined }),
      undefined,
    )
    expect(JSON.parse(values.data).metadata_json).toMatchObject({
      client_id: '',
      command: '',
      subcommand: '',
      reason: '',
      authorized_by: '',
    })
  })
})

describe('RedisSink', () => {
  it('writes a capped stream entry with field/value pairs', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0')
    const sink = new RedisSink({ xadd } as never, Buffer.from('k'), { error: vi.fn() } as never, 500)
    await sink.emit(event())
    expect(xadd).toHaveBeenCalledOnce()
    const args = xadd.mock.calls[0] as string[]
    expect(args[0]).toContain('audit')
    expect(args).toContain('MAXLEN')
    expect(args).toContain('500')
    expect(args).toContain('id')
    expect(args).toContain('data')
    expect(args).toContain('sig')
  })

  it('logs and swallows errors so emit never throws', async () => {
    const error = vi.fn()
    const xadd = vi.fn().mockRejectedValue(new Error('redis down'))
    const sink = new RedisSink({ xadd } as never, undefined, { error } as never)
    await expect(sink.emit(event())).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0][1]).toMatchObject({ request_id: 'req-1' })
  })
})
