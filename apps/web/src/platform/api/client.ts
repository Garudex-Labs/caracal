/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the typed HTTP client the web app uses to reach the Caracal control plane through the session-guarded console backend.
*/
import { config } from "@/platform/config";

import type {
  Agent,
  AgentService,
  Application,
  ApplicationInput,
  ApplicationPatchInput,
  AuditDetail,
  AuditEvent,
  AuditQuery,
  AgentQuery,
  ConsoleStatus,
  ControlKey,
  ControlKeyCreateInput,
  ControlKeyCreateResult,
  ControlPermission,
  CoordinatorList,
  DecisionTrace,
  DelegationEdge,
  DelegationHop,
  DelegationImpactRow,
  DelegationQuery,
  DiagnosticsOptions,
  DiagnosticsReport,
  EffectiveAuthority,
  ActivationStatus,
  Invocation,
  Paged,
  Policy,
  PolicyDetail,
  PolicyInput,
  PolicyManifestEntry,
  PolicySet,
  PolicySetDetail,
  PolicySetVersion,
  PolicyTemplate,
  PolicyValidateResult,
  Provider,
  ProviderGrant,
  ProviderGrantAuthorizeInput,
  ProviderGrantAuthorizeResult,
  ProviderGrantListQuery,
  ProviderGrantRevokeInput,
  ProviderInput,
  ProviderPatchInput,
  Resource,
  ResourceInput,
  ResourcePatchInput,
  RowList,
  Session,
  SessionQuery,
  SimulateResult,
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

// Parses RFC 5988 Link headers to recover the keyset cursor for the next page.
function parseNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (match) {
      try {
        return new URL(match[1], config.consoleBaseUrl).searchParams.get("cursor");
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Issues a list request and returns both the parsed rows and the next cursor
// advertised by the control plane through the (proxied) Link header.
async function requestList<T>(path: string): Promise<{ rows: T[]; nextCursor: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${config.consoleBaseUrl}${path}`, {
      credentials: "include",
    });
  } catch {
    throw new ConsoleApiError(0, "network_error");
  }
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
  const rows = Array.isArray(parsed) ? (parsed as T[]) : [];
  return { rows, nextCursor: parseNextCursor(res.headers.get("link")) };
}

// Maximum number of pages auto-followed for "show everything" admin lists. At the
// server cap of 500 rows/page this surfaces up to 25k entities while bounding the
// worst-case request fan-out, so large zones never silently truncate.
const MAX_AUTO_PAGES = 50;
const ADMIN_PAGE_SIZE = 500;

// Follows keyset pagination to assemble a complete admin list. Returns the rows plus
// a flag indicating the safety cap was hit so the UI can prompt for server-side search.
async function fetchAllPages<T>(basePath: string): Promise<{ rows: T[]; truncated: boolean }> {
  const sep = basePath.includes("?") ? "&" : "?";
  let cursor: string | null = null;
  const rows: T[] = [];
  for (let page = 0; page < MAX_AUTO_PAGES; page++) {
    const path: string = `${basePath}${sep}limit=${ADMIN_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result: { rows: T[]; nextCursor: string | null } = await requestList<T>(path);
    rows.push(...result.rows);
    if (!result.nextCursor) return { rows, truncated: false };
    cursor = result.nextCursor;
  }
  return { rows, truncated: true };
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const CONTROL_INVOKE_TRAIT = "control:invoke";
export const CONTROL_SCOPE_PREFIX = "control:scope:";
export const CONTROL_MAX_TTL_PREFIX = "control:max-ttl:";
export const CONTROL_EXPIRES_PREFIX = "control:expires:";
export const CONTROL_AUDIENCE = "caracal-control";
export const CONTROL_MIN_TTL_SECONDS = 60;
export const CONTROL_MAX_TTL_SECONDS = 900;

// Authoritative catalog of Control API permissions, mirroring the remote surface the
// engine exposes (control:<noun>:<verb>). Used to compose least-privilege key scopes
// and to size the control resource that STS validates tokens against.
export const CONTROL_PERMISSIONS: ControlPermission[] = [
  {
    command: "agent",
    verb: "read",
    action: "read",
    scope: "control:agent:read",
    summary: "List and inspect agent sessions.",
  },
  {
    command: "agent",
    verb: "write",
    action: "write",
    scope: "control:agent:write",
    summary: "Suspend and resume sessions.",
  },
  {
    command: "agent",
    verb: "delete",
    action: "delete",
    scope: "control:agent:delete",
    summary: "Terminate agent sessions.",
  },
  {
    command: "app",
    verb: "read",
    action: "read",
    scope: "control:app:read",
    summary: "List and inspect applications.",
  },
  {
    command: "app",
    verb: "write",
    action: "write",
    scope: "control:app:write",
    summary: "Create and update applications.",
  },
  {
    command: "app",
    verb: "delete",
    action: "delete",
    scope: "control:app:delete",
    summary: "Delete applications.",
  },
  {
    command: "resource",
    verb: "read",
    action: "read",
    scope: "control:resource:read",
    summary: "List and inspect resources.",
  },
  {
    command: "resource",
    verb: "write",
    action: "write",
    scope: "control:resource:write",
    summary: "Create and update resources.",
  },
  {
    command: "resource",
    verb: "delete",
    action: "delete",
    scope: "control:resource:delete",
    summary: "Delete resources.",
  },
  {
    command: "delegation",
    verb: "read",
    action: "read",
    scope: "control:delegation:read",
    summary: "Inspect delegation edges.",
  },
  {
    command: "delegation",
    verb: "delete",
    action: "delete",
    scope: "control:delegation:delete",
    summary: "Revoke delegation edges.",
  },
];

const CONTROL_SCOPES = CONTROL_PERMISSIONS.map((permission) => permission.scope).sort();

function controlKeyFromApplication(app: Application): ControlKey {
  const traits = app.traits ?? [];
  const scopes = traits
    .filter((trait) => trait.startsWith(CONTROL_SCOPE_PREFIX))
    .map((trait) => trait.slice(CONTROL_SCOPE_PREFIX.length))
    .sort();
  const ttlTrait = traits.find((trait) => trait.startsWith(CONTROL_MAX_TTL_PREFIX));
  const expiresTrait = traits.find((trait) => trait.startsWith(CONTROL_EXPIRES_PREFIX));
  const ttl = ttlTrait
    ? Number.parseInt(ttlTrait.slice(CONTROL_MAX_TTL_PREFIX.length), 10)
    : undefined;
  return {
    id: app.id,
    name: app.name,
    scopes,
    maxTtlSeconds: ttl !== undefined && Number.isFinite(ttl) ? ttl : undefined,
    expiresAt: expiresTrait ? expiresTrait.slice(CONTROL_EXPIRES_PREFIX.length) : undefined,
    createdAt: app.created_at,
  };
}

export function isControlKeyApplication(app: Application): boolean {
  return (app.traits ?? []).includes(CONTROL_INVOKE_TRAIT);
}

// Generates a one-time client secret in the browser, matching the application secret
// format so control keys never round-trip a secret through a server session.
export function generateClientSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `cs_${base64url}`;
}

export const consoleApi = {
  status: () => request<ConsoleStatus>("/status"),
  diagnostics: (options: DiagnosticsOptions = {}) =>
    request<DiagnosticsReport>(
      `/diagnostics${queryString({
        zone: options.zoneId,
        strict: options.strict ? "true" : undefined,
        mode: options.preflight ? "preflight" : undefined,
      })}`,
    ),

  zones: {
    list: async () => (await fetchAllPages<Zone>("/v1/zones")).rows,
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
    list: async (zoneId: string) =>
      (await fetchAllPages<Application>(`/v1/zones/${encodeURIComponent(zoneId)}/applications`))
        .rows,
    create: (zoneId: string, input: ApplicationInput) =>
      request<Application>(`/v1/zones/${encodeURIComponent(zoneId)}/applications`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    patch: (zoneId: string, id: string, input: ApplicationPatchInput) =>
      request<{ id: string; name: string }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    delete: (zoneId: string, id: string) =>
      request<void>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },

  resources: {
    list: async (zoneId: string) =>
      (await fetchAllPages<Resource>(`/v1/zones/${encodeURIComponent(zoneId)}/resources`)).rows,
    get: (zoneId: string, id: string) =>
      request<Resource>(
        `/v1/zones/${encodeURIComponent(zoneId)}/resources/${encodeURIComponent(id)}`,
      ),
    create: (zoneId: string, input: ResourceInput) =>
      request<Resource>(`/v1/zones/${encodeURIComponent(zoneId)}/resources`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    patch: (zoneId: string, id: string, input: ResourcePatchInput) =>
      request<Resource>(
        `/v1/zones/${encodeURIComponent(zoneId)}/resources/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    delete: (zoneId: string, id: string) =>
      request<void>(`/v1/zones/${encodeURIComponent(zoneId)}/resources/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  providers: {
    list: async (zoneId: string) =>
      (await fetchAllPages<Provider>(`/v1/zones/${encodeURIComponent(zoneId)}/providers`)).rows,
    get: (zoneId: string, id: string) =>
      request<Provider>(
        `/v1/zones/${encodeURIComponent(zoneId)}/providers/${encodeURIComponent(id)}`,
      ),
    create: (zoneId: string, input: ProviderInput) =>
      request<Provider>(`/v1/zones/${encodeURIComponent(zoneId)}/providers`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    patch: (zoneId: string, id: string, input: ProviderPatchInput) =>
      request<Provider>(
        `/v1/zones/${encodeURIComponent(zoneId)}/providers/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    delete: (zoneId: string, id: string) =>
      request<void>(`/v1/zones/${encodeURIComponent(zoneId)}/providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  policies: {
    list: async (zoneId: string) =>
      (await fetchAllPages<Policy>(`/v1/zones/${encodeURIComponent(zoneId)}/policies`)).rows,
    get: (zoneId: string, id: string) =>
      request<PolicyDetail>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policies/${encodeURIComponent(id)}`,
      ),
    validate: (content: string) =>
      request<PolicyValidateResult>(`/v1/policies/validate`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    templates: () => request<PolicyTemplate[]>(`/v1/policy-templates`),
    create: (zoneId: string, input: PolicyInput) =>
      request<{ id: string }>(`/v1/zones/${encodeURIComponent(zoneId)}/policies`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    addVersion: (zoneId: string, id: string, content: string) =>
      request<{ version_id: string; version: number }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policies/${encodeURIComponent(id)}/versions`,
        { method: "POST", body: JSON.stringify({ content }) },
      ),
    delete: (zoneId: string, id: string) =>
      request<void>(`/v1/zones/${encodeURIComponent(zoneId)}/policies/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  policySets: {
    list: async (zoneId: string) =>
      (await fetchAllPages<PolicySet>(`/v1/zones/${encodeURIComponent(zoneId)}/policy-sets`)).rows,
    get: (zoneId: string, id: string) =>
      request<PolicySetDetail>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}`,
      ),
    create: (zoneId: string, name: string, description?: string) =>
      request<PolicySet>(`/v1/zones/${encodeURIComponent(zoneId)}/policy-sets`, {
        method: "POST",
        body: JSON.stringify({ name, description }),
      }),
    addVersion: (zoneId: string, id: string, manifest: PolicyManifestEntry[]) =>
      request<{ version_id: string; version: number }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/versions`,
        { method: "POST", body: JSON.stringify({ manifest }) },
      ),
    getVersion: (zoneId: string, id: string, versionId: string) =>
      request<PolicySetVersion>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
      ),
    activate: (zoneId: string, id: string, versionId: string, shadowVersionId?: string) =>
      request<{ activated: boolean; version_id: string; status_url: string }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/activate`,
        {
          method: "POST",
          body: JSON.stringify({
            version_id: versionId,
            ...(shadowVersionId ? { shadow_version_id: shadowVersionId } : {}),
          }),
        },
      ),
    activationStatus: (zoneId: string, id: string, versionId?: string) =>
      request<ActivationStatus>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/activation-status${versionId ? `?version_id=${encodeURIComponent(versionId)}` : ""}`,
      ),
    simulate: (zoneId: string, id: string, versionId: string, input?: Record<string, unknown>) =>
      request<SimulateResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/simulate`,
        {
          method: "POST",
          body: JSON.stringify({ version_id: versionId, ...(input ? { input } : {}) }),
        },
      ),
    delete: (zoneId: string, id: string) =>
      request<void>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },

  sessions: {
    list: async (zoneId: string, query: SessionQuery = {}): Promise<Paged<Session>> => {
      const res = await request<RowList<Session>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/sessions${queryString({
          limit: query.limit ?? 100,
          cursor: query.cursor,
          status: query.status,
          subject_id: query.subject_id,
        })}`,
      );
      return { rows: res.rows, nextCursor: res.next_cursor };
    },
  },

  agents: {
    list: async (zoneId: string, query: AgentQuery = {}): Promise<Paged<Agent>> => {
      const res = await request<CoordinatorList<Agent>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agents${queryString({
          status: query.status,
          lifecycle: query.lifecycle,
          application_id: query.application_id,
          label: query.label,
          limit: query.limit,
          cursor: query.cursor,
        })}`,
      );
      return { rows: res.items, nextCursor: res.next_cursor };
    },
    get: (zoneId: string, id: string) =>
      request<Agent>(`/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}`),
    children: async (zoneId: string, id: string) => {
      return request<Agent[]>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/children`,
      );
    },
    effectiveAuthority: (zoneId: string, id: string) =>
      request<EffectiveAuthority>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/effective-authority`,
      ),
    suspend: (zoneId: string, id: string) =>
      request<Agent>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/suspend`,
        { method: "PATCH", body: JSON.stringify({}) },
      ),
    resume: (zoneId: string, id: string) =>
      request<Agent>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/resume`,
        { method: "PATCH", body: JSON.stringify({}) },
      ),
    terminate: (zoneId: string, id: string) =>
      request<void>(`/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  execution: {
    services: async (zoneId: string) => {
      const res = await request<CoordinatorList<AgentService>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agent-services`,
      );
      return res.items;
    },
    invocations: async (
      zoneId: string,
      query: { session_id?: string; status?: string; service_id?: string; limit?: number } = {},
    ) => {
      const res = await request<CoordinatorList<Invocation>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/invocations${queryString({
          session_id: query.session_id,
          status: query.status,
          service_id: query.service_id,
          limit: query.limit,
        })}`,
      );
      return res.items;
    },
  },

  delegations: {
    active: async (zoneId: string, query: DelegationQuery = {}): Promise<Paged<DelegationEdge>> => {
      const res = await request<CoordinatorList<DelegationEdge>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/active${queryString({
          limit: query.limit,
          cursor: query.cursor,
        })}`,
      );
      return { rows: res.items, nextCursor: res.next_cursor };
    },
    inbound: (zoneId: string, sessionId: string) =>
      request<DelegationEdge[]>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/inbound/${encodeURIComponent(sessionId)}`,
      ),
    outbound: (zoneId: string, sessionId: string) =>
      request<DelegationEdge[]>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/outbound/${encodeURIComponent(sessionId)}`,
      ),
    traverse: (zoneId: string, id: string) =>
      request<DelegationHop[]>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/${encodeURIComponent(id)}/traverse`,
      ),
    impact: (zoneId: string, id: string) =>
      request<DelegationImpactRow[]>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/${encodeURIComponent(id)}/impact`,
      ),
    revoke: (zoneId: string, id: string) =>
      request<DelegationEdge>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/${encodeURIComponent(id)}/revoke`,
        { method: "PATCH", body: JSON.stringify({}) },
      ),
  },

  audit: {
    list: async (zoneId: string, query: AuditQuery = {}): Promise<Paged<AuditEvent>> => {
      const res = await request<RowList<AuditEvent>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/audit${queryString({
          limit: query.limit ?? 100,
          cursor: query.cursor,
          decision: query.decision,
          event_type: query.event_type,
          request_id: query.request_id,
          since: query.since,
          until: query.until,
        })}`,
      );
      return { rows: res.rows, nextCursor: res.next_cursor };
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

  providerGrants: {
    list: async (zoneId: string, query: ProviderGrantListQuery = {}) => {
      const res = await request<RowList<ProviderGrant>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/grants${queryString({
          provider_id: query.provider_id,
          resource_id: query.resource_id,
          user_id: query.user_id,
          status: query.status,
        })}`,
      );
      return res.rows;
    },
    authorize: (zoneId: string, input: ProviderGrantAuthorizeInput) =>
      request<ProviderGrantAuthorizeResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/provider-grants/oauth/authorize`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    revoke: (zoneId: string, input: ProviderGrantRevokeInput) =>
      request<ProviderGrant>(`/v1/zones/${encodeURIComponent(zoneId)}/provider-grants/revoke`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
  },

  control: {
    list: async (zoneId: string): Promise<ControlKey[]> => {
      const apps = (
        await fetchAllPages<Application>(`/v1/zones/${encodeURIComponent(zoneId)}/applications`)
      ).rows;
      return apps.filter(isControlKeyApplication).map(controlKeyFromApplication);
    },
    create: async (
      zoneId: string,
      input: ControlKeyCreateInput,
    ): Promise<ControlKeyCreateResult> => {
      await ensureControlResource(zoneId);
      const traits = [
        CONTROL_INVOKE_TRAIT,
        ...input.scopes.map((scope) => `${CONTROL_SCOPE_PREFIX}${scope}`),
        ...(input.maxTtlSeconds ? [`${CONTROL_MAX_TTL_PREFIX}${input.maxTtlSeconds}`] : []),
        ...(input.expiresAt ? [`${CONTROL_EXPIRES_PREFIX}${input.expiresAt}`] : []),
      ];
      const app = await request<Application>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications`,
        {
          method: "POST",
          body: JSON.stringify({ name: input.name, registration_method: "managed", traits }),
        },
      );
      if (!app.client_secret) throw new ConsoleApiError(500, "missing_client_secret");
      return {
        id: app.id,
        name: app.name,
        clientSecret: app.client_secret,
        scopes: [...input.scopes].sort(),
        maxTtlSeconds: input.maxTtlSeconds,
        expiresAt: input.expiresAt,
      };
    },
    rotate: async (zoneId: string, id: string): Promise<{ id: string; clientSecret: string }> => {
      const clientSecret = generateClientSecret();
      await request<{ id: string; name: string }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify({ client_secret: clientSecret }) },
      );
      return { id, clientSecret };
    },
    revoke: (zoneId: string, id: string) =>
      request<void>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },
};

// Ensures the zone-bound control resource exists with the full permission surface so STS
// can validate control tokens. Mirrors the engine's ensureControlResource for the browser.
async function ensureControlResource(zoneId: string): Promise<void> {
  const resources = (
    await fetchAllPages<Resource>(`/v1/zones/${encodeURIComponent(zoneId)}/resources`)
  ).rows;
  const current = resources.find((resource) => resource.identifier === CONTROL_AUDIENCE);
  if (!current) {
    await request<Resource>(`/v1/zones/${encodeURIComponent(zoneId)}/resources`, {
      method: "POST",
      body: JSON.stringify({
        name: "Control API",
        identifier: CONTROL_AUDIENCE,
        scopes: CONTROL_SCOPES,
      }),
    });
    return;
  }
  const currentScopes = [...current.scopes].sort();
  const matches =
    currentScopes.length === CONTROL_SCOPES.length &&
    CONTROL_SCOPES.every((scope, index) => scope === currentScopes[index]);
  if (!matches) {
    await request<Resource>(
      `/v1/zones/${encodeURIComponent(zoneId)}/resources/${encodeURIComponent(current.id)}`,
      { method: "PATCH", body: JSON.stringify({ scopes: CONTROL_SCOPES }) },
    );
  }
}
