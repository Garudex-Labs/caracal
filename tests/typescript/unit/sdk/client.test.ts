/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal drop-in client tests: env loading, header injection, ingress middleware.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Caracal,
  AgentKind,
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

  it("constructs a client-secret token source from env", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "fresh-root", expires_in: 900 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = Caracal.fromEnv({
      CARACAL_COORDINATOR_URL: "http://coord",
      CARACAL_ZONE_ID: "z",
      CARACAL_APPLICATION_ID: "app",
      CARACAL_APP_CLIENT_SECRET: "secret",
      CARACAL_STS_URL: "http://sts",
      CARACAL_RESOURCES: "calendar=https://api.example.com/v1,billing=https://billing.example.com",
    } as NodeJS.ProcessEnv);

    const headers = await c.headersAsync({ allowRoot: true });
    expect(headers[HeaderAuthorization]).toBe("Bearer fresh-root");
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("client_secret")).toBe("secret");
    expect(body.getAll("resource").sort()).toEqual(["billing", "calendar"]);
  });
});

describe("Caracal.headers", () => {
  it("refuses root headers without explicit opt-in", () => {
    const c = new Caracal(dummyConfig);
    expect(() => c.headers()).toThrow(/allowRoot/);
  });

  it("emits W3C envelope when root use is explicit", () => {
    const c = new Caracal(dummyConfig);
    const h = c.headers({ allowRoot: true });
    expect(h[HeaderAuthorization]).toBe("Bearer tok");
    expect(parseTraceparent(h[HeaderTraceparent]!)).toBeTruthy();
    expect(parseBaggage(h[HeaderBaggage])[BaggageHop]).toBe("0");
  });
});

describe("middleware + bindFromHeaders", () => {
  it("binds inbound W3C envelope and exposes claims through Caracal.current()", async () => {
    const c = new Caracal(dummyConfig);
    let seen = "";
    const mw = c.middleware();
    await new Promise<void>((resolve, reject) => {
      mw(
        {
          headers: {
            [HeaderAuthorization]: "Bearer    inbound   ",
            [HeaderTraceparent]:
              "00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01",
            [HeaderBaggage]: `${BaggageAgentSession}=sess1,${BaggageHop}=2`,
          },
        },
        {},
        (err) => {
          if (err) return reject(err);
          try {
            const ctx = c.current();
            if (!ctx) throw new Error("no context bound");
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

  it("rejects inbound requests without a bearer token by default", async () => {
    const c = new Caracal(dummyConfig);
    await expect(c.bindFromHeaders({}, async () => undefined)).rejects.toThrow(/missing a bearer token/);
  });
});

describe("caracal.transport", () => {
  it("refuses root transport without explicit opt-in", async () => {
    const c = new Caracal(dummyConfig);
    await expect(c.transport()("http://api/x")).rejects.toThrow(/allowRoot/);
  });

  it("auto-injects envelope headers on outbound calls", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = new Caracal({ ...dummyConfig, coordinator: { baseUrl: "http://c", fetchImpl: fakeFetch } });
    await c.transport({ allowRoot: true })("http://api/x");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get(HeaderAuthorization)).toBe("Bearer tok");
    expect(parseTraceparent(calls[0].headers.get(HeaderTraceparent)!)).toBeTruthy();
  });

  it("routes bound provider calls through the configured gateway", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = new Caracal({
      ...dummyConfig,
      coordinator: { baseUrl: "http://c", fetchImpl: fakeFetch },
      gatewayUrl: "https://gateway.example.com/proxy",
      resources: [{ resourceId: "calendar", upstreamPrefix: "https://api.example.com/v1" }],
    });

    await c.transport({ allowRoot: true })("https://api.example.com/v1/events?limit=10", {
      headers: { "x-existing": "1" },
    });

    expect(calls[0].url).toBe("https://gateway.example.com/proxy/events?limit=10");
    expect(calls[0].headers.get("X-Caracal-Resource")).toBe("calendar");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer tok");
    expect(calls[0].headers.get("x-existing")).toBe("1");
  });

  it("uses explicit resources for gateway calls without a matching binding", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = new Caracal({
      ...dummyConfig,
      coordinator: { baseUrl: "http://c", fetchImpl: fakeFetch },
      gatewayUrl: "https://gateway.example.com/proxy",
    });

    await c.transport({ allowRoot: true })("https://unbound.example.com/data", {
      headers: { "X-Caracal-Resource": "manual-resource" },
    });

    expect(calls[0].url).toBe("https://gateway.example.com/proxy/data");
    expect(calls[0].headers.get("X-Caracal-Resource")).toBe("manual-resource");
  });
});

describe("agent lifecycle and delegation", () => {
  it("fires lifecycle hooks, binds context, delegates, and terminates non-service agents", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      if (init.method === "POST" && String(input).endsWith("/agents")) {
        return new Response(JSON.stringify({ agent_session_id: "agent-1" }), { status: 200 });
      }
      if (init.method === "POST" && String(input).endsWith("/delegations")) {
        return new Response(JSON.stringify({ delegation_edge_id: "edge-1" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = new Caracal({
      ...dummyConfig,
      coordinator: { baseUrl: "https://coordinator.example.com", fetchImpl: fakeFetch },
      defaultKind: AgentKind.Ephemeral,
      defaultTtlSeconds: 60,
    });
    const events: string[] = [];
    c.onAgentStart((ctx) => { events.push(`start:${ctx.agentSessionId}`); });
    c.onAgentEnd((ctx) => { events.push(`end:${ctx.agentSessionId}`); });

    await c.spawn(async () => {
      expect(c.current()?.agentSessionId).toBe("agent-1");
      await c.delegate({
        to: "agent-2",
        toApplicationId: "app-2",
        scopes: ["tool:call"],
        ttlSeconds: 30,
      }, async () => {
        expect(c.current()?.delegationEdgeId).toBe("edge-1");
        expect(c.current()?.hop).toBe(1);
      });
    }, { metadata: { purpose: "test" } });

    expect(events).toEqual(["start:agent-1", "end:agent-1"]);
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "https://coordinator.example.com/zones/z/agents"],
      ["POST", "https://coordinator.example.com/zones/z/delegations"],
      ["DELETE", "https://coordinator.example.com/zones/z/agents/agent-1"],
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      application_id: "app",
      kind: AgentKind.Ephemeral,
      ttl_seconds: 60,
      metadata: { purpose: "test" },
    });
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({
      source_session_id: "agent-1",
      target_session_id: "agent-2",
      receiver_application_id: "app-2",
      scopes: ["tool:call"],
      ttl_seconds: 30,
    });
  });

  it("derives a stable Idempotency-Key on spawn when subjectSessionId or parentId is present", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      if (init.method === "POST" && String(input).endsWith("/agents")) {
        return new Response(JSON.stringify({ agent_session_id: "agent-1" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = new Caracal({
      ...dummyConfig,
      coordinator: { baseUrl: "https://coordinator.example.com", fetchImpl: fakeFetch },
    });
    await c.spawn(async () => { return; }, { subjectSessionId: "sid-1", parentId: "parent-1" });
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    const key = headers.get("idempotency-key");
    expect(key).toBeTruthy();
    expect(key!.length).toBe(64);
  });
});

describe("config resource sorting and token validation", () => {
  it("sorts bindings longest-prefix-first", () => {
    const c = new Caracal({
      ...dummyConfig,
      resources: [
        { resourceId: "short", upstreamPrefix: "https://api.example.com/v1" },
        { resourceId: "long", upstreamPrefix: "https://api.example.com/v1/accounts/treasury" },
        { resourceId: "mid", upstreamPrefix: "https://api.example.com/v1/accounts" },
      ],
    });
    expect(c.config.resources?.map((b) => b.resourceId)).toEqual(["long", "mid", "short"]);
  });

  it("rejects expired bootstrap JWT in fromEnv", () => {
    const header = Buffer.from('{"alg":"ES256"}').toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 1_000_000 })).toString("base64url");
    const token = `${header}.${payload}.sig`;
    expect(() => Caracal.fromEnv({
      CARACAL_COORDINATOR_URL: "http://coord",
      CARACAL_ZONE_ID: "z",
      CARACAL_APPLICATION_ID: "app",
      CARACAL_SUBJECT_TOKEN: token,
    } as NodeJS.ProcessEnv)).toThrow(/expired/);
  });

  it("rejects malformed CARACAL_RESOURCES at startup", () => {
    expect(() => Caracal.fromEnv({
      CARACAL_COORDINATOR_URL: "http://coord",
      CARACAL_ZONE_ID: "z",
      CARACAL_APPLICATION_ID: "app",
      CARACAL_SUBJECT_TOKEN: "tok",
      CARACAL_RESOURCES: "broken,calendar=not-a-url",
    } as NodeJS.ProcessEnv)).toThrow(/invalid CARACAL_RESOURCES/);
  });
});
