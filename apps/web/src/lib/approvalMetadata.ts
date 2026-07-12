/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file reads approval hold challenge metadata into the facts an approver decides on.
*/
import type { StepUpChallenge } from "@/platform/api/types";

// Requested scopes and resources travel in the challenge metadata as authorization facts.
// Anything else in the metadata stays visible through the raw record, not the summary.
export function requestedAuthority(challenge: StepUpChallenge): {
  scopes: string[];
  resources: string[];
} {
  const meta = challenge.metadata_json;
  const pick = (key: string): string[] => {
    const value = meta?.[key];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    return typeof value === "string" && value ? [value] : [];
  };
  return { scopes: pick("requested_scopes"), resources: pick("resources") };
}

// The requesting session run, when the exchange carried lineage. Lets an approver jump from
// the hold to the exact run asking for authority before deciding. The session id travels in
// the challenge metadata as agent_session_id, the same key the exchange and audit trail use.
export function sessionLineage(challenge: StepUpChallenge): { session?: string; edge?: string } {
  const meta = challenge.metadata_json;
  if (!meta) return {};
  return {
    session: typeof meta.agent_session_id === "string" ? meta.agent_session_id : undefined,
    edge: typeof meta.delegation_edge_id === "string" ? meta.delegation_edge_id : undefined,
  };
}
