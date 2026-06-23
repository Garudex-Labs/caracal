/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the typed HTTP client the web app uses to reach the Caracal control plane through the session-guarded console backend.
*/
import { config } from "@/platform/config";

import type {
  Application,
  ApplicationInput,
  AuditDetail,
  AuditEvent,
  ConsoleStatus,
  DecisionTrace,
  Policy,
  PolicyDetail,
  PolicySet,
  Provider,
  Resource,
  RowList,
  Session,
  Zone,
  ZoneInput,
  ZonePatchInput,
  ZoneDcrStatus,
} from "./types";

export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code);
    this.name = "ConsoleApiError";
  }

  get notConfigured(): boolean {
    return this.code === "control_plane_not_configured";
  }

  get unreachable(): boolean {
    return this.code === "control_plane_unreachable";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.consoleBaseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers:
        init?.body !== undefined
          ? { "Content-Type": "application/json", ...init?.headers }
          : init?.headers,
    });
  } catch {
    throw new ConsoleApiError(0, "network_error");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const code =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText || "request_failed";
    throw new ConsoleApiError(res.status, code, parsed);
  }

  return parsed as T;
}

export const consoleApi = {
  status: () => request<ConsoleStatus>("/status"),

  zones: {
    list: () => request<Zone[]>("/v1/zones"),
    get: (id: string) => request<Zone>(`/v1/zones/${encodeURIComponent(id)}`),
    dcrStatus: (id: string) =>
      request<ZoneDcrStatus>(`/v1/zones/${encodeURIComponent(id)}/dcr-status`),
    create: (input: ZoneInput) =>
      request<Zone>("/v1/zones", { method: "POST", body: JSON.stringify(input) }),
    patch: (id: string, input: ZonePatchInput) =>
      request<Zone>(`/v1/zones/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    delete: (id: string) =>
      request<void>(`/v1/zones/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  applications: {
    list: (zoneId: string) =>
      request<Application[]>(`/v1/zones/${encodeURIComponent(zoneId)}/applications`),
    create: (zoneId: string, input: ApplicationInput) =>
      request<Application>(`/v1/zones/${encodeURIComponent(zoneId)}/applications`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    delete: (zoneId: string, id: string) =>
      request<void>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },

  resources: {
    list: (zoneId: string) =>
      request<Resource[]>(`/v1/zones/${encodeURIComponent(zoneId)}/resources`),
  },

  providers: {
    list: (zoneId: string) =>
      request<Provider[]>(`/v1/zones/${encodeURIComponent(zoneId)}/providers`),
    get: (zoneId: string, id: string) =>
      request<Provider>(
        `/v1/zones/${encodeURIComponent(zoneId)}/providers/${encodeURIComponent(id)}`,
      ),
  },

  policies: {
    list: (zoneId: string) => request<Policy[]>(`/v1/zones/${encodeURIComponent(zoneId)}/policies`),
    get: (zoneId: string, id: string) =>
      request<PolicyDetail>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policies/${encodeURIComponent(id)}`,
      ),
  },

  policySets: {
    list: (zoneId: string) =>
      request<PolicySet[]>(`/v1/zones/${encodeURIComponent(zoneId)}/policy-sets`),
    get: (zoneId: string, id: string) =>
      request<PolicySet>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}`,
      ),
  },

  sessions: {
    list: async (zoneId: string, limit = 100) => {
      const res = await request<RowList<Session>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/sessions?limit=${limit}`,
      );
      return res.rows;
    },
  },

  audit: {
    list: async (zoneId: string, limit = 100) => {
      const res = await request<RowList<AuditEvent>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/audit?limit=${limit}`,
      );
      return res.rows;
    },
    byRequest: (zoneId: string, requestId: string) =>
      request<AuditDetail[]>(
        `/v1/zones/${encodeURIComponent(zoneId)}/audit/by-request/${encodeURIComponent(requestId)}`,
      ),
    explain: (zoneId: string, requestId: string) =>
      request<DecisionTrace>(
        `/v1/zones/${encodeURIComponent(zoneId)}/audit/by-request/${encodeURIComponent(requestId)}/explain`,
      ),
  },
};
