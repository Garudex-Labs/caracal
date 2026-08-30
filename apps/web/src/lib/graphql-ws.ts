// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createClient, type Client } from "graphql-ws";
import { clearSession, getAccessToken } from "@/lib/api";
import { sessionExpiredLoginUrl } from "@/lib/safe-next";
import { getTenant } from "@/lib/tenant-host";

function getWsUrl(): string {
  const api =
    import.meta.env.VITE_API_URL ||
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:8080");
  return api.replace(/^http/, "ws") + "/api/v1/graphql";
}

let client: Client | null = null;

function handleSubscriptionAuthError(err: unknown) {
  const msg = String(err ?? "").toLowerCase();
  if (
    msg.includes("not authenticated") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid token") ||
    msg.includes("token expired")
  ) {
    clearSession();
    if (typeof window !== "undefined") {
      window.location.href = sessionExpiredLoginUrl();
    }
  }
}

function getClient(): Client {
  if (!client) {
    client = createClient({
      url: getWsUrl(),
      connectionParams: () => {
        const token = getAccessToken();
    const { hostOrg, urlProject } = getTenant();
    const organization = hostOrg ?? localStorage.getItem("caracal_current_org") ?? "";
    return token && organization && urlProject
      ? { authorization: `Bearer ${token}`, organization, project: urlProject }
      : {};
      },
      lazy: true,
      retryAttempts: 5,
    });
  }
  return client;
}

/** Subscribe to one subscription field; the payload type is asserted at this single boundary. */
function subscribeToField<TPayload>(
  query: string,
  field: string,
  onPayload: (payload: TPayload) => void,
): () => void {
  return getClient().subscribe(
    { query },
    {
      next: (value) => {
        const payload = (value.data as Record<string, TPayload | undefined> | null | undefined)?.[field];
        if (payload) onPayload(payload);
      },
      error: handleSubscriptionAuthError,
      complete: () => {},
    },
  );
}

export function subscribeToSessionUpdates(
  onEvent: (sessionId: string, eventName: string) => void,
): () => void {
  return subscribeToField<{ sessionId: string; eventName: string }>(
    `subscription SessionUpdated($sessionId: String) {
      sessionUpdated(sessionId: $sessionId) {
        sessionId
        eventName
      }
    }`,
    "sessionUpdated",
    (payload) => onEvent(payload.sessionId, payload.eventName),
  );
}
