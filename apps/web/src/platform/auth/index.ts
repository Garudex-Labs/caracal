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
}

export async function fetchEnabledProviders(): Promise<EnabledProviders> {
  try {
    const response = await fetch(`${config.authBaseUrl}/providers`, {
      credentials: "include",
    });
    if (!response.ok) throw new Error("providers request failed");
    return (await response.json()) as EnabledProviders;
  } catch {
    return { email: true, google: false, github: false };
  }
}
