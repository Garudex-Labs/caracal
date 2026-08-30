// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/** Wire error shape returned by the device authorization endpoints. */
export type DeviceFlowError = {
  error?: string | null;
  error_description?: string | null;
} | null | undefined;

// The wire descriptions are developer-facing protocol text; every path a
// person can hit maps to guidance that names the next action instead.
export function friendlyDeviceError(err: DeviceFlowError): string {
  const code = err?.error ?? "";
  const description = err?.error_description ?? "";
  if (code === "expired_token" || /expired/i.test(description)) {
    return "This code has expired. Return to your terminal and start the login again to get a fresh code.";
  }
  if (/already processed/i.test(description)) {
    return "This code has already been used. Return to your terminal and start the login again.";
  }
  if (code === "access_denied" || /not authorized/i.test(description)) {
    return "This sign-in request belongs to a different account. Sign in with the account that ran the login.";
  }
  if (/invalid user code/i.test(description)) {
    return "That code doesn't match a pending sign-in. Check the code shown in your terminal and try again.";
  }
  if (code === "unauthorized" || /authentication required/i.test(description)) {
    return "Your session ended. Sign in again, then re-enter the code.";
  }
  return "Could not authorize the device. Return to your terminal and start the login again.";
}
