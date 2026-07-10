/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file is the typed HTTP client the web app uses to reach the Caracal control plane through the session-guarded console backend.
*/
import { config } from "@/platform/config";
import { isSystemZoneViewTab } from "@/platform/state/systemZoneView";

import { CONTROL_AUDIENCE, CONTROL_SCOPES } from "./controlCatalog";

import type {
  Session,
  SessionService,
  AdminAuditEvent,
  AdminAuditQuery,
  Application,
  ApplicationInput,
  ApplicationPatchInput,
  AuditDetail,
  AuditRetention,
  AuditEvent,
  AuditQuery,
  SessionQuery,
  ConsoleStatus,
  ControlKey,
  ControlKeyCreateInput,
  ControlKeyCreateResult,
  ControlEndpointStatus,
  ControlTokenInput,
  ControlTokenResult,
  CoordinatorList,
  DecisionTrace,
  DelegationEdge,
  DelegationHop,
  DelegationImpact,
  DelegationQuery,
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
  PolicyValidateResult,
  Provider,
  ProviderConnection,
  ProviderConnectionAuthorizeInput,
  ProviderConnectionAuthorizeResult,
  ProviderConnectionListQuery,
  ProviderConnectionRevokeInput,
  ProviderConnectionRevokeResult,
  ProviderDiscovery,
  ProviderInput,
  ProviderPatchInput,
  ProviderTestResult,
  Resource,
  ResourceInput,
  ResourcePatchInput,
  ListEnvelope,
  AuthorityRecord,
  AuthorityRecordQuery,
  SubjectOverview,
  SubjectRevokeResult,
  SubjectQuery,
  SubjectSummary,
  SimulateResult,
  StepUpChallenge,
  StepUpDecision,
  ApprovalQuery,
  ApprovalCounts,
  NotificationSink,
  NotificationSinkCreated,
  NotificationSinkInput,
  SinkDelivery,
  OperatorCapability,
  OperatorConversation,
  OperatorConversationMode,
  OperatorContext,
  OperatorAiStatus,
  OperatorAiCheckResult,
  OperatorAiProvider,
  OperatorAiProviderList,
  OperatorAiProviderInput,
  OperatorAiProviderPatch,
  OperatorAiAuth,
  OperatorExecutionResult,
  OperatorMessageResult,
  OperatorMessageRun,
  OperatorProgressStage,
  OperatorNarrativeInput,
  OperatorPlanDecisionInput,
  OperatorPlanInput,
  OperatorPlanSecretsResult,
  OperatorPlanSecretsStatus,
  OperatorPlanValidation,
  OperatorTurn,
  Zone,
  ZoneInput,
  ZoneOverview,
  ZonePatchInput,
  ZoneDcrStatus,
  Workload,
  WorkloadUpdateInput,
} from "./types";

interface WireAuthorityRecord {
  id: string;
  zone_id: string;
  session_type: string;
  subject_id: string;
  parent_id: string | null;
  status: string;
  expires_at: string;
  authenticated_at: string;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface WireSession {
  agent_session_id: string;
  zone_id: string;
  application_id: string;
  parent_id: string | null;
  subject_session_id: string | null;
  lifecycle: string;
  labels: string[];
  status: Session["status"];
  depth: number;
  ttl_seconds: number | null;
  metadata: Record<string, unknown> | null;
  spawned_at: string;
  terminated_at: string | null;
  termination_reason: string | null;
  last_heartbeat_at: string | null;
  heartbeat_deadline_at: string | null;
}

interface WireEffectiveAuthority {
  agent_session_id: string;
  inbound_edges: string[];
  effective_scopes: string[];
  effective_resources: string[];
  effective_resource_ids?: string[];
  effective_resource_constrained?: boolean;
  effective_max_hops: number | null;
  effective_ttl_seconds: number | null;
  earliest_expires_at: string | null;
}

interface WireSubjectOverview extends Omit<SubjectOverview, "governed"> {
  governed: {
    active: number;
    total: number;
    recent: {
      id: string;
      application_id: string;
      application_name: string | null;
      lifecycle: string;
      status: string;
      spawned_at: string;
    }[];
  };
}

interface WireSubjectRevokeResult extends Omit<SubjectRevokeResult, "governed_sessions"> {
  agents: number;
}

function authorityRecord(record: WireAuthorityRecord): AuthorityRecord {
  return {
    id: record.id,
    zoneId: record.zone_id,
    type: record.session_type,
    subjectId: record.subject_id,
    parentId: record.parent_id,
    status: record.status,
    expiresAt: record.expires_at,
    authenticatedAt: record.authenticated_at,
    createdAt: record.created_at,
    revokedAt: record.revoked_at,
    revokedReason: record.revoked_reason,
  };
}

function session(record: WireSession): Session {
  return {
    id: record.agent_session_id,
    zoneId: record.zone_id,
    applicationId: record.application_id,
    parentId: record.parent_id,
    subjectAuthorityRecordId: record.subject_session_id,
    lifecycle: record.lifecycle,
    labels: record.labels,
    status: record.status,
    depth: record.depth,
    ttlSeconds: record.ttl_seconds,
    metadata: record.metadata,
    startedAt: record.spawned_at,
    terminatedAt: record.terminated_at,
    terminationReason: record.termination_reason,
    lastHeartbeatAt: record.last_heartbeat_at,
    heartbeatDeadlineAt: record.heartbeat_deadline_at,
  };
}

function effectiveAuthority(record: WireEffectiveAuthority): EffectiveAuthority {
  return {
    sessionId: record.agent_session_id,
    inboundDelegations: record.inbound_edges,
    scopes: record.effective_scopes,
    resources: record.effective_resources,
    resourceIds: record.effective_resource_ids,
    resourceConstrained: record.effective_resource_constrained,
    maxHops: record.effective_max_hops,
    ttlSeconds: record.effective_ttl_seconds,
    expiresAt: record.earliest_expires_at,
  };
}

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

  get timedOut(): boolean {
    return this.code === "timeout";
  }
}

// Browser-side ceiling on a single request. The BFF caps upstream calls at 30s; this fails a
// little later so a wedged or rotating BFF surfaces as a clean timeout error instead of an
// indefinite spinner. Composed with any caller signal (React Query cancellation), so navigating
// away or unmounting also aborts the in-flight fetch and the upstream work behind it.
const REQUEST_TIMEOUT_MS = 35_000;

function requestSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function abortError(caller: AbortSignal | undefined): ConsoleApiError {
  // A caller-initiated cancellation (navigation/unmount) is not a failure to surface; only a
  // timeout is a real, reportable error.
  if (caller?.aborted) throw new DOMException("aborted", "AbortError");
  return new ConsoleApiError(0, "timeout");
}

// A deployment-level denial means this identity may not use the Console at all: the server has
// already revoked the session before responding, so no in-app state is worth preserving. Every
// console request funnels through this module, making it the one interception point that also
// covers background polling and mutations, whose errors never reach a router boundary. The
// hard navigation lands on the uniform access-denied page; the guard keeps concurrent in-flight
// denials from re-navigating.
function interceptDeploymentDenial(status: number, code: string): void {
  if (status === 403 && code === "access_denied" && window.location.pathname !== "/access-denied") {
    window.location.assign("/access-denied");
  }
}

async function request<T>(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  const caller = init?.signal;
  // The read-only system-zone viewer tab may never mutate. Every mutating call funnels through
  // here (list reads use a separate GET-only path), so refusing mutating methods from the viewer
  // tab is a single fail-closed gate that holds even if a control was rendered without its
  // read-only state and even against a control plane that has not yet shipped the server guard.
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && isSystemZoneViewTab()) {
    throw new ConsoleApiError(403, "system_zone_read_only");
  }
  let res: Response;
  try {
    res = await fetch(`${config.consoleBaseUrl}${path}`, {
      ...init,
      signal: requestSignal(caller),
      credentials: "include",
      headers:
        init?.body !== undefined
          ? { "Content-Type": "application/json", ...init?.headers }
          : init?.headers,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw abortError(caller);
    throw new ConsoleApiError(0, "network_error");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown;
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
    interceptDeploymentDenial(res.status, code);
    throw new ConsoleApiError(res.status, code, parsed);
  }

  return parsed as T;
}

// Sends an Operator message over Server-Sent Events, forwarding each deliberation stage to
// onStage as it arrives and resolving with the same authoritative result body the JSON path
// returns. Governance and validation errors raised before the stream opens come back as a normal
// JSON error response; stops raised mid-deliberation arrive as a terminal error frame. Either way
// they surface as a ConsoleApiError, so the caller handles one failure shape.
async function streamOperatorMessage(
  zoneId: string,
  conversationId: string,
  message: string,
  provider: string | undefined,
  onStage: (stage: OperatorProgressStage) => void,
  onToken?: (text: string) => void,
  onReasoning?: (text: string) => void,
  options: { signal?: AbortSignal; clientMessageId?: string; correlationId?: string } = {},
): Promise<OperatorMessageResult> {
  const path = `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
    conversationId,
  )}/message`;
  let res: Response;
  try {
    res = await fetch(`${config.consoleBaseUrl}${path}`, {
      method: "POST",
      credentials: "include",
      signal: options.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        message,
        ...(provider ? { provider } : {}),
        ...(options.clientMessageId ? { client_message_id: options.clientMessageId } : {}),
        ...(options.correlationId ? { correlation_id: options.correlationId } : {}),
      }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError")
      throw new DOMException("aborted", "AbortError");
    throw new ConsoleApiError(0, "network_error");
  }

  // A stop raised before the stream opened (auth, archived conversation, mode) returns a normal
  // JSON error rather than an event stream. Surface it exactly as the request() path would.
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
    const text = await res.text();
    let parsed: unknown;
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
      interceptDeploymentDenial(res.status, code);
      throw new ConsoleApiError(res.status, code, parsed);
    }
    return parsed as OperatorMessageResult;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: OperatorMessageResult | null = null;
  let failure: ConsoleApiError | null = null;

  // Consumes whole SSE frames from the buffer. A frame is terminated by a blank line and names one
  // of the route's events: stage forwards live progress, token forwards a text delta of the answer
  // as it is produced, result is the authoritative body, and error carries a governance or gateway
  // stop with its status.
  const drain = () => {
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === "stage") {
        const stage = (payload as { stage?: OperatorProgressStage }).stage;
        if (stage) onStage(stage);
      } else if (event === "reasoning") {
        const text = (payload as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) onReasoning?.(text);
      } else if (event === "token") {
        const text = (payload as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) onToken?.(text);
      } else if (event === "result") {
        result = payload as OperatorMessageResult;
      } else if (event === "error") {
        const body = payload as { error?: unknown; status?: number };
        failure = new ConsoleApiError(
          typeof body.status === "number" ? body.status : 500,
          body.error ? String(body.error) : "request_failed",
          body,
        );
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ConsoleApiError(0, "network_error");
  }
  // Flush a trailing frame the server closed without a final blank line.
  buffer += "\n\n";
  drain();

  if (failure) throw failure;
  if (result) return result;
  throw new ConsoleApiError(0, "request_failed");
}

// Issues a list request against the uniform list envelope and returns the parsed
// rows plus the opaque keyset cursor for the next page.
async function requestList<T>(
  path: string,
  signal?: AbortSignal,
): Promise<{ rows: T[]; nextCursor: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${config.consoleBaseUrl}${path}`, {
      credentials: "include",
      signal: requestSignal(signal),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw abortError(signal);
    throw new ConsoleApiError(0, "network_error");
  }
  const text = await res.text();
  let parsed: unknown;
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
  const envelope = (parsed ?? {}) as { items?: T[]; next_cursor?: string | null };
  const rows = Array.isArray(envelope.items) ? envelope.items : [];
  return { rows, nextCursor: envelope.next_cursor ?? null };
}

// Maximum number of pages auto-followed for "show everything" admin lists. At the
// server cap of 500 rows/page this surfaces up to 25k entities while bounding the
// worst-case request fan-out, so large zones never silently truncate.
const MAX_AUTO_PAGES = 50;
const ADMIN_PAGE_SIZE = 500;

// Follows keyset pagination to assemble a complete admin list. Returns the rows plus
// a flag indicating the safety cap was hit so the UI can prompt for server-side search.
// A caller signal aborts the whole pagination loop, so navigating away mid-walk stops the
// remaining requests instead of fanning out dozens of now-unwanted calls to the control plane.
async function fetchAllPages<T>(
  basePath: string,
  signal?: AbortSignal,
): Promise<{ rows: T[]; truncated: boolean }> {
  const sep = basePath.includes("?") ? "&" : "?";
  let cursor: string | null = null;
  const rows: T[] = [];
  for (let page = 0; page < MAX_AUTO_PAGES; page++) {
    const path: string = `${basePath}${sep}limit=${ADMIN_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result: { rows: T[]; nextCursor: string | null } = await requestList<T>(path, signal);
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

// Maps the camelCase auth placement to the API's snake_case body. A header carries a name and an
// optional scheme; a query carries a parameter name. The server defaults an omitted placement to
// an Authorization Bearer header, so this only sends what the operator set.
function serializeAuth(auth: OperatorAiAuth): Record<string, unknown> {
  if (auth.location === "query") {
    return { location: "query", query_param_name: auth.queryParamName ?? "api_key" };
  }
  return {
    location: "header",
    header_name: auth.headerName ?? "Authorization",
    ...(auth.authScheme ? { auth_scheme: auth.authScheme } : {}),
  };
}

export const CONTROL_INVOKE_TRAIT = "control:invoke";
export const CONTROL_SCOPE_PREFIX = "control:scope:";
export const CONTROL_MAX_TTL_PREFIX = "control:max-ttl:";
export const CONTROL_EXPIRES_PREFIX = "control:expires:";

export {
  CONTROL_MIN_TTL_SECONDS,
  CONTROL_MAX_TTL_SECONDS,
  CONTROL_PERMISSIONS,
  CONTROL_NOUN_DESCRIPTIONS,
} from "./controlCatalog";
export { CONTROL_AUDIENCE, CONTROL_SCOPES };

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
    createdBy: app.created_by,
    createdViaOperator: app.created_via_operator,
    updatedBy: app.updated_by,
    updatedViaOperator: app.updated_via_operator,
  };
}

export function isControlKeyApplication(app: Application): boolean {
  return (app.traits ?? []).includes(CONTROL_INVOKE_TRAIT);
}

export const consoleApi = {
  status: () => request<ConsoleStatus>("/status"),
  diagnostics: () => request<DiagnosticsReport>("/diagnostics"),

  profiles: {
    resolve: (ids: string[]) =>
      request<{ profiles: { id: string; name: string }[] }>(
        `/profiles?ids=${encodeURIComponent(ids.join(","))}`,
      ),
  },

  zones: {
    list: async (signal?: AbortSignal) => (await fetchAllPages<Zone>("/v1/zones", signal)).rows,
    get: (id: string, signal?: AbortSignal) =>
      request<Zone>(`/v1/zones/${encodeURIComponent(id)}`, { signal }),
    overview: (id: string, signal?: AbortSignal) =>
      request<ZoneOverview>(`/v1/zones/${encodeURIComponent(id)}/overview`, { signal }),
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
    list: async (zoneId: string, signal?: AbortSignal, status: "active" | "archived" = "active") =>
      (
        await fetchAllPages<Application>(
          `/v1/zones/${encodeURIComponent(zoneId)}/applications${status === "archived" ? "?status=archived" : ""}`,
          signal,
        )
      ).rows,
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
    rotateSecret: (zoneId: string, id: string) =>
      request<Application>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}/rotate-secret`,
        { method: "POST", body: "{}" },
      ),
    revealSecret: (zoneId: string, id: string) =>
      request<{ client_secret: string }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}/client-secret`,
      ),
    delete: (zoneId: string, id: string) =>
      request<void>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },

  workloads: {
    list: async (zoneId: string, signal?: AbortSignal) =>
      (await fetchAllPages<Workload>(`/v1/zones/${encodeURIComponent(zoneId)}/workloads`, signal))
        .rows,
    create: (zoneId: string, input: { name: string }) =>
      request<Workload>(`/v1/zones/${encodeURIComponent(zoneId)}/workloads`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    update: (zoneId: string, id: string, input: WorkloadUpdateInput) =>
      request<Workload>(
        `/v1/zones/${encodeURIComponent(zoneId)}/workloads/${encodeURIComponent(id)}`,
        { method: "PUT", body: JSON.stringify(input) },
      ),
    rotateSecret: (zoneId: string, id: string) =>
      request<Workload>(
        `/v1/zones/${encodeURIComponent(zoneId)}/workloads/${encodeURIComponent(id)}/rotate-secret`,
        { method: "POST", body: "{}" },
      ),
    revealSecret: (zoneId: string, id: string) =>
      request<{ secret: string }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/workloads/${encodeURIComponent(id)}/secret`,
      ),
    delete: (zoneId: string, id: string) =>
      request<void>(`/v1/zones/${encodeURIComponent(zoneId)}/workloads/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  resources: {
    list: async (zoneId: string, signal?: AbortSignal, status: "active" | "archived" = "active") =>
      (
        await fetchAllPages<Resource>(
          `/v1/zones/${encodeURIComponent(zoneId)}/resources${status === "archived" ? "?status=archived" : ""}`,
          signal,
        )
      ).rows,
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
    list: async (zoneId: string, signal?: AbortSignal, status: "active" | "archived" = "active") =>
      (
        await fetchAllPages<Provider>(
          `/v1/zones/${encodeURIComponent(zoneId)}/providers${status === "archived" ? "?status=archived" : ""}`,
          signal,
        )
      ).rows,
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
    test: (zoneId: string, id: string) =>
      request<ProviderTestResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/providers/${encodeURIComponent(id)}/test`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    discover: (zoneId: string, issuer: string) =>
      request<ProviderDiscovery>(`/v1/zones/${encodeURIComponent(zoneId)}/providers/discovery`, {
        method: "POST",
        body: JSON.stringify({ issuer }),
      }),
  },

  policies: {
    list: async (zoneId: string, signal?: AbortSignal) =>
      (await fetchAllPages<Policy>(`/v1/zones/${encodeURIComponent(zoneId)}/policies`, signal))
        .rows,
    get: (zoneId: string, id: string) =>
      request<PolicyDetail>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policies/${encodeURIComponent(id)}`,
      ),
    validate: (content: string) =>
      request<PolicyValidateResult>(`/v1/policies/validate`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    create: (zoneId: string, input: PolicyInput) =>
      request<{ id: string; version_id: string }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policies`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
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
    list: async (zoneId: string, signal?: AbortSignal) =>
      (
        await fetchAllPages<PolicySet>(
          `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets`,
          signal,
        )
      ).rows,
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
    listVersions: async (zoneId: string, id: string, signal?: AbortSignal) =>
      (
        await fetchAllPages<PolicySetVersion>(
          `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/versions`,
          signal,
        )
      ).rows,
    getVersion: (zoneId: string, id: string, versionId: string) =>
      request<PolicySetVersion>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
      ),
    activate: (zoneId: string, id: string, versionId: string) =>
      request<{ activated: boolean; version_id: string; status_url: string }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/policy-sets/${encodeURIComponent(id)}/activate`,
        {
          method: "POST",
          body: JSON.stringify({ version_id: versionId }),
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

  authorityRecords: {
    list: async (
      zoneId: string,
      query: AuthorityRecordQuery = {},
    ): Promise<Paged<AuthorityRecord>> => {
      const res = await request<ListEnvelope<WireAuthorityRecord>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/sessions${queryString({
          limit: query.limit ?? 100,
          cursor: query.cursor,
          id: query.id,
          status: query.status,
          subject_id: query.subject_id,
        })}`,
      );
      return { rows: res.items.map(authorityRecord), nextCursor: res.next_cursor };
    },
  },

  // Subject-level reads: one aggregate row per identity work is done for, plus the
  // investigation overview bundling governed sessions, approvals, and connections.
  subjects: {
    list: async (zoneId: string, query: SubjectQuery = {}): Promise<Paged<SubjectSummary>> => {
      const res = await request<ListEnvelope<SubjectSummary>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/subjects${queryString({
          limit: query.limit ?? 100,
          cursor: query.cursor,
          kind: query.kind,
          search: query.search,
        })}`,
      );
      return { rows: res.items, nextCursor: res.next_cursor };
    },
    overview: async (zoneId: string, subjectId: string): Promise<SubjectOverview> => {
      const result = await request<WireSubjectOverview>(
        `/v1/zones/${encodeURIComponent(zoneId)}/subjects/overview${queryString({ subject_id: subjectId })}`,
      );
      return {
        ...result,
        governed: {
          ...result.governed,
          recent: result.governed.recent.map((record) => ({
            id: record.id,
            application_id: record.application_id,
            application_name: record.application_name,
            lifecycle: record.lifecycle,
            status: record.status,
            startedAt: record.spawned_at,
          })),
        },
      };
    },
    // The kill switch: one call cuts every authority path the subject holds. The
    // subject id travels in the body, never the path, so any issuer-assigned
    // format stays routable.
    revoke: async (
      zoneId: string,
      subjectId: string,
      reason?: string,
    ): Promise<SubjectRevokeResult> => {
      const result = await request<WireSubjectRevokeResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/subjects/revoke`,
        {
          method: "POST",
          body: JSON.stringify({ subject_id: subjectId, ...(reason ? { reason } : {}) }),
        },
      );
      return {
        subject_id: result.subject_id,
        sessions: result.sessions,
        governed_sessions: result.agents,
        delegations: result.delegations,
        connections: result.connections,
      };
    },
  },

  // Human-approval holds raised by policy. Reads return the full approval fact with a derived
  // lifecycle state; approve/reject decide a live operator-plane hold, with an optional rationale
  // recorded on the hold and in the zone audit stream.
  approvals: {
    list: (zoneId: string, query: ApprovalQuery = {}): Promise<Paged<StepUpChallenge>> =>
      requestList<StepUpChallenge>(
        `/v1/zones/${encodeURIComponent(zoneId)}/step-up-challenges${queryString({
          limit: 100,
          cursor: query.cursor,
          state: query.state,
        })}`,
      ).then((res) => ({ rows: res.rows, nextCursor: res.nextCursor })),
    counts: (zoneId: string, signal?: AbortSignal): Promise<ApprovalCounts> =>
      request<ApprovalCounts>(`/v1/zones/${encodeURIComponent(zoneId)}/step-up-challenges/counts`, {
        signal,
      }),
    approve: (zoneId: string, id: string, reason?: string) =>
      request<StepUpDecision>(
        `/v1/zones/${encodeURIComponent(zoneId)}/step-up-challenges/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: JSON.stringify(reason ? { reason } : {}) },
      ),
    reject: (zoneId: string, id: string, reason?: string) =>
      request<StepUpDecision>(
        `/v1/zones/${encodeURIComponent(zoneId)}/step-up-challenges/${encodeURIComponent(id)}/reject`,
        { method: "POST", body: JSON.stringify(reason ? { reason } : {}) },
      ),
  },

  // Webhook sinks that push zone approval activity to external systems. The signing secret
  // is returned exactly once, on create and on rotate; reads never include it.
  notificationSinks: {
    list: (zoneId: string): Promise<Paged<NotificationSink>> =>
      requestList<NotificationSink>(
        `/v1/zones/${encodeURIComponent(zoneId)}/notification-sinks${queryString({ limit: 100 })}`,
      ),
    create: (zoneId: string, input: NotificationSinkInput) =>
      request<NotificationSinkCreated>(
        `/v1/zones/${encodeURIComponent(zoneId)}/notification-sinks`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    update: (zoneId: string, id: string, patch: Partial<NotificationSinkInput>) =>
      request<NotificationSink>(
        `/v1/zones/${encodeURIComponent(zoneId)}/notification-sinks/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    rotateSecret: (zoneId: string, id: string) =>
      request<NotificationSinkCreated>(
        `/v1/zones/${encodeURIComponent(zoneId)}/notification-sinks/${encodeURIComponent(id)}/rotate-secret`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    remove: (zoneId: string, id: string) =>
      request<void>(
        `/v1/zones/${encodeURIComponent(zoneId)}/notification-sinks/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    deliveries: (zoneId: string, id: string): Promise<Paged<SinkDelivery>> =>
      requestList<SinkDelivery>(
        `/v1/zones/${encodeURIComponent(zoneId)}/notification-sinks/${encodeURIComponent(id)}/deliveries${queryString({ limit: 50 })}`,
      ),
  },

  operator: {
    status: async (signal?: AbortSignal) => {
      const res = await request<{ enabled: boolean }>("/v1/operator/status", { signal });
      return res.enabled;
    },
    // The reserved system zone the Operator governs, exposed only as its id so the Console can
    // open it in a read-only transparency view. Resolved by slug when it exists, so the viewer is
    // reachable even before governed execution is configured; falls back to the governed identity's
    // zone for older deployments. Null when no system zone exists. The credential is never exposed.
    systemZoneId: async (signal?: AbortSignal) => {
      const res = await request<{
        system_zone_id?: string | null;
        governed_execution?: { configured?: boolean; zone_id?: string };
      }>("/v1/operator/status", { signal });
      return res.system_zone_id ?? res.governed_execution?.zone_id ?? null;
    },
    // Whether Caracal-governed autopilot is available in this deployment. Read from the same
    // status probe; the per-conversation engage toggle is only meaningful when this is true.
    autopilotAvailable: async (signal?: AbortSignal) => {
      const res = await request<{ autopilot?: { available: boolean } }>("/v1/operator/status", {
        signal,
      });
      return res.autopilot?.available ?? false;
    },
    aiStatus: (signal?: AbortSignal) =>
      request<OperatorAiStatus>("/v1/operator/ai/status", { signal }),
    // Sends one minimal completion through the failover chain so an operator can confirm a
    // configured provider is reachable. The endpoint makes the only real provider call on an
    // explicit action, so it doubles as the page's connectivity test.
    aiCheck: (signal?: AbortSignal) =>
      request<OperatorAiCheckResult>("/v1/operator/ai/check", { method: "POST", signal }),
    // Governed model-provider management. Each write seals the key into Caracal and reconciles
    // the Operator's grants server-side; the key is sent once on create or rotate and is never
    // read back.
    aiProviders: {
      list: (signal?: AbortSignal) =>
        request<OperatorAiProviderList>("/v1/operator/ai/providers", { signal }),
      create: (input: OperatorAiProviderInput) =>
        request<OperatorAiProvider>("/v1/operator/ai/providers", {
          method: "POST",
          body: JSON.stringify({
            slug: input.slug,
            label: input.label,
            base_url: input.baseUrl,
            models: input.models,
            context_window: input.contextWindow,
            api_key: input.apiKey,
            enabled: input.enabled,
            ...(input.auth ? { auth: serializeAuth(input.auth) } : {}),
          }),
        }),
      update: (slug: string, patch: OperatorAiProviderPatch) =>
        request<OperatorAiProvider>(`/v1/operator/ai/providers/${encodeURIComponent(slug)}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.baseUrl !== undefined ? { base_url: patch.baseUrl } : {}),
            ...(patch.models !== undefined ? { models: patch.models } : {}),
            ...(patch.contextWindow !== undefined ? { context_window: patch.contextWindow } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.auth ? { auth: serializeAuth(patch.auth) } : {}),
          }),
        }),
      rotateKey: (slug: string, apiKey: string) =>
        request<{ ok: boolean }>(`/v1/operator/ai/providers/${encodeURIComponent(slug)}/key`, {
          method: "POST",
          body: JSON.stringify({ api_key: apiKey }),
        }),
      remove: (slug: string) =>
        request<void>(`/v1/operator/ai/providers/${encodeURIComponent(slug)}`, {
          method: "DELETE",
        }),
    },
    capabilities: async (signal?: AbortSignal) => {
      const res = await request<{ capabilities: OperatorCapability[] }>(
        "/v1/operator/capabilities",
        { signal },
      );
      return res.capabilities;
    },
    conversations: {
      list: async (
        zoneId: string,
        options: {
          q?: string;
          status?: "active" | "archived" | "all";
          signal?: AbortSignal;
        } = {},
      ): Promise<OperatorConversation[]> =>
        (
          await fetchAllPages<OperatorConversation>(
            `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations${queryString({
              q: options.q,
              status: options.status,
            })}`,
            options.signal,
          )
        ).rows,
      get: (zoneId: string, id: string, signal?: AbortSignal) =>
        request<OperatorConversation>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(id)}`,
          { signal },
        ),
      create: (
        zoneId: string,
        title: string,
        options: { mode?: OperatorConversationMode; autopilot?: boolean } = {},
      ) =>
        request<OperatorConversation>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations`,
          {
            method: "POST",
            body: JSON.stringify({
              title,
              ...(options.mode ? { mode: options.mode } : {}),
              ...(options.autopilot ? { autopilot: options.autopilot } : {}),
            }),
          },
        ),
      rename: (zoneId: string, id: string, title: string) =>
        request<OperatorConversation>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify({ title }) },
        ),
      setMode: (zoneId: string, id: string, mode: OperatorConversationMode) =>
        request<OperatorConversation>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify({ mode }) },
        ),
      setAutopilot: (zoneId: string, id: string, autopilot: boolean) =>
        request<OperatorConversation>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify({ autopilot }) },
        ),
      restore: (zoneId: string, id: string) =>
        request<OperatorConversation>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify({ status: "active" }) },
        ),
      delete: (zoneId: string, id: string) =>
        request<void>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        ),
      archive: (zoneId: string, id: string) =>
        request<OperatorConversation>(
          `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify({ status: "archived" }) },
        ),
    },
    appendTurn: (zoneId: string, conversationId: string, turn: OperatorNarrativeInput) =>
      request<OperatorTurn>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/turns`,
        { method: "POST", body: JSON.stringify(turn) },
      ),
    context: (zoneId: string, conversationId: string, signal?: AbortSignal) =>
      request<OperatorContext>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/context`,
        { signal },
      ),
    listTurns: async (
      zoneId: string,
      conversationId: string,
      signal?: AbortSignal,
    ): Promise<OperatorTurn[]> => {
      // The turns endpoint pages by sequence: next_cursor carries the last seq of
      // a full page and null on the final page. The cap bounds a single
      // conversation's fan-out.
      const pageSize = 200;
      const maxPages = 50;
      const base = `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
        conversationId,
      )}/turns`;
      const turns: OperatorTurn[] = [];
      let afterSeq = "0";
      for (let page = 0; page < maxPages; page++) {
        const res = await request<ListEnvelope<OperatorTurn>>(
          `${base}?after_seq=${encodeURIComponent(afterSeq)}&limit=${pageSize}`,
          { signal },
        );
        turns.push(...res.items);
        if (!res.next_cursor) break;
        afterSeq = res.next_cursor;
      }
      return turns;
    },
    validatePlan: (zoneId: string, conversationId: string, plan: OperatorPlanInput) =>
      request<OperatorPlanValidation>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/plan/validate`,
        { method: "POST", body: JSON.stringify(plan) },
      ),
    createPlan: (zoneId: string, conversationId: string, plan: OperatorPlanInput) =>
      request<{ turn: OperatorTurn; validation: OperatorPlanValidation }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/plan`,
        { method: "POST", body: JSON.stringify(plan) },
      ),
    decidePlan: (zoneId: string, conversationId: string, decision: OperatorPlanDecisionInput) =>
      request<OperatorTurn>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/plan/decision`,
        { method: "POST", body: JSON.stringify(decision) },
      ),
    executePlan: (zoneId: string, conversationId: string, planSeq: number) =>
      request<OperatorExecutionResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/plan/execute`,
        { method: "POST", body: JSON.stringify({ plan_seq: planSeq }) },
      ),
    planSecrets: (zoneId: string, conversationId: string, planSeq: number, signal?: AbortSignal) =>
      request<OperatorPlanSecretsStatus>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/plans/${planSeq}/secrets`,
        { signal },
      ),
    providePlanSecrets: (
      zoneId: string,
      conversationId: string,
      planSeq: number,
      stepId: string,
      values: Record<string, string>,
    ) =>
      request<OperatorPlanSecretsResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/plans/${planSeq}/secrets`,
        { method: "PUT", body: JSON.stringify({ step_id: stepId, values }) },
      ),
    sendMessage: (
      zoneId: string,
      conversationId: string,
      message: string,
      provider: string | undefined,
      onStage: (stage: OperatorProgressStage) => void,
      onToken?: (text: string) => void,
      onReasoning?: (text: string) => void,
      options?: { signal?: AbortSignal; clientMessageId?: string; correlationId?: string },
    ): Promise<OperatorMessageResult> =>
      streamOperatorMessage(
        zoneId,
        conversationId,
        message,
        provider,
        onStage,
        onToken,
        onReasoning,
        options,
      ),
    cancelRun: (zoneId: string, conversationId: string, clientMessageId: string) =>
      request<{ ok: true; message_run: OperatorMessageRun }>(
        `/v1/zones/${encodeURIComponent(zoneId)}/operator-conversations/${encodeURIComponent(
          conversationId,
        )}/message-runs/cancel`,
        { method: "POST", body: JSON.stringify({ client_message_id: clientMessageId }) },
      ),
  },

  sessions: {
    list: async (zoneId: string, query: SessionQuery = {}): Promise<Paged<Session>> => {
      const res = await request<CoordinatorList<WireSession>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agents${queryString({
          status: query.status,
          lifecycle: query.lifecycle,
          application_id: query.application_id,
          label: query.label,
          limit: query.limit,
          cursor: query.cursor,
        })}`,
      );
      return { rows: res.items.map(session), nextCursor: res.next_cursor };
    },
    get: async (zoneId: string, id: string) =>
      session(
        await request<WireSession>(
          `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}`,
        ),
      ),
    children: async (zoneId: string, id: string) => {
      const res = await request<CoordinatorList<WireSession>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/children`,
      );
      return res.items.map(session);
    },
    effectiveAuthority: async (zoneId: string, id: string) =>
      effectiveAuthority(
        await request<WireEffectiveAuthority>(
          `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/effective-authority`,
        ),
      ),
    suspend: async (zoneId: string, id: string) =>
      session(
        await request<WireSession>(
          `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/suspend`,
          { method: "PATCH", body: JSON.stringify({}) },
        ),
      ),
    resume: async (zoneId: string, id: string) =>
      session(
        await request<WireSession>(
          `/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}/resume`,
          { method: "PATCH", body: JSON.stringify({}) },
        ),
      ),
    terminate: (zoneId: string, id: string) =>
      request<void>(`/coord/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },

  execution: {
    services: async (zoneId: string) => {
      const res = await request<CoordinatorList<SessionService>>(
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
    inbound: async (zoneId: string, sessionId: string) => {
      const res = await request<CoordinatorList<DelegationEdge>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/inbound/${encodeURIComponent(sessionId)}`,
      );
      return res.items;
    },
    outbound: async (zoneId: string, sessionId: string) => {
      const res = await request<CoordinatorList<DelegationEdge>>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/outbound/${encodeURIComponent(sessionId)}`,
      );
      return res.items;
    },
    traverse: (zoneId: string, id: string) =>
      request<DelegationHop[]>(
        `/coord/zones/${encodeURIComponent(zoneId)}/delegations/${encodeURIComponent(id)}/traverse`,
      ),
    impact: (zoneId: string, id: string) =>
      request<DelegationImpact>(
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
      const res = await request<ListEnvelope<AuditEvent>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/audit${queryString({
          limit: query.limit ?? 100,
          cursor: query.cursor,
          decision: query.decision,
          event_type: query.event_type,
          request_id: query.request_id,
          application_id: query.application_id,
          agent_session_id: query.agent_session_id,
          session_id: query.session_id,
          label: query.label,
          since: query.since,
          until: query.until,
        })}`,
      );
      return { rows: res.items, nextCursor: res.next_cursor };
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

  auditRetention: {
    get: (signal?: AbortSignal) => request<AuditRetention>("/v1/audit-retention", { signal }),
    update: (days: number) =>
      request<AuditRetention>("/v1/audit-retention", {
        method: "PUT",
        body: JSON.stringify({ retention_days: days }),
      }),
  },

  adminAudit: {
    list: async (zoneId: string, query: AdminAuditQuery = {}): Promise<Paged<AdminAuditEvent>> => {
      const res = await request<ListEnvelope<AdminAuditEvent>>(
        `/v1/zones/${encodeURIComponent(zoneId)}/admin-audit${queryString({
          limit: query.limit ?? 100,
          cursor: query.cursor,
          actor_id: query.actor_id,
          entity_type: query.entity_type,
          entity_id: query.entity_id,
          method: query.method,
          since: query.since,
          until: query.until,
        })}`,
      );
      return { rows: res.items, nextCursor: res.next_cursor };
    },
  },

  providerConnections: {
    list: async (zoneId: string, query: ProviderConnectionListQuery = {}) =>
      (
        await fetchAllPages<ProviderConnection>(
          `/v1/zones/${encodeURIComponent(zoneId)}/provider-connections${queryString({
            provider_id: query.provider_id,
            subject_id: query.subject_id,
            status: query.status,
          })}`,
        )
      ).rows,
    authorize: (zoneId: string, input: ProviderConnectionAuthorizeInput) =>
      request<ProviderConnectionAuthorizeResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/provider-connections/oauth/authorize`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    revoke: (zoneId: string, input: ProviderConnectionRevokeInput) =>
      request<ProviderConnectionRevokeResult>(
        `/v1/zones/${encodeURIComponent(zoneId)}/provider-connections/revoke`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
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
      const app = await request<Application>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}/rotate-secret`,
        { method: "POST", body: "{}" },
      );
      if (!app.client_secret) throw new ConsoleApiError(500, "missing_client_secret");
      return { id, clientSecret: app.client_secret };
    },
    revoke: (zoneId: string, id: string) =>
      request<void>(
        `/v1/zones/${encodeURIComponent(zoneId)}/applications/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    status: () => request<ControlEndpointStatus>("/control/status"),
    enable: () => request<ControlEndpointStatus>("/control/enable", { method: "POST", body: "{}" }),
    disable: () =>
      request<ControlEndpointStatus>("/control/disable", { method: "POST", body: "{}" }),
    issueToken: (zoneId: string, input: ControlTokenInput) =>
      request<ControlTokenResult>("/control/token", {
        method: "POST",
        body: JSON.stringify({ zoneId, ...input }),
      }),
  },
};

// Ensures the zone-bound control resource carries at least the full permission surface so
// STS can validate every control token. Scopes are unioned, never replaced, so a resource
// already widened by the Console (or a superset deployment) is never silently shrunk.
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
  const desired = [...new Set([...current.scopes, ...CONTROL_SCOPES])].sort();
  const currentScopes = [...current.scopes].sort();
  const matches =
    currentScopes.length === desired.length &&
    desired.every((scope, index) => scope === currentScopes[index]);
  if (!matches) {
    await request<Resource>(
      `/v1/zones/${encodeURIComponent(zoneId)}/resources/${encodeURIComponent(current.id)}`,
      { method: "PATCH", body: JSON.stringify({ scopes: desired }) },
    );
  }
}
