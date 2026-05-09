/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal drop-in client tests: env loading, header injection, ingress middleware.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Caracal,
  caracalHttpMiddleware,
  current,
  HeaderAgentSession,
  HeaderSubjectToken,
  HeaderHop,
} from "../../../../packages/sdk/ts/src/index.js";

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
  it("returns subject token when no context bound", () => {
    const c = new Caracal(dummyConfig);
    const h = c.headers();
    expect(h[HeaderSubjectToken]).toBe("tok");
    expect(h[HeaderHop]).toBe("0");
  });
});

describe("middleware + bindFromHeaders", () => {
  it("binds inbound envelope and runs handler with current() resolvable", async () => {
    const c = new Caracal(dummyConfig);
    let seen = "";
    const mw = caracalHttpMiddleware(c);
    await new Promise<void>((resolve, reject) => {
      mw(
        {
          headers: {
            [HeaderSubjectToken]: "inbound",
            [HeaderAgentSession]: "sess1",
            [HeaderHop]: "2",
          },
        },
        {},
        (err) => {
          if (err) return reject(err);
          try {
            const ctx = current();
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
    expect(calls[0].headers.get(HeaderSubjectToken)).toBe("tok");
  });
});
