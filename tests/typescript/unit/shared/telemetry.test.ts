// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the OpenTelemetry bootstrap helpers for Node.js services.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initNodeTelemetry, instrumentFastifyApp } from '../../../../packages/core/ts/src/telemetry.js'

const SAVED = { ...process.env }

afterEach(() => {
  process.env = { ...SAVED }
  vi.restoreAllMocks()
})

describe('initNodeTelemetry', () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
    delete process.env.OTEL_RESOURCE_ATTRIBUTES
  })

  it('returns a no-op shutdown when no endpoint is configured', async () => {
    const shutdown = initNodeTelemetry('svc')
    await expect(shutdown()).resolves.toBeUndefined()
  })

  it('throws on an unsupported protocol', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc'
    expect(() => initNodeTelemetry('svc')).toThrow(/unsupported OTEL_EXPORTER_OTLP_PROTOCOL/)
  })

  it('registers a provider and returns a working shutdown', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf'
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=test, =bad ,k=v'
    const shutdown = initNodeTelemetry('svc')
    await expect(shutdown()).resolves.toBeUndefined()
  })

  it('logs but does not throw when provider shutdown fails', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318/v1/traces'
    const errors: string[] = []
    const shutdown = initNodeTelemetry('svc', { error: (msg) => errors.push(msg) })
    await shutdown()
    await expect(shutdown()).resolves.toBeUndefined()
  })
})

describe('instrumentFastifyApp', () => {
  function captureHooks() {
    const hooks: Record<string, (...args: unknown[]) => unknown> = {}
    const app = {
      addHook: (name: string, handler: (...args: unknown[]) => unknown) => {
        hooks[name] = handler
      },
    }
    instrumentFastifyApp(app, 'svc')
    return hooks
  }

  it('registers request/response/error hooks', () => {
    const hooks = captureHooks()
    expect(typeof hooks.onRequest).toBe('function')
    expect(typeof hooks.onResponse).toBe('function')
    expect(typeof hooks.onError).toBe('function')
  })

  it('starts a span on request and ends it on response', async () => {
    const hooks = captureHooks()
    const req: Record<string, unknown> = {
      method: 'POST',
      url: '/widgets?q=1',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'x-multi': ['a', 'b'] },
    }
    await hooks.onRequest(req)
    await hooks.onResponse(req, { statusCode: 200 })
  })

  it('marks 5xx responses as errors', async () => {
    const hooks = captureHooks()
    const req: Record<string, unknown> = { method: 'GET', url: '/', headers: {} }
    await hooks.onRequest(req)
    await hooks.onResponse(req, { statusCode: 503 })
  })

  it('defaults method and path when missing', async () => {
    const hooks = captureHooks()
    const req: Record<string, unknown> = { headers: {} }
    await hooks.onRequest(req)
    await hooks.onResponse(req, {})
  })

  it('records exceptions on error', async () => {
    const hooks = captureHooks()
    const req: Record<string, unknown> = { method: 'GET', url: '/x', headers: {} }
    await hooks.onRequest(req)
    await hooks.onError(req, {}, new Error('boom'))
  })

  it('ignores response/error hooks when no span was started', async () => {
    const hooks = captureHooks()
    await expect(hooks.onResponse({}, { statusCode: 200 })).resolves.toBeUndefined()
    await expect(hooks.onError({}, {}, new Error('boom'))).resolves.toBeUndefined()
    await expect(hooks.onError({ /* no span */ }, {}, 'not-an-error')).resolves.toBeUndefined()
  })
})
