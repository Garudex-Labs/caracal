/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal drop-in client tests: env loading, header injection, ingress middleware.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Caracal,
} from "../../../../packages/sdk/ts/src/index.js";
import {
  HeaderAuthorization,
  HeaderTraceparent,
  HeaderBaggage,
  BaggageAgentSession,
  BaggageHop,
  parseBaggage,
  parseTraceparent,
} from "../../../../packages/sdk/ts/src/advanced.js";

const dummyConfig = {
  coordinator: { baseUrl: "http://coord" },
  zoneId: "z",
  applicationId: "app",
  subjectToken: "tok",
};

describe("Caracal.fromEnv", () => {
  it("throws on missing vars", () => {
    expect(() => Caracal.fromEnv({})).toThrow(/CARACAL_/);
  });

  it("constructs from env", () => {
    const c = Caracal.fromEnv({
      CARACAL_COORDINATOR_URL: "http://x",
      CARACAL_ZONE_ID: "z1",
      CARACAL_APPLICATION_ID: "a1",
      CARACAL_SUBJECT_TOKEN: "t1",
    });
    expect(c.config.zoneId).toBe("z1");
    expect(c.config.subjectToken).toBe("t1");
  });
});

describe("Caracal.headers", () => {
  it("emits W3C envelope when no context bound", () => {
    const c = new Caracal(dummyConfig);
    const h = c.headers();
    expect(h[HeaderAuthorization]).toBe("Bearer tok");
    expect(parseTraceparent(h[HeaderTraceparent]!)).toBeTruthy();
    expect(parseBaggage(h[HeaderBaggage])[BaggageHop]).toBe("0");
  });
});

describe("middleware + bindFromHeaders", () => {
  it("binds inbound W3C envelope and exposes claims through Caracal.context()", async () => {
    const c = new Caracal(dummyConfig);
    let seen = "";
    const mw = c.middleware();
    await new Promise<void>((resolve, reject) => {
      mw(
        {
          headers: {
            [HeaderAuthorization]: "Bearer inbound",
            [HeaderTraceparent]:
              "00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01",
            [HeaderBaggage]: `${BaggageAgentSession}=sess1,${BaggageHop}=2`,
          },
        },
        {},
        (err) => {
          if (err) return reject(err);
          try {
            const ctx = c.context();
            seen = `${ctx.subjectToken}|${ctx.agentSessionId}|${ctx.hop}`;
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      );
    });
    expect(seen).toBe("inbound|sess1|2");
  });
});

describe("caracal.fetch", () => {
  it("auto-injects envelope headers on outbound calls", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fakeFetch = vi.fn(async (input: any, init: any) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = new Caracal({ ...dummyConfig, coordinator: { baseUrl: "http://c", fetchImpl: fakeFetch } });
    await c.fetch("http://api/x");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get(HeaderAuthorization)).toBe("Bearer tok");
    expect(parseTraceparent(calls[0].headers.get(HeaderTraceparent)!)).toBeTruthy();
  });
});
