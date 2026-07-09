/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides formatting helpers for delegation identity, status, and errors.
*/
import { ConsoleApiError } from "@/platform/api/client";
import type { DelegationEdge } from "@/platform/api/types";

export function delegationErrorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.code === "coordinator_not_configured") return "Coordinator service not connected.";
    if (error.code === "upstream_unreachable") return "Coordinator service unreachable.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

// A delegation can be active, revoked, or expired; render each with an honest tone so a
// no-longer-usable edge never appears healthy. The status is authoritative and an edge can
// expire while loaded.
export function edgeStatusTone(edge: DelegationEdge): "success" | "danger" | "muted" {
  if (edge.status === "revoked") return "danger";
  if (edge.status === "expired") return "danger";
  if (edge.expires_at && Date.parse(edge.expires_at) <= Date.now()) return "muted";
  return "success";
}

export function edgeStatusLabel(edge: DelegationEdge): string {
  if (edge.status === "active" && edge.expires_at && Date.parse(edge.expires_at) <= Date.now()) {
    return "expiring";
  }
  return edge.status;
}
