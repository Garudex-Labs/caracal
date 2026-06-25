// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the browser-tier security primitives: origin enforcement, hardening headers, and correlation.

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { runWithTrace } from "../../../../packages/core/ts/src/logging.ts";
import {
  applySecurityHeaders,
  downstreamHeaders,
  isAllowedOrigin,
  isCrossSiteWrite,
  isSafeMethod,
  method,
  requestId,
  traceFromRequest,
} from "../../../../apps/auth/src/security.ts";

const ALLOW = ["https://app.example.com"];

function req(opts: { method?: string; headers?: Record<string, string> }): IncomingMessage {
  return { method: opts.method, headers: opts.headers ?? {} } as unknown as IncomingMessage;
}

function res(): { headers: Record<string, string>; setHeader: (k: string, v: string) => void } {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (k, v) => { headers[k.toLowerCase()] = String(v); } };
}

describe("method and isSafeMethod", () => {
  it("normalizes the method and defaults to GET", () => {
    expect(method(req({ method: "post" }))).toBe("POST");
    expect(method(req({}))).toBe("GET");
  });

  it("treats GET, HEAD, and OPTIONS as safe", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("head")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    expect(isSafeMethod("POST")).toBe(false);
    expect(isSafeMethod("DELETE")).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("matches only origins on the allowlist", () => {
    expect(isAllowedOrigin("https://app.example.com", ALLOW)).toBe(true);
    expect(isAllowedOrigin("https://evil.example", ALLOW)).toBe(false);
    expect(isAllowedOrigin(undefined, ALLOW)).toBe(false);
  });
});

describe("isCrossSiteWrite", () => {
  it("never blocks safe methods regardless of origin", () => {
    expect(isCrossSiteWrite(req({ method: "GET", headers: { origin: "https://evil.example" } }), ALLOW)).toBe(false);
    expect(isCrossSiteWrite(req({ method: "HEAD" }), ALLOW)).toBe(false);
  });

  it("allows a same-origin write", () => {
    expect(isCrossSiteWrite(req({ method: "POST", headers: { origin: "https://app.example.com" } }), ALLOW)).toBe(false);
  });

  it("blocks a cross-site write", () => {
    expect(isCrossSiteWrite(req({ method: "POST", headers: { origin: "https://evil.example" } }), ALLOW)).toBe(true);
  });

  it("blocks an unsafe method with no Origin header (CSRF without a preflight)", () => {
    expect(isCrossSiteWrite(req({ method: "DELETE" }), ALLOW)).toBe(true);
  });

  it("falls back to the Referer origin when Origin is absent", () => {
    expect(
      isCrossSiteWrite(req({ method: "POST", headers: { referer: "https://app.example.com/zones" } }), ALLOW),
    ).toBe(false);
    expect(
      isCrossSiteWrite(req({ method: "POST", headers: { referer: "https://evil.example/x" } }), ALLOW),
    ).toBe(true);
  });
});

describe("applySecurityHeaders", () => {
  it("always sets framing, sniffing, and referrer protections", () => {
    const r = res();
    applySecurityHeaders(r as unknown as ServerResponse);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("adds CSP only for HTML documents", () => {
    const html = res();
    applySecurityHeaders(html as unknown as ServerResponse, { html: true });
    expect(html.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    const json = res();
    applySecurityHeaders(json as unknown as ServerResponse, { html: false });
    expect(json.headers["content-security-policy"]).toBeUndefined();
  });

  it("emits HSTS only when the deployment is secure", () => {
    const secure = res();
    applySecurityHeaders(secure as unknown as ServerResponse, { secure: true });
    expect(secure.headers["strict-transport-security"]).toContain("max-age=");
    const plain = res();
    applySecurityHeaders(plain as unknown as ServerResponse, { secure: false });
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("requestId", () => {
  it("honors a well-formed inbound id", () => {
    expect(requestId(req({ headers: { "x-request-id": "abc-123.DEF" } }))).toBe("abc-123.DEF");
  });

  it("mints a fresh id when the inbound id is missing or malformed", () => {
    expect(requestId(req({}))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId(req({ headers: { "x-request-id": "bad id with spaces" } }))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("downstreamHeaders and traceFromRequest", () => {
  it("always forwards the request id", () => {
    expect(downstreamHeaders("rid-1")).toEqual({ "x-request-id": "rid-1" });
  });

  it("serializes the bound trace context as W3C traceparent", () => {
    const traceId = "a".repeat(32);
    const spanId = "b".repeat(16);
    const headers = runWithTrace({ traceId, spanId }, () => downstreamHeaders("rid-2"));
    expect(headers["x-request-id"]).toBe("rid-2");
    expect(headers.traceparent).toBe(`00-${traceId}-${spanId}-01`);
  });

  it("parses an inbound traceparent into a trace context", () => {
    const traceId = "c".repeat(32);
    const spanId = "d".repeat(16);
    const tc = traceFromRequest(req({ headers: { traceparent: `00-${traceId}-${spanId}-01` } }));
    expect(tc.traceId).toBe(traceId);
    expect(tc.spanId).toBe(spanId);
  });
});
