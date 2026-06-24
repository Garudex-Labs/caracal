/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file declares the control-plane data shapes the web client consumes over the console backend.
*/
export type RegistrationMethod = "managed" | "dcr";

export interface Zone {
  id: string;
  name: string;
  slug: string;
  dcr_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ZoneInput {
  name: string;
  slug?: string;
  dcr_enabled?: boolean;
}

export type DcrShutdownMode = "keep_live" | "revoke_live";

export interface ZonePatchInput {
  name?: string;
  slug?: string;
  dcr_enabled?: boolean;
  dcr_shutdown?: DcrShutdownMode;
}

export interface ZoneDcrStatus {
  id: string;
  dcr_enabled: boolean;
  live_dcr_applications: number;
}

export interface Application {
  id: string;
  zone_id: string;
  name: string;
  registration_method: RegistrationMethod;
  traits?: string[];
  expires_at?: string | null;
  client_secret?: string;
  created_at: string;
}

export interface ApplicationInput {
  name: string;
  registration_method: "managed";
  traits?: string[];
}

export interface ApplicationPatchInput {
  name?: string;
  client_secret?: string;
  traits?: string[];
}

export type ResourceOperationEnforcement = "enforced" | "transport_uniform";

export interface ResourceOperation {
  method: string;
  path: string;
  scope: string;
}

export interface Resource {
  id: string;
  zone_id: string;
  name: string;
  identifier: string;
  upstream_url: string | null;
  gateway_application_id: string | null;
  scopes: string[];
  credential_provider_id: string | null;
  operations: ResourceOperation[];
  operation_enforcement: ResourceOperationEnforcement;
  created_at: string;
  updated_at: string;
}

export interface ResourceInput {
  name?: string;
  identifier?: string;
  upstream_url?: string | null;
  scopes: string[];
  credential_provider_id?: string | null;
  gateway_application_id?: string | null;
  operations?: ResourceOperation[];
  operation_enforcement?: ResourceOperationEnforcement;
}

export type ResourcePatchInput = Partial<ResourceInput>;

export type ProviderKind =
  | "none"
  | "caracal_mandate"
  | "oauth2_authorization_code"
  | "oauth2_client_credentials"
  | "api_key"
  | "bearer_token";

export type ProviderSecretConfigKey = "client_secret" | "private_key" | "api_key" | "bearer_token";

export interface Provider {
  id: string;
  zone_id: string;
  name: string;
  identifier: string;
  kind: ProviderKind;
  config_json: Record<string, unknown>;
  secret_config_keys: ProviderSecretConfigKey[];
  created_at: string;
  updated_at: string;
}

export interface ProviderInput {
  name?: string;
  identifier?: string;
  kind: ProviderKind;
  config_json?: Record<string, unknown>;
}

export interface ProviderPatchInput {
  name?: string;
  identifier?: string;
  kind?: ProviderKind;
  config_json?: Record<string, unknown>;
}

export interface Policy {
  id: string;
  zone_id: string;
  name: string;
  description: string | null;
  owner_type: string;
  created_by: string;
  created_at: string;
}

export interface PolicyVersion {
  id: string;
  policy_id: string;
  version: number;
  content?: string;
  content_sha256: string;
  schema_version: string;
  created_by?: string;
  created_at: string;
}

export type PolicyDetail = Policy & { versions: PolicyVersion[] };

export interface PolicyInput {
  name: string;
  description?: string;
  content: string;
}

export interface PolicyValidateResult {
  valid: boolean;
  error?: string;
  detail?: string;
  schema_version?: string;
  input_schema_version?: string;
  output_contract?: {
    package: string;
    rule: string;
    decision: string[];
    evaluation_status: string[];
  };
  preview?: PolicyPreview | null;
}

export interface PolicyPreview {
  package: string;
  rules: string[];
  default_result: boolean;
  decisions: string[];
  inputs_referenced: string[];
  data_referenced: string[];
}

export interface PolicyTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface PolicySet {
  id: string;
  zone_id: string;
  name: string;
  description: string | null;
  active_version_id: string | null;
  created_at: string;
}

export interface PolicyManifestEntry {
  policy_version_id: string;
}

export interface PolicySetVersion {
  id: string;
  policy_set_id: string;
  version: number;
  manifest_json?: PolicyManifestEntry[];
  manifest_sha256: string;
  schema_version: string;
  policies?: string[];
  created_at: string;
}

export type PolicySetDetail = PolicySet & { versions?: PolicySetVersion[] };

export interface ActivationStatus {
  zone_id: string;
  policy_set_id: string;
  version_id: string;
  active: boolean;
  active_version_id: string | null;
  shadow_version_id: string | null;
  manifest_sha256: string | null;
  propagation_status: string;
  outbox: { state: string; [key: string]: unknown };
  sts: { state: string; loaded?: boolean; [key: string]: unknown };
}

export interface SimulateResult {
  dry_run: boolean;
  would_activate: boolean;
  policy_set_id: string;
  version_id: string;
  schema_version: string;
  manifest_sha256: string;
  policies: string[];
  warnings: string[];
  explanation: { evaluation: string; reason?: string; [key: string]: unknown };
  result: unknown;
}

export interface Session {
  id: string;
  zone_id: string;
  session_type: string;
  subject_id: string;
  parent_id: string | null;
  status: string;
  expires_at: string;
  authenticated_at: string;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  zone_id: string;
  event_type: string;
  request_id: string | null;
  decision: string | null;
  evaluation_status: string | null;
  metadata_json: Record<string, unknown> | null;
  occurred_at: string;
  ingested_at: string;
}

export interface AuditDetail extends AuditEvent {
  policy_set_id: string | null;
  policy_set_version_id: string | null;
  manifest_sha: string | null;
  determining_policies_json: unknown[] | null;
  diagnostics_json: unknown[] | null;
}

export interface DecisionTrace {
  request_id: string;
  zone_id: string;
  final_decision: string;
  denied: unknown[];
  events: AuditDetail[];
}

export interface RowList<T> {
  rows: T[];
  next_cursor: string | null;
}

export interface ConsoleStatus {
  configured: boolean;
  reachable: boolean;
  apiUrl: string;
  coordinatorConfigured?: boolean;
  coordinatorReachable?: boolean;
  coordinatorUrl?: string;
}

export type DiagnosticStatus = "ok" | "warn" | "fail";
export type DiagnosticSection = "health" | "readiness" | "zones" | "preflight";
export type DiagnosticZoneScope = "all" | "selected" | "none";

export interface DiagnosticCheck {
  section: DiagnosticSection;
  check: string;
  status: DiagnosticStatus;
  detail: string;
  advice?: string;
}

export interface DiagnosticSummary {
  ok: number;
  warn: number;
  fail: number;
  total: number;
}

export interface DiagnosticContext {
  apiUrl: string;
  zoneScope: DiagnosticZoneScope;
  zoneIds: string[];
}

export interface DiagnosticsReport {
  command: "doctor";
  mode: "system" | "preflight";
  ready: boolean;
  strict: boolean;
  context: DiagnosticContext;
  summary: DiagnosticSummary;
  checks: DiagnosticCheck[];
  generatedAt: string;
}

export type AgentStatus = "active" | "suspended" | "terminated";

export interface Agent {
  agent_session_id: string;
  zone_id: string;
  application_id: string;
  parent_id: string | null;
  subject_session_id: string | null;
  lifecycle: string;
  labels: string[];
  status: AgentStatus;
  depth: number;
  ttl_seconds: number | null;
  metadata: Record<string, unknown> | null;
  spawned_at: string;
  terminated_at: string | null;
  last_heartbeat_at: string | null;
  heartbeat_deadline_at: string | null;
}

export interface CoordinatorList<T> {
  items: T[];
  next_cursor: string | null;
}

export interface EffectiveAuthority {
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

export interface DelegationEdge {
  id: string;
  zone_id: string;
  source_session_id: string;
  target_session_id: string;
  issuer_application_id: string | null;
  receiver_application_id: string | null;
  parent_edge_id: string | null;
  resource_id: string | null;
  scopes: string[];
  constraints_json: Record<string, unknown> | null;
  status: string;
  edge_version: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface DelegationHop {
  id: string;
  source_session_id: string;
  target_session_id: string;
  depth: number;
}

export interface DelegationImpactRow extends DelegationHop {
  subject_session_id: string | null;
}

/* ------------------------------ Provider grants ----------------------------- */

export interface ProviderGrant {
  id: string;
  zone_id: string;
  user_id: string;
  resource_id: string;
  provider_id: string;
  scopes: string[];
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderGrantAuthorizeInput {
  user_id: string;
  resource_id: string;
  provider_id: string;
  scopes: string[];
}

export interface ProviderGrantAuthorizeResult {
  authorization_url: string;
  state: string;
  expires_at: string;
}

export interface ProviderGrantRevokeInput {
  user_id: string;
  resource_id: string;
  provider_id: string;
}

export interface ProviderGrantListQuery {
  provider_id?: string;
  resource_id?: string;
  user_id?: string;
  status?: string;
}

/* -------------------------------- Control API ------------------------------- */

export type ControlAction = "read" | "write" | "delete";

export interface ControlPermission {
  command: string;
  verb: string;
  action: ControlAction;
  scope: string;
  summary: string;
}

export interface ControlKey {
  id: string;
  name: string;
  scopes: string[];
  maxTtlSeconds?: number;
  expiresAt?: string;
  createdAt: string;
}

export interface ControlKeyCreateInput {
  name: string;
  scopes: string[];
  maxTtlSeconds?: number;
  expiresAt?: string;
}

export interface ControlKeyCreateResult {
  id: string;
  name: string;
  clientSecret: string;
  scopes: string[];
  maxTtlSeconds?: number;
  expiresAt?: string;
}

/* ------------------------------- Pagination -------------------------------- */

export interface Paged<T> {
  rows: T[];
  nextCursor: string | null;
}

/* --------------------------------- Filters --------------------------------- */

export interface AuditQuery {
  decision?: string;
  event_type?: string;
  request_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface SessionQuery {
  status?: string;
  subject_id?: string;
  limit?: number;
  cursor?: string;
}

export interface AgentQuery {
  status?: string;
  lifecycle?: string;
  application_id?: string;
  label?: string;
  limit?: number;
  cursor?: string;
}

export interface DelegationQuery {
  limit?: number;
  cursor?: string;
}

export interface DiagnosticsOptions {
  zoneId?: string;
  strict?: boolean;
  preflight?: boolean;
}
