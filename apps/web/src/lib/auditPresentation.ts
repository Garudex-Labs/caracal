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
  resource_not_found: "Resource missing",
  credential_refresh_failed: "Credential refresh failed",
  policy_eval_failed: "Policy error",
};

export function auditEventLabel(eventType: string): string {
  return AUDIT_EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
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
