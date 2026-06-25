// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Browser-tier security primitives: hardening headers, same-origin enforcement, and request correlation.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { getTraceContext, parseTraceparent } from '@caracalai/core'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Tight default-src policy for the same-origin web image. Tailwind injects style attributes,
// so inline styles are permitted; scripts and network calls are confined to the served origin,
// which is also the backend-for-frontend, so the SPA never needs a cross-origin connect source.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
].join('; ')

export function method(req: IncomingMessage): string {
  return (req.method ?? 'GET').toUpperCase()
}

export function isSafeMethod(value: string): boolean {
  return SAFE_METHODS.has(value.toUpperCase())
}

export function isAllowedOrigin(origin: string | undefined, allowlist: readonly string[]): boolean {
  if (!origin) return false
  return allowlist.includes(origin)
}

// Enforces same-origin intent on state-changing requests. CORS gates response reads, not the
// sending of credentialed requests, so cookie-authenticated mutations must independently verify
// the browser Origin (falling back to Referer's origin) against the trusted allowlist. Safe
// methods are exempt; unsafe methods with no or a foreign origin are rejected.
export function isCrossSiteWrite(req: IncomingMessage, allowlist: readonly string[]): boolean {
  if (isSafeMethod(method(req))) return false
  const origin = headerValue(req, 'origin') ?? originFromReferer(req)
  return !isAllowedOrigin(origin, allowlist)
}

function originFromReferer(req: IncomingMessage): string | undefined {
  const referer = headerValue(req, 'referer')
  if (!referer) return undefined
  try {
    return new URL(referer).origin
  } catch {
    return undefined
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

// Baseline hardening applied to every response. CSP is added only to HTML documents so JSON
// API responses stay lean; the framing, sniffing, referrer, and transport protections apply
// uniformly. HSTS is emitted whenever the deployment is HTTPS (browsers ignore it over plain
// HTTP), instructing the browser to pin TLS for the public edge.
export function applySecurityHeaders(res: ServerResponse, opts: { html?: boolean; secure?: boolean } = {}): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  if (opts.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  }
  if (opts.html) {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  }
}

// Stable per-request correlation id. An inbound id from a trusted upstream proxy is honoured so
// the browser→edge→BFF→engine chain shares one identifier; otherwise a fresh id is minted.
export function requestId(req: IncomingMessage): string {
  const inbound = headerValue(req, 'x-request-id')
  if (inbound && /^[\w.-]{1,128}$/.test(inbound)) return inbound
  return randomUUID()
}

// Correlation headers forwarded to upstream engine services so a single browser action can be
// traced end to end. The active trace span (bound per request) is serialized as W3C traceparent
// when present; the request id is always propagated.
export function downstreamHeaders(id: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-request-id': id }
  const trace = getTraceContext()
  if (trace?.traceId && trace.traceId.length === 32) {
    const span = trace.spanId && trace.spanId.length === 16 ? trace.spanId : '0'.repeat(16)
    headers.traceparent = `00-${trace.traceId}-${span}-01`
  }
  return headers
}

export function traceFromRequest(req: IncomingMessage): ReturnType<typeof parseTraceparent> {
  return parseTraceparent(headerValue(req, 'traceparent'))
}

// Validates that a proxied path stays within an allowed prefix after URL normalization, closing a
// prefix-check bypass (e.g. `/v1/../metrics`) that would otherwise reach operational endpoints.
// Percent-encoded traversal and separators (`%2e`, `%2f`, `%5c`) are rejected outright so an
// encoded sequence the upstream might later decode cannot escape the prefix. Returns the safe
// absolute target, or undefined when the path escapes the allowed prefix.
export function safeTarget(base: string, rest: string, allowedPrefix: string): string | undefined {
  if (rest.includes('..')) return undefined
  if (/%2e|%2f|%5c/i.test(rest)) return undefined
  let resolved: URL
  try {
    resolved = new URL(base + rest)
  } catch {
    return undefined
  }
  if (!resolved.pathname.startsWith(allowedPrefix)) return undefined
  return resolved.toString()
}
