// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Session-guarded backend-for-frontend that proxies the Community Edition web client to the Caracal admin API.

import type { IncomingMessage, ServerResponse } from "node:http";
import { discoverAdminToken, discoverCoordinatorToken } from "@caracalai/core";
import { runDoctorDiagnostics, type DoctorReport } from "@caracalai/engine";

import { auth } from "./auth.ts";

const API_PREFIX = "/api/console";
const COORD_PREFIX = "/api/console/coord";
const DEFAULT_API_URL = "http://localhost:3000";
const DEFAULT_COORDINATOR_URL = "http://localhost:4000";
const PROBE_TIMEOUT_MS = 2_500;
const PROXY_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000;

function apiUrl(): string {
  return (process.env.CARACAL_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
}

function coordinatorUrl(): string {
  return (process.env.CARACAL_COORDINATOR_URL ?? DEFAULT_COORDINATOR_URL).replace(/\/$/, "");
}

function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function adminToken(): string | undefined {
  return discoverAdminToken(undefined, { preferGenerated: isLocalUrl(apiUrl()) });
}

function coordinatorToken(): string | undefined {
  return discoverCoordinatorToken(undefined, { preferGenerated: isLocalUrl(coordinatorUrl()) });
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function probeReachable(base: string, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/ready`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Reports whether the control plane is configured and reachable so the web
// client can show an honest connection state instead of fabricated data.
async function handleStatus(res: ServerResponse): Promise<void> {
  const base = apiUrl();
  const token = adminToken();
  const coordBase = coordinatorUrl();
  const coordTok = coordinatorToken();
  const coordinatorConfigured = Boolean(coordTok);
  const coordinatorReachable = coordTok ? await probeReachable(coordBase, coordTok) : false;
  if (!token) {
    sendJson(res, 200, {
      configured: false,
      reachable: false,
      apiUrl: base,
      coordinatorConfigured,
      coordinatorReachable,
      coordinatorUrl: coordBase,
    });
    return;
  }
  const reachable = await probeReachable(base, token);
  sendJson(res, 200, {
    configured: true,
    reachable,
    apiUrl: base,
    coordinatorConfigured,
    coordinatorReachable,
    coordinatorUrl: coordBase,
  });
}

// Full control-plane diagnostics: the same checks the Console `doctor` runs, surfaced
// to the web client so platform health lives in one place. The report is comparatively
// expensive (it probes every service and walks each zone), so a short in-process cache
// absorbs the navbar's background polling without hammering the control plane.
const DIAGNOSTICS_TTL_MS = 8_000;
interface DiagnosticsCacheEntry {
  at: number;
  payload: DoctorReport & { generatedAt: string };
}
const diagnosticsCache = new Map<string, DiagnosticsCacheEntry>();
const diagnosticsInFlight = new Map<string, Promise<DiagnosticsCacheEntry>>();

interface DiagnosticsOptions {
  zoneId?: string;
  strict: boolean;
  preflightOnly: boolean;
}

function parseDiagnosticsOptions(path: string): DiagnosticsOptions {
  const query = path.includes("?") ? new URLSearchParams(path.slice(path.indexOf("?") + 1)) : new URLSearchParams();
  return {
    zoneId: query.get("zone") ?? undefined,
    strict: query.get("strict") === "true",
    preflightOnly: query.get("mode") === "preflight",
  };
}

function diagnosticsCacheKey(options: DiagnosticsOptions): string {
  return `${options.preflightOnly ? "preflight" : "system"}:${options.strict ? "strict" : "lax"}:${options.zoneId ?? "all"}`;
}

async function computeDiagnostics(options: DiagnosticsOptions): Promise<DiagnosticsCacheEntry> {
  const report = await runDoctorDiagnostics({
    zoneId: options.preflightOnly ? undefined : options.zoneId,
    strict: options.strict,
    preflightOnly: options.preflightOnly,
  });
  const generatedAt = new Date().toISOString();
  return { at: Date.now(), payload: { ...report, generatedAt } };
}

async function handleDiagnostics(res: ServerResponse, path: string): Promise<void> {
  if (!adminToken()) {
    sendJson(res, 503, { error: "control_plane_not_configured" });
    return;
  }
  const options = parseDiagnosticsOptions(path);
  const key = diagnosticsCacheKey(options);
  const cached = diagnosticsCache.get(key);
  const fresh = cached && Date.now() - cached.at < DIAGNOSTICS_TTL_MS;
  if (!fresh) {
    let inFlight = diagnosticsInFlight.get(key);
    if (!inFlight) {
      inFlight = computeDiagnostics(options).finally(() => {
        diagnosticsInFlight.delete(key);
      });
      diagnosticsInFlight.set(key, inFlight);
    }
    try {
      diagnosticsCache.set(key, await inFlight);
    } catch {
      sendJson(res, 502, { error: "diagnostics_failed" });
      return;
    }
  }
  const entry = diagnosticsCache.get(key);
  if (!entry) {
    sendJson(res, 502, { error: "diagnostics_failed" });
    return;
  }
  sendJson(res, 200, entry.payload);
}

async function forwardProxy(
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  token: string,
): Promise<void> {
  const method = req.method ?? "GET";
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(req);
    if (body.length > 0) headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      signal: controller.signal,
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    res.setHeader("Cache-Control", "no-store");
    // Surface keyset pagination to the browser. The control plane advertises the next
    // page through a same-origin Link header; without forwarding it the web client
    // silently truncates large lists at the server default page size.
    const link = upstream.headers.get("link");
    if (link) res.setHeader("Link", link);
    res.end(text);
  } catch {
    sendJson(res, 502, { error: "upstream_unreachable" });
  } finally {
    clearTimeout(timer);
  }
}

async function handleProxy(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
  const token = adminToken();
  if (!token) {
    sendJson(res, 503, { error: "control_plane_not_configured" });
    return;
  }
  await forwardProxy(req, res, `${apiUrl()}${rest}`, token);
}

// Proxies the agent and delegation runtime surfaces served by the Coordinator.
async function handleCoordProxy(
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
): Promise<void> {
  const token = coordinatorToken();
  if (!token) {
    sendJson(res, 503, { error: "coordinator_not_configured" });
    return;
  }
  await forwardProxy(req, res, `${coordinatorUrl()}${rest}`, token);
}

// Returns true when the request was a console route and has been handled.
export async function handleConsole(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith(API_PREFIX)) return false;

  const session = await validateSession(req);
  if (!session) {
    sendJson(res, 401, { error: "unauthenticated" });
    return true;
  }

  if (url.startsWith(`${COORD_PREFIX}/`)) {
    await handleCoordProxy(req, res, url.slice(COORD_PREFIX.length));
    return true;
  }

  const path = url.slice(API_PREFIX.length);
  if (path === "/status" || path.startsWith("/status?")) {
    await handleStatus(res);
    return true;
  }
  if (path === "/diagnostics" || path.startsWith("/diagnostics?")) {
    await handleDiagnostics(res, path);
    return true;
  }
  if (path.startsWith("/v1/")) {
    await handleProxy(req, res, path);
    return true;
  }

  sendJson(res, 404, { error: "not_found" });
  return true;
}
