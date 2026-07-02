/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the edition-agnostic authentication boundary the UI depends on.
*/
import { authClient } from "@/editions/community/auth/client";
import { config } from "@/platform/config";

export const auth = authClient;
export const {
  useSession,
  signIn,
  signUp,
  signOut,
  getSession,
  updateUser,
  changePassword,
  requestPasswordReset,
  resetPassword,
  listSessions,
  revokeSession,
  revokeOtherSessions,
} = authClient;

export type Operator = {
  id: string;
  name: string;
  email: string;
};

export type SocialProvider = "google" | "github";

export interface EnabledProviders {
  email: boolean;
  google: boolean;
  github: boolean;
  passwordReset: boolean;
}

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "AuthApiError";
  }
}

export async function fetchEnabledProviders(): Promise<EnabledProviders> {
  try {
    const response = await fetch(`${config.authBaseUrl}/providers`, {
      credentials: "include",
    });
    if (!response.ok) throw new Error("providers request failed");
    return (await response.json()) as EnabledProviders;
  } catch {
    return { email: true, google: false, github: false, passwordReset: false };
  }
}

export async function deleteAccount(confirmEmail: string): Promise<void> {
  const response = await fetch(`${config.authBaseUrl}/account`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmEmail }),
  });
  if (response.status === 204) return;
  let code = response.statusText || "request_failed";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    code = response.statusText || "request_failed";
  }
  throw new AuthApiError(response.status, code);
}
