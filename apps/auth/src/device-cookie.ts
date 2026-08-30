// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

export const DEVICE_ID_COOKIE = "caracal_device_id";
export const DEVICE_ID_HEADER = "x-caracal-device-id";

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeDeviceId(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && DEVICE_ID_RE.test(trimmed) ? trimmed : null;
}

export function cookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

export function deviceIdFromHeaders(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  return normalizeDeviceId(headers.get(DEVICE_ID_HEADER)) ?? normalizeDeviceId(cookieValue(headers.get("cookie"), DEVICE_ID_COOKIE));
}
