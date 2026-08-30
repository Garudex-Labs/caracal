// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { friendlyDeviceError } from "./device-flow.ts";

test("expired codes point back at the terminal", () => {
  const message = friendlyDeviceError({ error: "expired_token", error_description: "User code has expired" });
  assert.match(message, /expired/i);
  assert.match(message, /terminal/i);
});

test("already-processed codes ask for a new login", () => {
  const message = friendlyDeviceError({ error: "invalid_request", error_description: "Device code already processed" });
  assert.match(message, /already been used/i);
});

test("unclaimed-code protocol text never reaches the user", () => {
  const wire =
    "Device code has not been claimed by a verifying session; call `GET /device` with the `user_code` while signed in before approving or denying";
  const message = friendlyDeviceError({ error: "invalid_request", error_description: wire });
  assert.ok(!message.includes("GET /device"), message);
  assert.ok(!/claimed|verifying session/i.test(message), message);
  assert.match(message, /terminal/i);
});

test("foreign-account approvals name the account mismatch", () => {
  const message = friendlyDeviceError({
    error: "access_denied",
    error_description: "You are not authorized to approve this device authorization",
  });
  assert.match(message, /different account/i);
});

test("invalid codes ask the user to re-check the terminal code", () => {
  const message = friendlyDeviceError({ error: "invalid_request", error_description: "Invalid user code" });
  assert.match(message, /doesn't match|check the code/i);
});

test("missing session maps to a sign-in prompt", () => {
  const message = friendlyDeviceError({ error: "unauthorized", error_description: "Authentication required" });
  assert.match(message, /sign in/i);
});

test("unknown and empty errors fall back to actionable guidance", () => {
  for (const err of [null, undefined, {}, { error: "server_error", error_description: "boom" }]) {
    const message = friendlyDeviceError(err);
    assert.match(message, /terminal/i);
    assert.ok(!/boom/.test(message));
  }
});
