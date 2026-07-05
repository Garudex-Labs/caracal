// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OpenTelemetry bootstrap helpers for Node.js services.

import { context, propagation, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

type Log = { error?: (msg: string, meta?: Record<string, unknown>) => void }
type FastifyLike = {
  addHook: (name: string, handler: (...args: unknown[]) => unknown) => void
}

const spanKey = Symbol('caracal.otel.span')

export function initNodeTelemetry(serviceName: string, log?: Log): () => Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!endpoint) return async () => {}
  const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim()
  if (protocol && protocol !== 'http/protobuf') {
    throw new Error(`unsupported OTEL_EXPORTER_OTLP_PROTOCOL ${protocol}`)
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes(resourceAttributes(serviceName)),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: traceUrl(endpoint) }))],
  })
  provider.register()
  return async () => {
    try {
      await provider.shutdown()
    } catch (err) {
      log?.error?.('telemetry shutdown failed', { err })
    }
  }
}

export function instrumentFastifyApp(app: FastifyLike, serviceName: string): void {
  const tracer = trace.getTracer(serviceName)
  app.addHook('onRequest', async (req: unknown) => {
    const request = req as {
      method?: string
      url?: string
      headers?: Record<string, string | string[] | undefined>
      [spanKey]?: Span
    }
    const method = request.method ?? 'GET'
    const path = String(request.url ?? '/').split('?')[0] || '/'
    const parent = propagation.extract(context.active(), normalizeHeaders(request.headers ?? {}))
    request[spanKey] = tracer.startSpan(`${method} ${path}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': method,
        'url.path': path,
      },
    }, parent)
  })
  app.addHook('onResponse', async (req: unknown, reply: unknown) => {
    const request = req as { [spanKey]?: Span }
    const response = reply as { statusCode?: number }
    const span = request[spanKey]
    if (!span) return
    const statusCode = response.statusCode ?? 200
    span.setAttribute('http.response.status_code', statusCode)
    if (statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR })
    }
    span.end()
  })
  app.addHook('onError', async (req: unknown, _reply: unknown, err: unknown) => {
    const request = req as { [spanKey]?: Span }
    const span = request[spanKey]
    if (!span) return
    if (err instanceof Error) {
      span.recordException(err)
    }
    span.setStatus({ code: SpanStatusCode.ERROR })
  })
}

function traceUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '')
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      out[key] = value.join(',')
    } else if (typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}

function resourceAttributes(serviceName: string): Record<string, string> {
  const attrs: Record<string, string> = { 'service.name': serviceName }
  for (const raw of (process.env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',')) {
    const [key, value] = raw.split('=', 2)
    if (key?.trim() && value?.trim()) {
      attrs[key.trim()] = value.trim()
    }
  }
  return attrs
}
