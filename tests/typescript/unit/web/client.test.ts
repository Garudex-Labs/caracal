// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the web console HTTP client: error taxonomy, request timeout, and cancellation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleApiError, consoleApi } from "../../../../apps/web/src/platform/api/client.ts";

const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ConsoleApiError taxonomy", () => {
  it("classifies known control-plane states", () => {
    expect(new ConsoleApiError(503, "control_plane_not_configured").notConfigured).toBe(true);
    expect(new ConsoleApiError(502, "control_plane_unreachable").unreachable).toBe(true);
    expect(new ConsoleApiError(0, "timeout").timedOut).toBe(true);
    expect(new ConsoleApiError(0, "network_error").notConfigured).toBe(false);
  });
});

describe("request success and error mapping", () => {
  it("returns parsed JSON on success and includes credentials", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "z1", name: "Zone One" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const zone = await consoleApi.zones.get("z1");
    expect(zone).toEqual({ id: "z1", name: "Zone One" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a structured error body to a ConsoleApiError code", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(404, { error: "zone_not_found" })) as unknown as typeof fetch;
    await expect(consoleApi.zones.get("missing")).rejects.toMatchObject({
      status: 404,
      code: "zone_not_found",
    });
  });

  it("maps a thrown fetch (offline) to a network_error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(consoleApi.zones.get("z1")).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("request timeout", () => {
  it("maps an aborted fetch with no caller cancellation to a timeout error", async () => {
    // With no caller signal, an AbortError can only come from the composed request timeout, so
    // the client surfaces it as a reportable `timeout` rather than a silent cancellation.
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("timeout", "AbortError");
    }) as unknown as typeof fetch;
    await expect(consoleApi.zones.get("z1")).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("request cancellation", () => {
  it("propagates a caller abort as an AbortError, not a reportable failure", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;

    const pending = consoleApi.zones.list(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
