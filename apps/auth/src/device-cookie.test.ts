// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVICE_ID_COOKIE, DEVICE_ID_HEADER, cookieValue, deviceIdFromHeaders, normalizeDeviceId } from "./device-cookie.js";

const ID = "7ba29b2e-0796-4e97-b547-ed79426e39a2";

test("normalizeDeviceId accepts UUID browser device identifiers only", () => {
  assert.equal(normalizeDeviceId(ID.toUpperCase()), ID);
  assert.equal(normalizeDeviceId("not-a-device-id"), null);
  assert.equal(normalizeDeviceId(""), null);
});

test("cookieValue extracts named cookies without depending on ordering", () => {
  const header = `theme=light; ${DEVICE_ID_COOKIE}=${encodeURIComponent(ID)}; other=1`;
  assert.equal(cookieValue(header, DEVICE_ID_COOKIE), ID);
  assert.equal(cookieValue(header, "missing"), null);
});

test("deviceIdFromHeaders prefers the explicit header and falls back to the cookie", () => {
  const fromCookie = new Headers({ cookie: `${DEVICE_ID_COOKIE}=${ID}` });
  assert.equal(deviceIdFromHeaders(fromCookie), ID);

  const headerId = "7b68ef41-2bf6-46bc-a441-c819160567da";
  const fromHeader = new Headers({
    [DEVICE_ID_HEADER]: headerId,
    cookie: `${DEVICE_ID_COOKIE}=${ID}`,
  });
  assert.equal(deviceIdFromHeaders(fromHeader), headerId);
});
