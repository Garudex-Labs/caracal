/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file translates raw audit event fields into human-readable console copy.
*/
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  token_exchange: "Token issued",
  exchange_denied: "Token denied",
  gateway_resource_request: "Resource call",
  scope_mismatch: "Scope denied",
  rate_limited: "Rate limited",
  replay_detected: "Replay blocked",
  jti_collision: "Token ID collision",
  resource_not_found: "Resource missing",
  credential_refresh_failed: "Credential refresh failed",
  policy_eval_failed: "Policy error",
  "control.invoke": "Control command",
};

export function auditEventLabel(eventType: string): string {
  return AUDIT_EVENT_LABELS[eventType] ?? eventType.replace(/[._]/g, " ");
}

export function auditDecisionTone(decision: string | null): "success" | "danger" | "muted" {
  if (decision === "allow") return "success";
  if (decision === "deny") return "danger";
  return "muted";
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
  metadata_json: Record<string, unknown> | null;
}

// Denial reason codes emitted by the STS and policy engine, each paired with the
// operator action that resolves the denial.
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
  runtime_injection_not_allowed: {
    label: "Runtime credential injection is disabled for this provider",
    hint: "Enable runtime injection on the provider or use a granted credential flow.",
  },
  no_user_principal: {
    label: "No authenticated user session backs this request",
    hint: "The subject must sign in before the application can exchange for this resource.",
  },
  no_provider_grant: {
    label: "The user has not granted this provider",
    hint: "Ask the user to authorize the provider grant, then retry the exchange.",
  },
  no_active_policy_set: {
    label: "The zone has no active policy set",
    hint: "Activate a policy set for this zone; requests default to deny without one.",
  },
  no_rule_matched: {
    label: "No policy rule matched, so default-deny applied",
    hint: "Add an allow rule covering this application, resource, and scope combination.",
  },
  session_revoked: {
    label: "The backing session was revoked",
    hint: "The subject must establish a new session before access can resume.",
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
// exchange events carry application_name directly, others only the id.
export function auditActor(event: AuditEventLike): string | null {
  const meta = event.metadata_json ?? {};
  return (
    metaStr(meta, "application_name") ??
    metaStr(meta, "application_id") ??
    metaStr(meta, "subject") ??
    metaStr(meta, "client_id")
  );
}

export function auditReason(event: AuditEventLike): { label: string; hint: string | null } | null {
  const meta = event.metadata_json ?? {};
  const reason = metaStr(meta, "reason");
  if (!reason) return null;
  const known = AUDIT_DENY_REASONS[reason];
  if (known) return known;
  return { label: reason.replace(/_/g, " "), hint: null };
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
      const hops = typeof meta.delegation_hop_count === "number" ? meta.delegation_hop_count : 0;
      const via = hops > 0 ? ` via delegation (${hops} hop${hops === 1 ? "" : "s"})` : "";
      return `${actor} was issued a credential for ${target}${via}`;
    }
    case "exchange_denied":
      return `${actor} was denied a credential for ${target}${reason ? ` - ${reason.label}` : ""}`;
    case "gateway_resource_request": {
      const method = metaStr(meta, "method");
      const call = `${actor} called ${target}${method ? ` (${method})` : ""}`;
      const errorKind = metaStr(meta, "error_kind");
      if (errorKind)
        return `${call} - ${GATEWAY_ERROR_KINDS[errorKind] ?? errorKind.replace(/_/g, " ")}`;
      const status = meta.upstream_status;
      return typeof status === "number" ? `${call} - upstream responded ${status}` : call;
    }
    case "scope_mismatch":
      return `${actor} requested scopes outside its grant for ${target}`;
    case "rate_limited":
      return `${actor} was rate limited on ${target}`;
    case "replay_detected":
      return `A previously used token was replayed${resource ? ` against ${resource}` : ""} and blocked`;
    case "jti_collision":
      return `A duplicate token identifier was rejected${resource ? ` for ${resource}` : ""}`;
    case "resource_not_found":
      return `${actor} requested a resource that does not exist`;
    case "credential_refresh_failed":
      return `Credential refresh failed${resource ? ` for ${resource}` : ""}`;
    case "policy_eval_failed":
      return `Policy evaluation failed${resource ? ` for ${resource}` : ""}`;
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
        ? `${auditEventLabel(event.event_type)} \u00b7 ${context}`
        : auditEventLabel(event.event_type);
    }
  }
}

export interface AuditEntity {
  kind: "application" | "resource" | "agent" | "delegation";
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
  const agentSessionId = metaStr(meta, "agent_session_id");
  if (agentSessionId) entities.push({ kind: "agent", id: agentSessionId, label: agentSessionId });
  const delegationEdgeId = metaStr(meta, "delegation_edge_id");
  if (delegationEdgeId) {
    entities.push({ kind: "delegation", id: delegationEdgeId, label: delegationEdgeId });
  }
  return entities;
}

export interface DelegationHop {
  applicationId: string | null;
  agentSessionId: string | null;
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
      agentSessionId: typeof hop.agent_session_id === "string" ? hop.agent_session_id : null,
      delegationEdgeId: typeof hop.delegation_edge_id === "string" ? hop.delegation_edge_id : null,
    }));
}
