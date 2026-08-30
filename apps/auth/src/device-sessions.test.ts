// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Auth } from "./auth.js";
import { handleDeviceApi, type DeviceApiConfig } from "./device-sessions.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const CFG: DeviceApiConfig = { basePath: "/api/auth", retentionMs: 30 * DAY, now: () => NOW };

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

type Row = {
  id: string;
  token: string;
  userAgent: string;
  ipAddress: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

function row(id: string, ua: string): Row {
  return {
    id,
    token: `tok-${id}`,
    userAgent: ua,
    ipAddress: "203.0.113.9",
    createdAt: new Date(NOW - DAY).toISOString(),
    updatedAt: new Date(NOW - DAY).toISOString(),
    expiresAt: new Date(NOW + 7 * DAY).toISOString(),
  };
}

function fakeAuth(opts: {
  user: Record<string, unknown> | null;
  currentToken?: string;
  rows?: Row[];
  revoked?: string[];
}) {
  let rows = opts.rows ?? [];
  return {
    $context: Promise.resolve({
      internalAdapter: {
        listSessions: async () => rows,
        deleteSession: async (token: string) => {
          opts.revoked?.push(token);
          rows = rows.filter((r) => r.token !== token);
        },
      },
    }),
    api: {
      getSession: async () => (opts.user ? { user: opts.user, session: { token: opts.currentToken } } : null),
    },
  } as unknown as Auth;
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("unknown paths fall through to Better Auth", async () => {
  const res = await handleDeviceApi(fakeAuth({ user: null }), "/api/auth/sign-in", req("POST", "/api/auth/sign-in"), CFG);
  assert.equal(res, null);
});

test("GET /devices requires authentication", async () => {
  const res = await handleDeviceApi(fakeAuth({ user: null }), "/api/auth/devices", req("GET", "/api/auth/devices"), CFG);
  assert.equal(res!.status, 401);
});

test("GET /devices returns grouped devices with retention and current flag", async () => {
  const auth = fakeAuth({
    user: { id: "u1" },
    currentToken: "tok-chrome",
    rows: [row("chrome", CHROME_MAC), row("chrome2", CHROME_MAC), row("firefox", FIREFOX_WIN)],
  });
  const res = await handleDeviceApi(auth, "/api/auth/devices", req("GET", "/api/auth/devices"), CFG);
  assert.equal(res!.status, 200);
  const body = (await res!.json()) as { devices: Array<{ label: string; current: boolean; sessionCount: number }>; retention_days: number };
  assert.equal(body.retention_days, 30);
  assert.equal(body.devices.length, 2);
  assert.equal(body.devices[0]!.current, true, "current device first");
  assert.equal(body.devices[0]!.label, "Chrome on macOS");
  assert.equal(body.devices[0]!.sessionCount, 2);
  // Tokens are never exposed.
  assert.ok(!JSON.stringify(body).includes("tok-"));
});

test("POST /devices/{id}/revoke revokes only that device's sessions", async () => {
  const revoked: string[] = [];
  const auth = fakeAuth({
    user: { id: "u1" },
    currentToken: "tok-chrome",
    rows: [row("chrome", CHROME_MAC), row("firefox", FIREFOX_WIN), row("firefox2", FIREFOX_WIN)],
    revoked,
  });
  // Discover the firefox device id.
  const listRes = await handleDeviceApi(auth, "/api/auth/devices", req("GET", "/api/auth/devices"), CFG);
  const list = (await listRes!.json()) as { devices: Array<{ deviceId: string; label: string }> };
  const firefox = list.devices.find((d) => d.label === "Firefox on Windows")!;

  const path = `/api/auth/devices/${firefox.deviceId}/revoke`;
  const res = await handleDeviceApi(auth, path, req("POST", path), CFG);
  assert.equal(res!.status, 200);
  const body = (await res!.json()) as { revoked: number; devices: Array<{ label: string }> };
  assert.equal(body.revoked, 2);
  assert.ok(!body.devices.some((d) => d.label === "Firefox on Windows"), "response reflects the revoked device immediately");
  assert.deepEqual(revoked.sort(), ["tok-firefox", "tok-firefox2"]);
});

test("device revoke with scope=others spares the current session", async () => {
  const revoked: string[] = [];
  const auth = fakeAuth({
    user: { id: "u1" },
    currentToken: "tok-chrome",
    rows: [row("chrome", CHROME_MAC), row("chrome2", CHROME_MAC)],
    revoked,
  });
  const listRes = await handleDeviceApi(auth, "/api/auth/devices", req("GET", "/api/auth/devices"), CFG);
  const list = (await listRes!.json()) as { devices: Array<{ deviceId: string }> };
  const path = `/api/auth/devices/${list.devices[0]!.deviceId}/revoke`;
  const res = await handleDeviceApi(auth, path, req("POST", path, { scope: "others" }), CFG);
  assert.equal((await res!.json() as { revoked: number }).revoked, 1);
  assert.deepEqual(revoked, ["tok-chrome2"], "current session token kept");
});

test("current-device revoke requires scope=others", async () => {
  const revoked: string[] = [];
  const auth = fakeAuth({
    user: { id: "u1" },
    currentToken: "tok-chrome",
    rows: [row("chrome", CHROME_MAC), row("chrome2", CHROME_MAC)],
    revoked,
  });
  const listRes = await handleDeviceApi(auth, "/api/auth/devices", req("GET", "/api/auth/devices"), CFG);
  const list = (await listRes!.json()) as { devices: Array<{ deviceId: string }> };
  const path = `/api/auth/devices/${list.devices[0]!.deviceId}/revoke`;
  const res = await handleDeviceApi(auth, path, req("POST", path, {}), CFG);
  assert.equal(res!.status, 409);
  assert.deepEqual(revoked, []);
});

test("revoking an unowned device id is a 404", async () => {
  const auth = fakeAuth({ user: { id: "u1" }, currentToken: "tok-chrome", rows: [row("chrome", CHROME_MAC)] });
  const path = "/api/auth/devices/deadbeefdeadbeef/revoke";
  const res = await handleDeviceApi(auth, path, req("POST", path), CFG);
  assert.equal(res!.status, 404);
});

test("POST /device-sessions/{id}/revoke revokes one session by id", async () => {
  const revoked: string[] = [];
  const auth = fakeAuth({
    user: { id: "u1" },
    currentToken: "tok-chrome",
    rows: [row("chrome", CHROME_MAC), row("firefox", FIREFOX_WIN)],
    revoked,
  });
  const path = "/api/auth/device-sessions/firefox/revoke";
  const res = await handleDeviceApi(auth, path, req("POST", path), CFG);
  assert.equal(res!.status, 200);
  const body = (await res!.json()) as { devices: Array<{ sessions: Array<{ id: string }> }> };
  assert.ok(!body.devices.some((d) => d.sessions.some((s) => s.id === "firefox")), "response reflects the revoked session immediately");
  assert.deepEqual(revoked, ["tok-firefox"]);
});

test("revoking an unowned session id is a 404", async () => {
  const auth = fakeAuth({ user: { id: "u1" }, currentToken: "tok-chrome", rows: [row("chrome", CHROME_MAC)] });
  const path = "/api/auth/device-sessions/someone-elses/revoke";
  const res = await handleDeviceApi(auth, path, req("POST", path), CFG);
  assert.equal(res!.status, 404);
});

test("revoking the current session through the device API is rejected", async () => {
  const revoked: string[] = [];
  const auth = fakeAuth({ user: { id: "u1" }, currentToken: "tok-chrome", rows: [row("chrome", CHROME_MAC)], revoked });
  const path = "/api/auth/device-sessions/chrome/revoke";
  const res = await handleDeviceApi(auth, path, req("POST", path), CFG);
  assert.equal(res!.status, 409);
  assert.deepEqual(revoked, []);
});
