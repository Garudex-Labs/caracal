// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Device-grouped session API.
 *
 * These endpoints sit beside Better Auth's own session routes and present the
 * caller's sessions grouped by device (see devices.ts). They authenticate
 * exactly like the rest of the service - the session cookie or bearer token in
 * the request - and only ever act on the *authenticated user's own* sessions:
 * listSessions is user-scoped, so a device id or session id that the caller
 * does not own is simply absent and resolves to 404. Session tokens never
 * leave the server; revocation maps the public session id back to its token
 * internally.
 */

import type { Auth } from "./auth.js";
import { deviceSessionIds, groupSessionsByDevice, type Device, type RawSession } from "./devices.js";

export type DeviceApiConfig = {
  basePath: string;
  retentionMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

type CallerSessions = {
  currentToken: string | null;
  sessions: RawSession[];
  /** Public session id -> Better Auth session token, kept server-side only. */
  tokenById: Map<string, string>;
};

async function loadCallerSessions(auth: Auth, headers: Headers): Promise<CallerSessions | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  const ctx = await auth.$context;
  const userId = String((session.user as { id: string }).id);
  const list = (await ctx.internalAdapter.listSessions(userId)) as RawSession[];
  const tokenById = new Map<string, string>();
  for (const s of list) tokenById.set(s.id, s.token);
  return {
    currentToken: (session as { session?: { token?: string } }).session?.token ?? null,
    sessions: list,
    tokenById,
  };
}

function devicesFor(caller: CallerSessions, cfg: DeviceApiConfig): Device[] {
  return groupSessionsByDevice(caller.sessions, {
    currentToken: caller.currentToken,
    retentionMs: cfg.retentionMs,
    now: cfg.now?.(),
  });
}

async function revokeTokens(auth: Auth, tokens: string[]): Promise<number> {
  const ctx = await auth.$context;
  let revoked = 0;
  for (const token of tokens) {
    await ctx.internalAdapter.deleteSession(token);
    revoked += 1;
  }
  return revoked;
}

function devicesResponse(caller: CallerSessions, cfg: DeviceApiConfig): Record<string, unknown> {
  return {
    devices: devicesFor(caller, cfg),
    retention_days: Math.round(cfg.retentionMs / 86_400_000),
  };
}

/**
 * Route the device session API. Returns null when the path is not ours so the
 * caller can fall through to Better Auth's handler.
 */
export async function handleDeviceApi(
  auth: Auth,
  pathname: string,
  request: Request,
  cfg: DeviceApiConfig,
): Promise<Response | null> {
  const base = cfg.basePath;
  if (!pathname.startsWith(`${base}/`)) return null;
  const rest = pathname.slice(base.length); // e.g. "/devices" or "/devices/{id}/revoke"

  // GET /devices - grouped device list with bounded session history.
  if (rest === "/devices" && request.method === "GET") {
    const caller = await loadCallerSessions(auth, request.headers);
    if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });
    return Response.json(devicesResponse(caller, cfg));
  }

  // POST /devices/{deviceId}/revoke - revoke a device's sessions.
  const deviceRevoke = rest.match(/^\/devices\/([^/]+)\/revoke$/);
  if (deviceRevoke) {
    if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
    const caller = await loadCallerSessions(auth, request.headers);
    if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });
    const deviceId = decodeURIComponent(deviceRevoke[1] ?? "");
    const device = devicesFor(caller, cfg).find((d) => d.deviceId === deviceId);
    if (!device) return Response.json({ error: "device not found" }, { status: 404 });
    const body = await readBody(request);
    const excludeCurrent = body?.scope === "others";
    if (device.current && !excludeCurrent) {
      return Response.json({ error: "use sign out to revoke the current session" }, { status: 409 });
    }
    const ids = deviceSessionIds(device, { excludeCurrent });
    const tokens = ids.map((id) => caller.tokenById.get(id)).filter((t): t is string => Boolean(t));
    const revoked = await revokeTokens(auth, tokens);
    const updated = await loadCallerSessions(auth, request.headers);
    return Response.json({ ok: true, revoked, ...(updated ? devicesResponse(updated, cfg) : { devices: [], retention_days: Math.round(cfg.retentionMs / 86_400_000) }) });
  }

  // POST /device-sessions/{sessionId}/revoke - revoke a single session.
  const sessionRevoke = rest.match(/^\/device-sessions\/([^/]+)\/revoke$/);
  if (sessionRevoke) {
    if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
    const caller = await loadCallerSessions(auth, request.headers);
    if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });
    const sessionId = decodeURIComponent(sessionRevoke[1] ?? "");
    const token = caller.tokenById.get(sessionId);
    if (!token) return Response.json({ error: "session not found" }, { status: 404 });
    if (token === caller.currentToken) {
      return Response.json({ error: "use sign out to revoke the current session" }, { status: 409 });
    }
    const revoked = await revokeTokens(auth, [token]);
    const updated = await loadCallerSessions(auth, request.headers);
    return Response.json({ ok: true, revoked, ...(updated ? devicesResponse(updated, cfg) : { devices: [], retention_days: Math.round(cfg.retentionMs / 86_400_000) }) });
  }

  return null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
