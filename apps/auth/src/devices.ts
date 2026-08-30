// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Device-centric view over Better Auth sessions.
 *
 * The security page represents a signed-in account by the distinct *devices*
 * that hold sessions, not by every raw authentication row. Better Auth stores
 * one session per login/renewal, so a single browser or CLI machine routinely
 * owns several session rows (repeated logins, token renewal, multiple tabs).
 * Showing each as its own line is noisy and makes it hard to answer the only
 * question a user actually has: "what is signed in to my account?".
 *
 * Grouping is derived from *stable* client characteristics parsed from the
 * user-agent - client kind (browser / CLI / API), browser family, and OS
 * family - never from the raw IP address alone, which changes constantly for
 * mobile and roaming clients and would both split one device and merge
 * unrelated ones. Version numbers are deliberately excluded from the identity
 * so a browser or CLI auto-update does not fork a device into two. IPs are
 * still surfaced per session for investigation, but they are not identity.
 *
 * This module is pure and deterministic so the grouping, current-device
 * detection, retention windowing, and expiry logic can be unit-tested without
 * a database or Better Auth runtime.
 */

import { createHash } from "node:crypto";

/** A raw Better Auth session row, narrowed to the fields grouping needs. */
export type RawSession = {
  id: string;
  token: string;
  deviceId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
  /** Present when the organization plugin is active; never part of device identity. */
  activeOrganizationId?: string | null;
};

export type ClientKind = "browser" | "cli" | "api" | "unknown";
export type DeviceForm = "desktop" | "mobile" | "cli" | "unknown";

/** Stable, display-friendly identity parsed from a user-agent string. */
export type DeviceIdentity = {
  clientType: ClientKind;
  /** Browser family or CLI/client name, without a version. */
  client: string;
  /** Operating-system family, without a version. */
  os: string;
  form: DeviceForm;
  /** Human label, e.g. "Chrome on macOS" or "Caracal CLI on Linux". */
  label: string;
};

/** One session as presented in a device's history. */
export type DeviceSession = {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ipAddress: string | null;
  current: boolean;
  active: boolean;
};

/** A device: one or more sessions sharing a stable client identity. */
export type Device = {
  deviceId: string;
  label: string;
  clientType: ClientKind;
  client: string;
  os: string;
  form: DeviceForm;
  /** True when this device holds the caller's current session. */
  current: boolean;
  /** True when the device has at least one unexpired session. */
  active: boolean;
  firstSeenAt: string;
  lastActiveAt: string;
  sessionCount: number;
  activeSessionCount: number;
  /** Distinct IPs seen for this device, newest first. For investigation only. */
  ipAddresses: string[];
  sessions: DeviceSession[];
};

export type GroupOptions = {
  /** Token of the caller's current session; marks the current device/session. */
  currentToken?: string | null;
  /** How far back ended/renewed sessions remain visible, in milliseconds. */
  retentionMs: number;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  now?: number;
};

function toMillis(value: string | Date): number {
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? 0 : t;
}

function toIso(value: string | Date): string {
  const t = toMillis(value);
  return new Date(t).toISOString();
}

const BROWSERS: Array<{ test: RegExp; name: string }> = [
  // Order matters: Edge and Opera masquerade as Chrome, Chrome as Safari.
  { test: /Edg(?:e|A|iOS)?\//, name: "Edge" },
  { test: /OPR\/|Opera/, name: "Opera" },
  { test: /Firefox\/|FxiOS\//, name: "Firefox" },
  { test: /Chrome\/|CriOS\//, name: "Chrome" },
  { test: /Safari\//, name: "Safari" },
];

const OSES: Array<{ test: RegExp; name: string }> = [
  { test: /Windows NT|Windows/i, name: "Windows" },
  { test: /Mac OS X|Macintosh|macOS|darwin/i, name: "macOS" },
  { test: /Android/i, name: "Android" },
  { test: /iPhone|iPad|iPod|iOS/i, name: "iOS" },
  { test: /CrOS|ChromeOS/i, name: "ChromeOS" },
  { test: /Linux/i, name: "Linux" },
];

/**
 * Parse a user-agent into a stable device identity. Unknown or empty agents
 * collapse to a single "Unknown client" identity rather than being treated as
 * distinct devices, so ambiguous rows do not fragment into noise.
 */
export function parseUserAgent(ua?: string | null): DeviceIdentity {
  const raw = (ua ?? "").trim();
  if (!raw) {
    return { clientType: "unknown", client: "Unknown client", os: "Unknown OS", form: "unknown", label: "Unknown client" };
  }

  // Non-browser clients: the Caracal CLI, generic HTTP libraries, and tools.
  const isBrowser = /Mozilla\/|AppleWebKit|Gecko\/|Chrome\/|Safari\/|Firefox\//.test(raw);
  if (!isBrowser) {
    const os = detectOs(raw);
    if (/caracal/i.test(raw)) {
      return { clientType: "cli", client: "Caracal CLI", os, form: "cli", label: os === "Unknown OS" ? "Caracal CLI" : `Caracal CLI on ${os}` };
    }
    if (/^(?:Go-http-client|curl|python-requests|okhttp|node-fetch|axios|PostmanRuntime|Wget)/i.test(raw)) {
      const name = raw.split(/[/\s]/)[0] || "API client";
      return { clientType: "api", client: name, os, form: "cli", label: os === "Unknown OS" ? name : `${name} on ${os}` };
    }
    const name = raw.split(/[/\s]/)[0]?.slice(0, 32) || "Unknown client";
    return { clientType: "api", client: name, os, form: "cli", label: os === "Unknown OS" ? name : `${name} on ${os}` };
  }

  const browser = BROWSERS.find((b) => b.test.test(raw))?.name ?? "Browser";
  const os = detectOs(raw);
  const form: DeviceForm = /Mobile|Android|iPhone|iPod/.test(raw) && !/iPad/.test(raw) ? "mobile" : "desktop";
  return {
    clientType: "browser",
    client: browser,
    os,
    form,
    label: os === "Unknown OS" ? browser : `${browser} on ${os}`,
  };
}

function detectOs(ua: string): string {
  return OSES.find((o) => o.test.test(ua))?.name ?? "Unknown OS";
}

/**
 * Deterministic device fingerprint derived only from stable identity fields.
 * Two logins from the same browser+OS (or the same CLI+OS) share a signature;
 * a browser update, a new IP, or a new session token does not change it.
 */
export function deviceSignature(identity: DeviceIdentity): string {
  const canonical = `${identity.clientType}\n${identity.client}\n${identity.os}`.toLowerCase();
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function sessionDeviceKey(session: RawSession, identity: DeviceIdentity, currentDeviceKey: string | null, currentIdentityKey: string | null): string {
  const storedDeviceId = session.deviceId?.trim().toLowerCase();
  if (storedDeviceId) return `device:${storedDeviceId}`;
  const legacyKey = `legacy:${deviceSignature(identity)}`;
  return currentDeviceKey && legacyKey === currentIdentityKey ? currentDeviceKey : legacyKey;
}

/**
 * Group sessions into devices.
 *
 * Sessions are kept when they are still active (unexpired) or when they ended
 * within the retention window; older rows are dropped so history stays a
 * bounded recent window rather than a permanent log. The current device sorts
 * first, then devices by most-recent activity.
 */
export function groupSessionsByDevice(sessions: RawSession[], opts: GroupOptions): Device[] {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.retentionMs;
  const currentToken = opts.currentToken ?? null;
  const currentRow = currentToken ? sessions.find((s) => s.token === currentToken) : undefined;
  const currentIdentity = currentRow ? parseUserAgent(currentRow.userAgent) : null;
  const currentStoredDeviceId = currentRow?.deviceId?.trim().toLowerCase();
  const currentDeviceKey = currentStoredDeviceId ? `device:${currentStoredDeviceId}` : null;
  const currentIdentityKey = currentIdentity ? `legacy:${deviceSignature(currentIdentity)}` : null;

  const byDevice = new Map<string, { identity: DeviceIdentity; rows: Array<{ session: DeviceSession; sort: number }> }>();

  for (const s of sessions) {
    const lastActive = toMillis(s.updatedAt);
    const expires = toMillis(s.expiresAt);
    const active = expires > now;
    // Keep active sessions always; retain ended ones only inside the window.
    if (!active && lastActive < cutoff) continue;

    const identity = parseUserAgent(s.userAgent);
  const key = sessionDeviceKey(s, identity, currentDeviceKey, currentIdentityKey);
    const bucket = byDevice.get(key) ?? { identity, rows: [] };
    bucket.rows.push({
      session: {
        id: s.id,
        createdAt: toIso(s.createdAt),
        lastActiveAt: toIso(s.updatedAt),
        expiresAt: toIso(s.expiresAt),
        ipAddress: s.ipAddress ?? null,
        current: currentToken != null && s.token === currentToken,
        active,
      },
      sort: lastActive,
    });
    byDevice.set(key, bucket);
  }

  const devices: Device[] = [];
  for (const [deviceId, bucket] of byDevice) {
    bucket.rows.sort((a, b) => b.sort - a.sort);
    const sessions = bucket.rows.map((r) => r.session);
    const lastActiveAt = sessions[0]?.lastActiveAt ?? new Date(now).toISOString();
    const firstSeenAt = sessions.reduce(
      (min, s) => (s.createdAt < min ? s.createdAt : min),
      sessions[0]?.createdAt ?? new Date(now).toISOString(),
    );
    const ipAddresses: string[] = [];
    for (const s of sessions) {
      if (s.ipAddress && !ipAddresses.includes(s.ipAddress)) ipAddresses.push(s.ipAddress);
    }
    devices.push({
      deviceId: createHash("sha256").update(deviceId).digest("hex").slice(0, 16),
      label: bucket.identity.label,
      clientType: bucket.identity.clientType,
      client: bucket.identity.client,
      os: bucket.identity.os,
      form: bucket.identity.form,
      current: sessions.some((s) => s.current),
      active: sessions.some((s) => s.active),
      firstSeenAt,
      lastActiveAt,
      sessionCount: sessions.length,
      activeSessionCount: sessions.filter((s) => s.active).length,
      ipAddresses,
      sessions,
    });
  }

  devices.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return b.lastActiveAt.localeCompare(a.lastActiveAt);
  });
  return devices;
}

/** Session ids belonging to a device, optionally excluding the current session. */
export function deviceSessionIds(device: Device, opts?: { excludeCurrent?: boolean }): string[] {
  return device.sessions
    .filter((s) => !(opts?.excludeCurrent && s.current))
    .map((s) => s.id);
}
