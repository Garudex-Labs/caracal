/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file translates raw audit event fields into human-readable console copy.
*/
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  token_exchange: "Token issued",
  gateway_resource_request: "Resource call",
  replay_detected: "Replay blocked",
  jti_collision: "Token ID collision",
  step_up_issued: "Approval requested",
  step_up_decided: "Approval decided",
  step_up_consumed: "Approval consumed",
  run_launch: "Workload launch",
  "control.invoke": "Control command",
};

// The event title shown to operators. The STS records every exchange decision under the
// token_exchange event type with the outcome in `decision`, so the label must read the
// decision to avoid presenting a denial as an issued credential.
export function auditEventLabel(eventType: string, decision?: string | null): string {
  if (eventType === "token_exchange" && decision === "deny") return "Token denied";
  if (eventType === "run_launch" && decision === "deny") return "Workload launch denied";
  if (eventType === "step_up_decided") {
    if (decision === "approved") return "Approval granted";
    if (decision === "rejected") return "Approval rejected";
  }
  return AUDIT_EVENT_LABELS[eventType] ?? eventType.replace(/[._]/g, " ");
}

export function auditDecisionTone(
  decision: string | null,
): "success" | "danger" | "warning" | "muted" {
  if (decision === "allow" || decision === "approved" || decision === "consumed") return "success";
  if (decision === "deny" || decision === "rejected") return "danger";
  if (decision === "partial" || decision === "pending") return "warning";
  return "muted";
}

// Audit domains group the platform's event types into the investigation lanes operators
// reach for first. Every emitted event type belongs to exactly one category, and each
// category maps to the server-side event_type filter it stands for.
export interface AuditCategory {
  id: string;
  label: string;
  types: readonly string[];
}

export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  { id: "authority", label: "Authority decisions", types: ["token_exchange", "run_launch"] },
  { id: "resource", label: "Resource access", types: ["gateway_resource_request"] },
  {
    id: "approvals",
    label: "Human approvals",
    types: ["step_up_issued", "step_up_decided", "step_up_consumed"],
  },
  { id: "security", label: "Security events", types: ["replay_detected", "jti_collision"] },
  { id: "control", label: "Control API", types: ["control.invoke"] },
];

export function auditCategory(eventType: string): AuditCategory | null {
  return AUDIT_CATEGORIES.find((c) => c.types.includes(eventType)) ?? null;
}

// Pulls the resource/method context out of an audit event's metadata for a one-line summary.
export function auditEventContext(event: {
  metadata_json: Record<string, unknown> | null;
}): string {
  const meta = event.metadata_json ?? {};
  const parts: string[] = [];
  const resource = meta.resource ?? meta.resource_id ?? meta.target;
  const method = meta.method ?? meta.action;
  if (typeof method === "string" && method) parts.push(method);
  if (typeof resource === "string" && resource) parts.push(resource);
  return parts.join(" \u00b7 ");
}

export interface AuditEventLike {
  event_type: string;
  decision: string | null;
  evaluation_status?: string | null;
  metadata_json: Record<string, unknown> | null;
}

// Denial reason codes, each paired with the operator action that resolves the denial. The
// STS carries the reason on `evaluation_status` for exchange denials and in `metadata.reason`
// for provider and control denials; both feed this table.
export const AUDIT_DENY_REASONS: Record<string, { label: string; hint: string }> = {
  no_provider: {
    label: "No provider is mapped to this resource",
    hint: "Attach an upstream provider to the resource so credentials can be issued.",
  },
  provider_not_found: {
    label: "The mapped provider no longer exists",
    hint: "Re-link the resource to an existing provider.",
  },
  provider_config_invalid: {
    label: "The provider configuration is invalid",
    hint: "Fix the provider's endpoint and credential configuration, then retry.",
  },
  provider_unavailable: {
    label: "The resource's provider could not be loaded",
    hint: "Check the provider mapped to this resource; it may have been deleted or misconfigured.",
  },
  runtime_injection_not_allowed: {
    label: "Runtime credential injection is disabled for this provider",
    hint: "Enable runtime injection on the provider or use a granted credential flow.",
  },
  credential_injection_denied: {
    label: "Credential injection was refused for this workload",
    hint: "The provider or policy refused injection for this binding; review the provider's runtime injection setting.",
  },
  no_user_principal: {
    label: "No authenticated user session backs this request",
    hint: "The subject must sign in before the application can exchange for this resource.",
  },
  no_provider_grant: {
    label: "The user has not granted this provider",
    hint: "Ask the user to authorize the provider grant, then retry the exchange.",
  },
  no_provider_connection: {
    label: "The subject has not connected this provider",
    hint: "Ask the subject to connect their account from the provider's Connections panel.",
  },
  no_active_policy_set: {
    label: "The zone has no active policy set",
    hint: "Activate a policy set for this zone; requests default to deny without one.",
  },
  no_rule_matched: {
    label: "No policy rule matched, so default-deny applied",
    hint: "Add an allow rule covering this application, resource, and scope combination.",
  },
  policy_denied: {
    label: "Denied by policy",
    hint: "No allow rule matched this request. Open the decision trace to see the determining policies and diagnostics.",
  },
  policy_eval_failed: {
    label: "Policy evaluation failed",
    hint: "The policy engine returned an error; check the zone's active policy set for compile errors.",
  },
  session_revoked: {
    label: "The backing session was revoked",
    hint: "The subject must establish a new session before access can resume.",
  },
  resource_not_found: {
    label: "The requested resource is not registered",
    hint: "Register the resource identifier in this zone, or fix the identifier the application requests.",
  },
  scope_mismatch: {
    label: "Requested scopes exceed what the resource allows",
    hint: "Narrow the requested scopes or add them to the resource's scope set.",
  },
  resource_outside_delegation: {
    label: "The resource is outside the delegated authority",
    hint: "The inbound delegation does not cover this resource; delegate again with the resource in scope.",
  },
  operation_not_permitted: {
    label: "The operation is not declared by the resource",
    hint: "Declare the HTTP operation on the resource, or stop requesting it.",
  },
  rate_limited: {
    label: "The application hit the resource's rate limit",
    hint: "Retry after the window resets, or raise the resource's rate limit.",
  },
  credential_not_provisioned: {
    label: "No usable credential exists for this exchange",
    hint: "Provision the provider credential or connect the subject's account.",
  },
  credential_refresh_failed: {
    label: "The provider connection is expired and could not be refreshed",
    hint: "Reconnect the subject from the provider's Connections panel.",
  },
  approval_invalid: {
    label: "The presented approval does not match this request",
    hint: "The challenge, binding, or principal differs from the approved hold; request a new approval.",
  },
  approval_already_consumed: {
    label: "The approval was already used",
    hint: "Each approval releases exactly one exchange; request a new approval.",
  },
  approval_rejected: {
    label: "An approver rejected the hold",
    hint: "The request stays denied until a new hold is raised and approved.",
  },
  approval_expired: {
    label: "The approval hold expired before use",
    hint: "Request a new approval and complete the exchange within its TTL.",
  },
  workload_auth_failed: {
    label: "The workload's secret failed verification",
    hint: "Rotate the workload secret on the Launcher page and update the secret stored on the runtime host.",
  },
  exchange_denied: {
    label: "Every requested resource was refused",
    hint: "Each per-resource denial in this request has its own event; open the decision trace for the full picture.",
  },
};

const GATEWAY_ERROR_KINDS: Record<string, string> = {
  provider_host_not_allowed: "the upstream host is not on the provider allowlist",
  request_build_failed: "the gateway could not build the upstream request",
  transport_error: "a network error interrupted the upstream call",
  upstream_not_addressable: "the upstream address could not be resolved",
};

function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Resolves the human name of the acting principal from event metadata; token
// exchange events carry application_name directly, run events carry workload_name,
// others only the id.
export function auditActor(event: AuditEventLike): string | null {
  const meta = event.metadata_json ?? {};
  return (
    metaStr(meta, "application_name") ??
    metaStr(meta, "workload_name") ??
    metaStr(meta, "application_id") ??
    metaStr(meta, "workload_id") ??
    metaStr(meta, "subject") ??
    metaStr(meta, "client_id")
  );
}

// The reason a request was refused. Provider and control denials record it in
// metadata.reason; STS exchange denials carry it on evaluation_status; a policy verdict
// deny (status "complete") points the operator at the decision trace.
export function auditReason(event: AuditEventLike): { label: string; hint: string | null } | null {
  const meta = event.metadata_json ?? {};
  let code = metaStr(meta, "reason");
  if (!code && event.event_type === "token_exchange" && event.decision === "deny") {
    const status = event.evaluation_status;
    if (status === "complete") code = "policy_denied";
    else if (status && status !== "partial") code = status;
  }
  if (!code) return null;
  const known = AUDIT_DENY_REASONS[code];
  if (known) return known;
  return { label: code.replace(/_/g, " "), hint: null };
}

// Builds the one-line narrative shown in the audit feed: who did what to which
// resource, and why it was refused when the decision went against them.
export function auditSummary(event: AuditEventLike, actorName?: string | null): string {
  const meta = event.metadata_json ?? {};
  const actor = actorName ?? auditActor(event) ?? "An application";
  const resource = metaStr(meta, "resource");
  const target = resource ?? "a resource";
  const reason = auditReason(event);

  switch (event.event_type) {
    case "token_exchange": {
      if (event.decision === "deny") {
        return `${actor} was denied a credential for ${target}${reason ? ` - ${reason.label}` : ""}`;
      }
      const hops = typeof meta.delegation_hop_count === "number" ? meta.delegation_hop_count : 0;
      const via = hops > 0 ? ` via delegation (${hops} hop${hops === 1 ? "" : "s"})` : "";
      return `${actor} was issued a credential for ${target}${via}`;
    }
    case "gateway_resource_request": {
      const method = metaStr(meta, "method");
      const call = `${actor} called ${target}${method ? ` (${method})` : ""}`;
      const errorKind = metaStr(meta, "error_kind");
      if (errorKind)
        return `${call} - ${GATEWAY_ERROR_KINDS[errorKind] ?? errorKind.replace(/_/g, " ")}`;
      const status = meta.upstream_status;
      return typeof status === "number" ? `${call} - upstream responded ${status}` : call;
    }
    case "replay_detected":
      return `A previously used token was replayed${resource ? ` against ${resource}` : ""} and blocked`;
    case "jti_collision":
      return `A duplicate token identifier was rejected${resource ? ` for ${resource}` : ""}`;
    case "step_up_issued": {
      const tier = metaStr(meta, "tier");
      return `A human approval hold was raised for ${actor}${tier ? ` (${tier} tier)` : ""}; the exchange waits on an approver`;
    }
    case "step_up_decided": {
      const approver = metaStr(meta, "approver_subject_id");
      const verdict = event.decision === "rejected" ? "rejected" : "approved";
      return `${approver ? `Approver ${approver}` : "An approver"} ${verdict} the hold for ${actor}${reason ? ` - ${reason.label}` : ""}`;
    }
    case "step_up_consumed":
      return `${actor} redeemed an approved hold to complete the exchange`;
    case "control.invoke": {
      const command = [metaStr(meta, "command"), metaStr(meta, "subcommand")]
        .filter(Boolean)
        .join(" ");
      const verdict = event.decision === "deny" ? "was refused" : "ran";
      return `Control command ${command || "invocation"} ${verdict}${reason ? ` - ${reason.label}` : ""}`;
    }
    default: {
      const context = auditEventContext(event);
      return context
        ? `${auditEventLabel(event.event_type, event.decision)} \u00b7 ${context}`
        : auditEventLabel(event.event_type, event.decision);
    }
  }
}

export interface AuditEntity {
  kind: "application" | "resource" | "session" | "delegation" | "provider" | "approval";
  id: string;
  label: string;
}

// Extracts the linked platform entities referenced by an event so the console
// can offer drill-downs into the pages that own them.
export function auditEntities(event: AuditEventLike): AuditEntity[] {
  const meta = event.metadata_json ?? {};
  const entities: AuditEntity[] = [];
  const applicationId = metaStr(meta, "application_id") ?? metaStr(meta, "client_id");
  if (applicationId) {
    entities.push({
      kind: "application",
      id: applicationId,
      label: metaStr(meta, "application_name") ?? applicationId,
    });
  }
  const resource = metaStr(meta, "resource");
  if (resource) entities.push({ kind: "resource", id: resource, label: resource });
  const providerId = metaStr(meta, "provider_id");
  if (providerId) entities.push({ kind: "provider", id: providerId, label: providerId });
  const sessionId = metaStr(meta, "agent_session_id");
  if (sessionId) entities.push({ kind: "session", id: sessionId, label: sessionId });
  const delegationEdgeId = metaStr(meta, "delegation_edge_id");
  if (delegationEdgeId) {
    entities.push({ kind: "delegation", id: delegationEdgeId, label: delegationEdgeId });
  }
  const challengeId = metaStr(meta, "challenge_id");
  if (challengeId) entities.push({ kind: "approval", id: challengeId, label: challengeId });
  return entities;
}

export interface DelegationHop {
  applicationId: string | null;
  sessionId: string | null;
  delegationEdgeId: string | null;
}

// Reads the recorded delegation chain (issuer to final actor) off a token event.
export function auditDelegationChain(event: AuditEventLike): DelegationHop[] {
  const meta = event.metadata_json ?? {};
  if (!Array.isArray(meta.delegation_chain)) return [];
  return meta.delegation_chain
    .filter((hop): hop is Record<string, unknown> => !!hop && typeof hop === "object")
    .map((hop) => ({
      applicationId: typeof hop.application_id === "string" ? hop.application_id : null,
      sessionId: typeof hop.agent_session_id === "string" ? hop.agent_session_id : null,
      delegationEdgeId: typeof hop.delegation_edge_id === "string" ? hop.delegation_edge_id : null,
    }));
}
