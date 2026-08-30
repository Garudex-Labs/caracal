// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deviceSessionIds,
  deviceSignature,
  groupSessionsByDevice,
  parseUserAgent,
  type RawSession,
} from "./devices.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const RETENTION = 30 * DAY;

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const CHROME_MAC_NEWER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";
const CLI_LINUX = "caracal/1.4.2 (linux; amd64)";

function session(over: Partial<RawSession> & { id: string }): RawSession {
  return {
    token: `tok-${over.id}`,
    userAgent: CHROME_MAC,
    ipAddress: "203.0.113.10",
    createdAt: new Date(NOW - DAY).toISOString(),
    updatedAt: new Date(NOW - DAY).toISOString(),
    expiresAt: new Date(NOW + 7 * DAY).toISOString(),
    ...over,
  };
}

function group(sessions: RawSession[], currentToken?: string) {
  return groupSessionsByDevice(sessions, { currentToken, retentionMs: RETENTION, now: NOW });
}

test("parseUserAgent extracts stable browser/OS families and ignores versions", () => {
  const chrome = parseUserAgent(CHROME_MAC);
  assert.equal(chrome.clientType, "browser");
  assert.equal(chrome.client, "Chrome");
  assert.equal(chrome.os, "macOS");
  assert.equal(chrome.label, "Chrome on macOS");
  // A newer Chrome build has the identical identity.
  assert.deepEqual(parseUserAgent(CHROME_MAC_NEWER), chrome);
});

test("parseUserAgent recognizes the Caracal CLI and other non-browser clients", () => {
  const cli = parseUserAgent(CLI_LINUX);
  assert.equal(cli.clientType, "cli");
  assert.equal(cli.client, "Caracal CLI");
  assert.equal(cli.os, "Linux");
  assert.equal(parseUserAgent("Go-http-client/1.1").clientType, "api");
});

test("parseUserAgent collapses empty/ambiguous agents to a single unknown identity", () => {
  const a = parseUserAgent("");
  const b = parseUserAgent(null);
  const c = parseUserAgent(undefined);
  assert.equal(a.clientType, "unknown");
  assert.equal(deviceSignature(a), deviceSignature(b));
  assert.equal(deviceSignature(b), deviceSignature(c));
});

test("repeated logins and renewals from one browser collapse to a single device", () => {
  const devices = group([
    session({ id: "s1", updatedAt: new Date(NOW - 3 * DAY).toISOString() }),
    session({ id: "s2", updatedAt: new Date(NOW - 2 * DAY).toISOString() }),
    session({ id: "s3", updatedAt: new Date(NOW - 1 * DAY).toISOString(), ipAddress: "198.51.100.4" }),
  ]);
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.sessionCount, 3);
  assert.equal(devices[0]!.activeSessionCount, 3);
  // Distinct IPs surfaced for investigation, newest first.
  assert.deepEqual(devices[0]!.ipAddresses, ["198.51.100.4", "203.0.113.10"]);
  // History is ordered newest-active first.
  assert.equal(devices[0]!.sessions[0]!.id, "s3");
});

test("browser device ids keep distinct browser profiles separate", () => {
  const devices = group([
    session({ id: "profile-a-1", deviceId: "device-a" }),
    session({ id: "profile-a-2", deviceId: "DEVICE-A", updatedAt: new Date(NOW).toISOString() }),
    session({ id: "profile-b", deviceId: "device-b" }),
  ]);
  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((d) => d.sessionCount).sort(), [1, 2]);
});

test("legacy sessions matching the current browser merge into the current device", () => {
  const devices = group(
    [
      session({ id: "legacy", updatedAt: new Date(NOW - 2 * DAY).toISOString() }),
      session({ id: "current", deviceId: "device-a", updatedAt: new Date(NOW).toISOString() }),
    ],
    "tok-current",
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.current, true);
  assert.equal(devices[0]!.sessionCount, 2);
});

test("different browsers, OSes and CLI clients are distinct devices", () => {
  const devices = group([
    session({ id: "chrome", userAgent: CHROME_MAC }),
    session({ id: "firefox", userAgent: FIREFOX_WIN }),
    session({ id: "cli", userAgent: CLI_LINUX }),
  ]);
  assert.equal(devices.length, 3);
  const labels = devices.map((d) => d.label).sort();
  assert.deepEqual(labels, ["Caracal CLI on Linux", "Chrome on macOS", "Firefox on Windows"]);
});

test("the current session marks exactly one device and one session, and it sorts first", () => {
  const devices = group(
    [
      session({ id: "firefox", userAgent: FIREFOX_WIN, updatedAt: new Date(NOW).toISOString() }),
      session({ id: "chrome-current", userAgent: CHROME_MAC, updatedAt: new Date(NOW - 5 * DAY).toISOString() }),
    ],
    "tok-chrome-current",
  );
  assert.equal(devices[0]!.current, true, "current device sorts first even if less recent");
  assert.equal(devices[0]!.sessions[0]!.current, true);
  assert.equal(devices[1]!.current, false);
  assert.equal(devices.filter((d) => d.current).length, 1);
});

test("expiry is reflected in active flags", () => {
  const devices = group([
    session({ id: "live", userAgent: FIREFOX_WIN, expiresAt: new Date(NOW + DAY).toISOString() }),
    session({
      id: "expired",
      userAgent: CHROME_MAC,
      updatedAt: new Date(NOW - DAY).toISOString(),
      expiresAt: new Date(NOW - DAY).toISOString(),
    }),
  ]);
  const live = devices.find((d) => d.label === "Firefox on Windows")!;
  const expired = devices.find((d) => d.label === "Chrome on macOS")!;
  assert.equal(live.active, true);
  assert.equal(expired.active, false);
  assert.equal(expired.activeSessionCount, 0);
});

test("retention drops ended sessions past the window but keeps boundary and active ones", () => {
  const devices = group([
    // Ended exactly at the retention edge - kept.
    session({
      id: "edge",
      userAgent: FIREFOX_WIN,
      updatedAt: new Date(NOW - RETENTION).toISOString(),
      expiresAt: new Date(NOW - RETENTION).toISOString(),
    }),
    // Ended one ms past the edge - dropped.
    session({
      id: "stale",
      userAgent: CHROME_MAC,
      updatedAt: new Date(NOW - RETENTION - 1).toISOString(),
      expiresAt: new Date(NOW - RETENTION - 1).toISOString(),
    }),
    // Very old but still active - always kept.
    session({
      id: "old-active",
      userAgent: CLI_LINUX,
      updatedAt: new Date(NOW - 200 * DAY).toISOString(),
      expiresAt: new Date(NOW + DAY).toISOString(),
    }),
  ]);
  const labels = devices.map((d) => d.label).sort();
  assert.deepEqual(labels, ["Caracal CLI on Linux", "Firefox on Windows"]);
});

test("sessions across different organizations from one device stay one device", () => {
  const devices = group([
    session({ id: "org-a", activeOrganizationId: "org-a" }),
    session({ id: "org-b", activeOrganizationId: "org-b", updatedAt: new Date(NOW).toISOString() }),
  ]);
  assert.equal(devices.length, 1, "activeOrganizationId is not part of device identity");
  assert.equal(devices[0]!.sessionCount, 2);
});

test("deviceSessionIds can exclude the current session for safe revocation", () => {
  const devices = group(
    [
      session({ id: "a", updatedAt: new Date(NOW - 2 * DAY).toISOString() }),
      session({ id: "b", updatedAt: new Date(NOW).toISOString() }),
    ],
    "tok-b",
  );
  const device = devices[0]!;
  assert.deepEqual(deviceSessionIds(device).sort(), ["a", "b"]);
  assert.deepEqual(deviceSessionIds(device, { excludeCurrent: true }), ["a"]);
});
