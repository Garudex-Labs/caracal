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
  operator_coauthor_badge: boolean;
  operator_governed: boolean;
  created_by: string | null;
  created_via_operator: boolean;
  updated_by: string | null;
  updated_via_operator: boolean;
  created_at: string;
  updated_at: string;
}

// Longest zone name the control plane accepts; forms cap input at the same bound.
export const ZONE_NAME_MAX = 120;

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
  operator_coauthor_badge?: boolean;
  operator_governed?: boolean;
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
  archived_at?: string | null;
  client_secret?: string;
  created_by: string | null;
  created_via_operator: boolean;
  updated_by: string | null;
  updated_via_operator: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface ApplicationInput {
  name: string;
  registration_method: "managed";
  traits?: string[];
}

export interface ApplicationPatchInput {
  name?: string;
  traits?: string[];
}

export interface WorkloadBinding {
  env: string;
  resource: string;
  scopes?: string[];
  optional?: boolean;
  on_failure?: "warn" | "error";
}

export interface Workload {
  id: string;
  zone_id: string;
  name: string;
  bindings: WorkloadBinding[];
  secret?: string;
  created_by: string | null;
  created_via_operator: boolean;
  created_at: string;
  updated_by: string | null;
  updated_via_operator: boolean;
  updated_at: string | null;
}

export interface WorkloadUpdateInput {
  name?: string;
  bindings?: WorkloadBinding[];
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
  created_by: string | null;
  created_via_operator: boolean;
  updated_by: string | null;
  updated_via_operator: boolean;
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

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  none: "None",
  caracal_mandate: "Caracal mandate",
  oauth2_authorization_code: "OAuth 2.0 (auth code)",
  oauth2_client_credentials: "OAuth 2.0 (client creds)",
  api_key: "API key",
  bearer_token: "Bearer token",
};

export type ProviderSecretConfigKey = "client_secret" | "private_key" | "api_key" | "bearer_token";

export interface Provider {
  id: string;
  zone_id: string;
  name: string;
  identifier: string;
  kind: ProviderKind;
  config_json: Record<string, unknown>;
  secret_config_keys: ProviderSecretConfigKey[];
  connectivity_failed_at: string | null;
  created_by: string | null;
  created_via_operator: boolean;
  updated_by: string | null;
  updated_via_operator: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProviderInput {
  name?: string;
  identifier?: string;
  kind: ProviderKind;
  config_json?: Record<string, unknown>;
  check?: boolean;
}

export interface ProviderPatchInput {
  name?: string;
  identifier?: string;
  kind?: ProviderKind;
  config_json?: Record<string, unknown>;
}

export interface ProviderTestResult {
  status: "ok" | "auth_failed" | "unreachable" | "endpoint_error" | "config_error";
  detail: string;
  checked_at: string;
}

export interface Policy {
  id: string;
  zone_id: string;
  name: string;
  description: string | null;
  owner_type: string;
  created_by: string;
  created_via_operator: boolean;
  updated_by: string | null;
  updated_via_operator: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface PolicyVersion {
  id: string;
  policy_id: string;
  version: number;
  content?: string;
  content_sha256: string;
  schema_version: string;
  created_by?: string;
  created_via_operator?: boolean;
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
  created_by?: string;
  created_via_operator?: boolean;
  updated_by?: string | null;
  updated_via_operator?: boolean;
  created_at: string;
  updated_at?: string | null;
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
  created_by?: string | null;
  created_via_operator?: boolean;
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
  revoked_at: string | null;
  revoked_reason: string | null;
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

export interface AuditRetention {
  retention_days: number;
  max_days: number;
  updated_by: string | null;
  updated_at: string | null;
}

export type StepUpState = "pending" | "approved" | "rejected" | "expired" | "consumed";

export interface StepUpChallenge {
  id: string;
  zone_id: string;
  session_id: string;
  principal_id: string;
  application_id: string | null;
  challenge_type: string;
  tier: string | null;
  approver_class: "operator" | "subject" | "any";
  privacy_mode: "identified" | "pseudonymous" | "anonymous";
  binding: string;
  metadata_json: Record<string, unknown> | null;
  decision_reason: string | null;
  created_at: string;
  expires_at: string;
  satisfied_at: string | null;
  rejected_at: string | null;
  consumed_at: string | null;
  approver_subject_id: string | null;
  state: StepUpState;
}

export interface StepUpDecision {
  id: string;
  state: "approved" | "rejected";
  satisfied_at: string | null;
  rejected_at: string | null;
  approver_subject_id: string;
}

export interface DeniedDecision {
  event_id: string;
  event_type: string;
  evaluation_status: string | null;
  determining_policies: unknown[];
  diagnostics: unknown[];
  metadata: Record<string, unknown>;
  policy_input: unknown;
}

export interface DecisionTrace {
  request_id: string;
  zone_id: string;
  final_decision: string;
  denied: DeniedDecision[];
  events: AuditDetail[];
}

// One recent audit event carried inside the overview payload; a trimmed AuditEvent.
export interface OverviewEvent {
  id: string;
  event_type: string;
  request_id: string | null;
  decision: string | null;
  metadata_json: Record<string, unknown> | null;
  occurred_at: string;
}

// Aggregated dashboard read model: every count is zone-scoped and computed
// server-side, so the dashboard renders from one request.
export interface ZoneOverview {
  zone_id: string;
  generated_at: string;
  applications: { total: number; expired: number; expiring_soon: number };
  resources: { total: number; unenforced: number };
  providers: { total: number };
  policy_sets: { total: number; enforcing: number; active_name: string | null };
  sessions: { active: number };
  decisions_24h: { allowed: number; denied: number };
  recent_events: OverviewEvent[];
}

export interface ListEnvelope<T> {
  items: T[];
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

export type AgentStatus = "active" | "suspended" | "terminated" | "expired";

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
  termination_reason: string | null;
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
  created_by?: string | null;
  created_via_operator?: boolean;
  updated_by?: string | null;
  updated_via_operator?: boolean;
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
  createdBy?: string | null;
  createdViaOperator?: boolean;
  updatedBy?: string | null;
  updatedViaOperator?: boolean;
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

export interface ControlEndpointStatus {
  manageable: boolean;
  reason?: string;
  state?: "enabled" | "disabled";
  service?: "ok" | "down" | "gated";
  enabled?: boolean;
  endpoint?: string;
  invokeUrl?: string;
  healthUrl?: string;
  readyUrl?: string;
  marker?: string;
  detail?: string;
  lifecycle?: string;
  optimization?: string;
}

export interface ControlTokenInput {
  keyId: string;
  clientSecret: string;
  scopes: string[];
  ttlSeconds: number;
}

export interface ControlTokenResult {
  clientId: string;
  accessToken: string;
  tokenType: string;
  resource: string;
  scopes: string[];
  invokePath: string;
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
  application_id?: string;
  agent_session_id?: string;
  session_id?: string;
  label?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface AdminAuditEvent {
  id: string;
  request_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_scope: string | null;
  action: string;
  method: string;
  path: string;
  entity_type: string | null;
  entity_id: string | null;
  status_code: number;
  payload_json: Record<string, unknown> | null;
  occurred_at: string;
  chain_seq: number | null;
  signed: boolean;
}

export interface AdminAuditQuery {
  actor_id?: string;
  entity_type?: string;
  entity_id?: string;
  method?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface SessionQuery {
  status?: string;
  subject_id?: string;
  format?: string;
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

export type InvocationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "canceled"
  | "timed_out"
  | "dead";

// Operator-safe invocation view: lifecycle and timing only, never call payloads.
export interface Invocation {
  id: string;
  zone_id: string;
  service_id: string;
  source_session_id: string | null;
  target_session_id: string | null;
  method: string;
  status: InvocationStatus;
  attempts: number;
  max_attempts: number;
  timeout_ms: number;
  deadline_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AgentService {
  id: string;
  zone_id: string;
  application_id: string;
  endpoint_url: string;
  protocol_versions: string[];
  framework_name: string | null;
  framework_version: string | null;
  capabilities: unknown;
  health: string | null;
  last_heartbeat_at: string | null;
}

export type OperatorCapabilityDomain =
  "zone" | "application" | "provider" | "resource" | "policy" | "grant" | "audit";

export interface OperatorCapability {
  id: string;
  title: string;
  summary: string;
  domain: OperatorCapabilityDomain;
  mutating: boolean;
}

export interface OperatorPlanStepInput {
  id: string;
  capability: string;
  args?: Record<string, unknown>;
}

export interface OperatorPlanInput {
  summary: string;
  steps: OperatorPlanStepInput[];
}

export type OperatorPlanDiagnosticCode =
  "unknown_capability" | "invalid_args" | "duplicate_step_id";

export interface OperatorPlanDiagnostic {
  step_id: string;
  code: OperatorPlanDiagnosticCode;
  message: string;
}

export interface OperatorValidatedStep {
  id: string;
  capability: string;
  title: string;
  domain: OperatorCapabilityDomain;
  mutating: boolean;
}

export interface OperatorPlanValidation {
  ok: boolean;
  mutating: boolean;
  mutating_step_count: number;
  steps: OperatorValidatedStep[];
  diagnostics: OperatorPlanDiagnostic[];
}

export type OperatorConversationStatus = "active" | "archived";

// The operation mode of a conversation, a Caracal-side setting enforced by the API. agent allows
// planning and, after approval, applying changes; ask is strictly read-only and provably
// write-incapable. The mode is never chosen by the model.
export type OperatorConversationMode = "ask" | "agent";

export interface OperatorConversation {
  id: string;
  zone_id: string;
  // A per-zone sequential number that addresses this conversation in the console URL, so a chat
  // has a stable human-readable id and a reload restores it instead of opening a new chat.
  number: number;
  title: string;
  status: OperatorConversationStatus;
  mode: OperatorConversationMode;
  // Whether this conversation has engaged Caracal-governed autopilot. Honored only in agent mode;
  // what it may auto-approve is set in Caracal, never by the conversation.
  autopilot: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  archived_at: string | null;
}

export type OperatorTurnKind =
  "message" | "plan" | "approval" | "rejection" | "execution" | "error" | "note";

export type OperatorNarrativeKind = "message" | "note" | "error";

export interface OperatorTurn {
  id: string;
  conversation_id: string;
  seq: number;
  role: "user" | "operator" | "system";
  kind: OperatorTurnKind;
  content: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
}

export interface OperatorNarrativeInput {
  role: "user" | "operator" | "system";
  kind: OperatorNarrativeKind;
  content: Record<string, unknown>;
  client_token?: string;
}

export interface OperatorPlanStepState {
  id: string;
  capability: string;
  summary: string;
  mutating: boolean;
  status: "pending" | "succeeded" | "failed";
  detail?: string;
}

export interface OperatorPlanState {
  seq: number;
  summary: string;
  decision: "pending" | "approved" | "rejected";
  decision_seq: number | null;
  rejection_reason: string | null;
  steps: OperatorPlanStepState[];
  progress: { total: number; succeeded: number; failed: number; pending: number };
}

export interface OperatorDecidedPlanFact {
  seq: number;
  summary: string;
  decision: "approved" | "rejected";
  executed: boolean;
  changes_applied: number;
  changes_failed: number;
}

export interface OperatorConversationFacts {
  decided_plans: OperatorDecidedPlanFact[];
  rejected_capabilities: string[];
  applied_change_count: number;
  last_error: { seq: number; message: string } | null;
}

export interface OperatorContext {
  conversation_id: string;
  status: OperatorConversationStatus;
  turn_count: number;
  facts: OperatorConversationFacts;
  latest_plan: OperatorPlanState | null;
  pending_approval: boolean;
  recent_messages: { seq: number; role: "user" | "operator" | "system"; text: string }[];
  last_error: { seq: number; message: string } | null;
}

export interface OperatorPlanDecisionInput {
  plan_seq: number;
  decision: "approved" | "rejected";
  reason?: string;
}

export interface OperatorExecutionResult {
  ok: boolean;
  plan_seq: number;
  executed: OperatorTurn[];
  outputs: Record<string, Record<string, unknown>>;
}

// The credential posture of a plan: which steps collect values through the secure prompt and
// whether the sealed vault currently holds them. Field names only - values are write-only.
export interface OperatorPlanSecretsStatus {
  plan_seq: number;
  steps: { step_id: string; fields: string[]; provided: boolean }[];
}

export interface OperatorPlanSecretsResult {
  ok: boolean;
  plan_seq: number;
  step_id: string;
  all_satisfied: boolean;
  auto_approved: boolean;
  approval_turn: OperatorTurn | null;
}

export interface OperatorAiProviderStatus {
  id: string;
  model: string;
  available: boolean;
  contextWindow: number;
}

export interface OperatorAiStatus {
  enabled: boolean;
  providers: OperatorAiProviderStatus[];
}

export interface OperatorAiCheckResult {
  ok: boolean;
  provider: string;
  model: string;
  latency_ms: number;
}

// Where the gateway injects the sealed key for an upstream. Defaults to an Authorization Bearer
// header; an upstream wanting a different header (e.g. api-key) or a query parameter sets it.
export interface OperatorAiAuth {
  location: "header" | "query";
  headerName?: string;
  authScheme?: string;
  queryParamName?: string;
}

// A governed model provider as managed from the console. The key is never represented here: it
// lives sealed in the Caracal provider, so a view carries only the metadata.
export interface OperatorAiProvider {
  slug: string;
  label: string;
  baseUrl: string;
  models: string[];
  contextWindow: number;
  enabled: boolean;
  auth: OperatorAiAuth;
}

export interface OperatorAiProviderList {
  providers: OperatorAiProvider[];
  available: boolean;
}

export interface OperatorAiProviderInput {
  slug: string;
  label: string;
  baseUrl: string;
  models: string[];
  contextWindow: number;
  apiKey: string;
  enabled: boolean;
  auth?: OperatorAiAuth;
}

export interface OperatorAiProviderPatch {
  label?: string;
  baseUrl?: string;
  models?: string[];
  contextWindow?: number;
  enabled?: boolean;
  auth?: OperatorAiAuth;
}

export interface OperatorUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface OperatorUsageMeta {
  usage?: OperatorUsage;
  model?: string | null;
  provider?: string | null;
  max_tokens?: number;
  // Set when Caracal fell back from its primary AI provider to a secondary one while answering this
  // message - the request still succeeded, but the primary was unavailable for at least one call.
  // Absent on the common path where the primary served the whole turn.
  failover?: boolean;
  // The handling tier the request was triaged into: conversational and read are answered as
  // text, change and compound produce a plan. Surfaced for observability; the web client keys
  // its rendering on intent, so this is additive.
  tier?: "conversational" | "read" | "change" | "compound";
}

export type OperatorMessageRunState =
  | "queued"
  | "sending"
  | "waiting_for_model"
  | "reasoning"
  | "waiting_for_tool"
  | "waiting_for_user_approval"
  | "executing"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed"
  | "timeout";

export interface OperatorMessageRun {
  id: string;
  client_message_id: string;
  correlation_id: string;
  state: OperatorMessageRunState;
  reason: string | null;
  error_code: string | null;
  error_detail: string | null;
  deadline_at: string | null;
  completed_at: string | null;
  last_event_seq: number;
}

// The advisory severity of a single security finding. Advisory only: it informs the human who
// approves the plan and never gates it.
export type OperatorAdvisorySeverity = "info" | "caution" | "warning";

// The guardian's verdict on whether the plan matches how Caracal is meant to be used.
export type OperatorAdvisoryAlignment = "aligned" | "risky" | "misaligned";

export interface OperatorAdvisoryFinding {
  severity: OperatorAdvisorySeverity;
  concern: string;
}

// The advisory security review a composed plan may carry: a plain-language summary, an intent
// alignment verdict, any findings about over-grant, least-privilege, or blast-radius, and - when
// the plan is risky or misaligned - a concrete recommendation of the Caracal-correct approach. It
// is informational only - the plan is governed by validation, preview, and approval, never by this
// review.
export interface OperatorSecurityAdvisory {
  summary: string;
  alignment?: OperatorAdvisoryAlignment;
  findings: OperatorAdvisoryFinding[];
  recommendation?: string;
}

// The deliberation stages a turn passes through, emitted purely as live progress while the Operator
// works. A stage signal carries no authority and changes nothing about the decided outcome; the
// same governed turn produces the same result whether or not anyone is listening.
export type OperatorProgressStage =
  | "triaging"
  | "gathering"
  | "planning"
  | "repairing"
  | "critiquing"
  | "revising"
  | "guarding"
  | "answering";

export type OperatorMessageResult = (
  | {
      intent: "plan";
      ok: true;
      turn: OperatorTurn;
      validation: OperatorPlanValidation;
      preview: { ok: boolean; mutating: boolean; steps: OperatorValidatedStep[] };
      // Present only for a composed (compound) plan; absent for a single change.
      advisory?: OperatorSecurityAdvisory;
      // Whether Caracal-governed autopilot auto-satisfied this plan's approval, and the approval
      // turn it recorded. False with a null turn whenever autopilot did not act.
      auto_approved?: boolean;
      approval_turn?: OperatorTurn | null;
    }
  | { intent: "plan"; ok: false; error: string; turn: OperatorTurn | null }
  | { intent: "explain"; ok: boolean; text: string; reasoning?: string; turn: OperatorTurn | null }
  | { intent: "message_run"; ok: true; duplicate: true; message_run: OperatorMessageRun }
) &
  OperatorUsageMeta & { message_run?: OperatorMessageRun };
