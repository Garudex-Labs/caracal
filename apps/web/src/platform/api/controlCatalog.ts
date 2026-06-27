/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Authoritative browser-side mirror of the Control API permission surface the engine exposes.
*/
import type { ControlPermission } from "./types";

export const CONTROL_MIN_TTL_SECONDS = 60;
export const CONTROL_MAX_TTL_SECONDS = 900;
export const CONTROL_AUDIENCE = "caracal-control";

// Complete catalog of Control permissions, mirroring the engine's remote surface
// (control:<noun>:<verb>). A drift guard test asserts this stays equal to the engine's
// describeRemoteSurface()/controlScopes() output so the Web key creator and the control
// resource STS validates against never fall behind the Console.
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
    summary: "Suspend and resume agent sessions.",
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
    summary: "Create, update, and register applications.",
  },
  {
    command: "app",
    verb: "delete",
    action: "delete",
    scope: "control:app:delete",
    summary: "Delete applications.",
  },
  {
    command: "audit",
    verb: "read",
    action: "read",
    scope: "control:audit:read",
    summary: "Search and tail audit events.",
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
  {
    command: "grant",
    verb: "read",
    action: "read",
    scope: "control:grant:read",
    summary: "List and inspect delegated grants.",
  },
  {
    command: "grant",
    verb: "write",
    action: "write",
    scope: "control:grant:write",
    summary: "Create delegated grants binding an application and user to resource scopes.",
  },
  {
    command: "grant",
    verb: "delete",
    action: "delete",
    scope: "control:grant:delete",
    summary: "Revoke delegated grants.",
  },
  {
    command: "explain",
    verb: "read",
    action: "read",
    scope: "control:explain:read",
    summary: "Explain the authorization decision for a request.",
  },
  {
    command: "identity-provider",
    verb: "read",
    action: "read",
    scope: "control:identity-provider:read",
    summary: "List and inspect identity providers.",
  },
  {
    command: "identity-provider",
    verb: "write",
    action: "write",
    scope: "control:identity-provider:write",
    summary: "Create and update identity providers.",
  },
  {
    command: "identity-provider",
    verb: "delete",
    action: "delete",
    scope: "control:identity-provider:delete",
    summary: "Delete identity providers.",
  },
  {
    command: "policy",
    verb: "read",
    action: "read",
    scope: "control:policy:read",
    summary: "List, inspect, and validate policies.",
  },
  {
    command: "policy",
    verb: "write",
    action: "write",
    scope: "control:policy:write",
    summary: "Create and version policies.",
  },
  {
    command: "policy",
    verb: "delete",
    action: "delete",
    scope: "control:policy:delete",
    summary: "Delete policies.",
  },
  {
    command: "policy-set",
    verb: "read",
    action: "read",
    scope: "control:policy-set:read",
    summary: "List, inspect, and simulate policy sets.",
  },
  {
    command: "policy-set",
    verb: "write",
    action: "write",
    scope: "control:policy-set:write",
    summary: "Create, version, and activate policy sets.",
  },
  {
    command: "policy-set",
    verb: "delete",
    action: "delete",
    scope: "control:policy-set:delete",
    summary: "Delete policy sets.",
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
    command: "session",
    verb: "read",
    action: "read",
    scope: "control:session:read",
    summary: "List authority sessions.",
  },
];

export const CONTROL_SCOPES = CONTROL_PERMISSIONS.map((permission) => permission.scope).sort();

// Human-readable noun descriptions for the Reference tab. Scopes and summaries are derived
// from CONTROL_PERMISSIONS so the reference can never drift from the grantable surface.
export const CONTROL_NOUN_DESCRIPTIONS: Record<string, string> = {
  agent: "Inspect and manage agent sessions.",
  app: "Manage application identities.",
  audit: "Search the audit ledger.",
  delegation: "Inspect and revoke delegated authority.",
  explain: "Explain authorization decisions.",
  grant: "Bind applications and users to resource scopes through delegated grants.",
  "identity-provider": "Manage upstream identity providers.",
  policy: "Author and manage policies.",
  "policy-set": "Group, activate, and simulate policy sets.",
  resource: "Manage protected resources.",
  session: "Inspect authority sessions.",
};
