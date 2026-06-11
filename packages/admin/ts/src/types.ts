// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Public type definitions for the Caracal admin SDK.

import type { JsonObject, JsonValue } from '@caracalai/core'

export interface Zone {
  id: string
  name: string
  slug: string
  dcr_enabled: boolean
  created_at: string
  updated_at: string
}

export interface ZoneInput {
  name: string
  slug?: string
  dcr_enabled?: boolean
}

export type DcrShutdownMode = 'keep_live' | 'revoke_live'

export interface ZonePatchInput extends Partial<ZoneInput> {
  dcr_shutdown?: DcrShutdownMode
}

export interface ZoneDcrStatus {
  id: string
  dcr_enabled: boolean
  live_dcr_applications: number
}

export type RegistrationMethod = 'managed' | 'dcr'

export interface Application {
  id: string
  zone_id: string
  name: string
  registration_method: RegistrationMethod
  traits?: string[]
  expires_at?: string | null
  client_secret?: string
  created_at: string
}

export interface ApplicationInput {
  name: string
  registration_method: 'managed'
  traits?: string[]
}

export interface ApplicationPatchInput {
  name?: string
  client_secret?: string
  traits?: string[]
}

export interface DCRInput {
  name: string
  expires_in?: number
}

export interface Resource {
  id: string
  zone_id: string
  name: string
  identifier: string
  upstream_url: string | null
  gateway_application_id: string | null
  scopes: string[]
  credential_provider_id: string | null
  created_at: string
  updated_at: string
}

export type ResourceIdentifier = string
export type ProviderIdentifier = `provider://${string}`

export interface ResourceInput {
  name?: string
  identifier?: ResourceIdentifier
  upstream_url?: string | null
  gateway_application_id?: string | null
  scopes: string[]
  credential_provider_id?: string | null
}

export type ProviderKind = 'none' | 'caracal_mandate' | 'oauth2_authorization_code' | 'oauth2_client_credentials' | 'api_key' | 'bearer_token'
export type ProviderSecretConfigKey = 'client_secret' | 'private_key' | 'api_key' | 'bearer_token'
export type OAuthClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' | 'none'
export type APIKeyAuthLocation = 'header' | 'query'

export interface ProviderConfigBase {
  forward_caracal_identity?: boolean
  allow_runtime_injection?: boolean
  auth_header?: string
  auth_scheme?: string
}

export type EmptyProviderConfig = Record<string, never>

export interface OAuth2AuthorizationCodeProviderConfig extends ProviderConfigBase {
  authorization_endpoint: string
  token_endpoint: string
  redirect_uri: string
  client_id: string
  client_auth_method?: Exclude<OAuthClientAuthMethod, 'private_key_jwt'>
  client_secret?: string
  scopes?: string[]
  allowed_token_hosts: string[]
  authorization_params?: Record<string, string>
  token_params?: Record<string, string>
}

export interface OAuth2ClientCredentialsProviderConfig extends ProviderConfigBase {
  token_endpoint: string
  client_id: string
  client_auth_method?: OAuthClientAuthMethod
  client_secret?: string
  private_key?: string
  key_id?: string
  scopes?: string[]
  audience?: string
  resource?: string
  allowed_token_hosts: string[]
  token_params?: Record<string, string>
}

export type APIKeyProviderConfig = ProviderConfigBase & (
  | {
      auth_location?: 'header'
      header_name: string
      api_key?: string
    }
  | {
      auth_location: 'query'
      query_param_name: string
      api_key?: string
      auth_scheme?: never
    }
)

export interface BearerTokenProviderConfig extends ProviderConfigBase {
  bearer_token?: string
  allowed_token_hosts?: string[]
}

export type ProviderConfig =
  | EmptyProviderConfig
  | OAuth2AuthorizationCodeProviderConfig
  | OAuth2ClientCredentialsProviderConfig
  | APIKeyProviderConfig
  | BearerTokenProviderConfig

interface ProviderInputBase {
  name?: string
  identifier?: ProviderIdentifier
}

export type ProviderInput =
  | (ProviderInputBase & { kind: 'none'; config_json?: EmptyProviderConfig })
  | (ProviderInputBase & { kind: 'caracal_mandate'; config_json?: EmptyProviderConfig })
  | (ProviderInputBase & { kind: 'oauth2_authorization_code'; config_json: OAuth2AuthorizationCodeProviderConfig })
  | (ProviderInputBase & { kind: 'oauth2_client_credentials'; config_json: OAuth2ClientCredentialsProviderConfig })
  | (ProviderInputBase & { kind: 'api_key'; config_json: APIKeyProviderConfig })
  | (ProviderInputBase & { kind: 'bearer_token'; config_json: BearerTokenProviderConfig })

export interface ProviderPatchInput extends ProviderInputBase {
  kind?: ProviderKind
  config_json?: ProviderConfig
}

export interface Provider {
  id: string
  zone_id: string
  name: string
  identifier: ProviderIdentifier
  kind: ProviderKind
  config_json: ProviderConfig
  secret_config_keys: ProviderSecretConfigKey[]
  created_at: string
  updated_at: string
}

export interface Policy {
  id: string
  zone_id: string
  name: string
  description: string | null
  owner_type: string
  created_by: string
  created_at: string
}

export interface PolicyVersion {
  id: string
  policy_id: string
  version: number
  content_sha256: string
  schema_version: string
  created_at: string
}

export interface PolicyInput {
  name: string
  description?: string
  owner_type?: string
  content: string
  schema_version?: string
}

export interface PolicyTemplate {
  id: string
  name: string
  description: string
  content: string
}

export interface PolicyPreview {
  package: string
  rules: string[]
  default_result: boolean
  decisions: string[]
  inputs_referenced: string[]
  data_referenced: string[]
}

export interface PolicyValidation {
  valid: boolean
  schema_version: string
  input_schema_version: string
  output_contract: {
    package: string
    rule: string
    decision: string[]
    evaluation_status: string[]
  }
  preview: PolicyPreview | null
  warnings: string[]
}

export interface PolicySet {
  id: string
  zone_id: string
  name: string
  description: string | null
  active_version_id: string | null
  created_at: string
}

export interface PolicySetVersion {
  id: string
  policy_set_id: string
  version: number
  manifest_sha256: string
  schema_version: string
  created_at: string
}

export interface PolicySetSimulation {
  dry_run: boolean
  would_activate: boolean
  policy_set_id: string
  version_id: string
  schema_version: string
  input_schema_version: string
  manifest_sha256: string
  policies: string[]
  warnings: string[]
  explanation: {
    evaluation: string
    decision?: string
    policy_set_version_id?: string
    manifest_sha256?: string
    reason: string
  }
  result: {
    decision: 'allow' | 'deny'
    determining_policies: JsonObject[]
    evaluation_status: string
    diagnostics: JsonObject[]
  } | null
}

export interface Grant {
  id: string
  zone_id: string
  application_id: string
  user_id: string
  resource_id: string
  provider_id?: string | null
  application_name?: string | null
  resource_name?: string | null
  provider_name?: string | null
  provider_kind?: ProviderKind | null
  scopes: string[]
  status: string
  created_at: string
}

export interface GrantInput {
  application_id: string
  user_id: string
  resource_id: string
  scopes: string[]
}

export interface GrantQuery {
  application_id?: string
  user_id?: string
  subject_id?: string
  resource_id?: string
  provider_id?: string
  status?: string
  scopes?: string[]
  cursor?: string
  limit?: number
}

export interface ProviderGrantInput {
  user_id: string
  resource_id: string
  provider_id: string
  scopes: string[]
  access_token: string
  refresh_token?: string
  expires_at?: string
}

export interface ProviderGrantOAuthAuthorizeInput {
  user_id: string
  resource_id: string
  provider_id: string
  scopes: string[]
}

export interface ProviderGrantOAuthAuthorize {
  authorization_url: string
  state: string
  expires_at: string
}

export interface ProviderGrantRevokeInput {
  user_id: string
  resource_id: string
  provider_id: string
}

export interface ProviderGrant {
  id: string
  zone_id: string
  user_id: string
  resource_id: string
  provider_id: string
  scopes: string[]
  status: string
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface Session {
  id: string
  zone_id: string
  session_type: string
  subject_id: string
  parent_id: string | null
  status: string
  expires_at: string
  authenticated_at: string
  created_at: string
}

export interface AuditEvent {
  id: string
  zone_id: string
  event_type: string
  request_id: string | null
  decision: string | null
  evaluation_status: string | null
  metadata_json: JsonObject | null
  occurred_at: string
  ingested_at: string
}

export interface AuditDetail extends AuditEvent {
  policy_set_id: string | null
  policy_set_version_id: string | null
  manifest_sha: string | null
  determining_policies_json: JsonValue[] | null
  diagnostics_json: JsonValue[] | null
}

export interface DeniedDecisionEvent {
  event_id: string
  event_type: string
  evaluation_status: string | null
  determining_policies: JsonValue[]
  diagnostics: JsonValue[]
  metadata: JsonObject
  policy_input: JsonObject
}

export interface DecisionTrace {
  request_id: string
  zone_id: string
  final_decision: string
  denied: DeniedDecisionEvent[]
  events: AuditDetail[]
}

export interface AuditQuery {
  since?: string
  until?: string
  request_id?: string
  decision?: 'allow' | 'deny' | 'partial'
  event_type?: string
  agent_session_id?: string
  label?: string
  limit?: number
}

export interface SessionQuery {
  status?: 'active' | 'revoked' | 'expired'
  subject_id?: string
  limit?: number
}

export interface AgentSessionRow {
  id: string
  application_id: string
  parent_id: string | null
  status: string
  lifecycle: string
  labels: string[]
  depth: number
  child_count: number
  spawned_at: string
  last_active_at: string
  terminated_at: string | null
  ttl_seconds: number | null
}

export interface AgentSessionQuery {
  status?: 'active' | 'suspended' | 'terminated' | 'expired'
  lifecycle?: 'task' | 'service'
  application_id?: string
  parent_id?: string
  label?: string
  cursor?: string
  limit?: number
}

export interface AgentListQuery {
  status?: 'active' | 'suspended' | 'terminated'
  lifecycle?: 'task' | 'service'
  application_id?: string
  label?: string
  cursor?: string
  limit?: number
}

export interface StepUpChallenge {
  id: string
  zone_id: string
  session_id: string
  challenge_type: string
  metadata_json: JsonObject
  created_at: string
  expires_at: string
  satisfied_at: string | null
  approver_subject_id: string | null
}

export interface StepUpChallengeSatisfaction {
  id: string
  satisfied_at: string
  approver_subject_id: string
}

export interface AgentSession {
  agent_session_id: string
  zone_id: string
  application_id: string
  parent_id: string | null
  subject_session_id: string
  lifecycle: string
  labels: string[]
  status: string
  depth: number
  ttl_seconds: number | null
  metadata: Record<string, unknown> | null
  spawned_at: string
  terminated_at?: string | null
  last_heartbeat_at?: string | null
  heartbeat_deadline_at?: string | null
}

export interface DelegationEdge {
  id: string
  zone_id: string
  source_session_id: string
  target_session_id: string
  issuer_application_id: string
  receiver_application_id: string
  parent_edge_id: string | null
  resource_id: string | null
  scopes: string[]
  constraints_json: JsonObject
  status: string
  expires_at: string
  edge_version: number
  revoked_at: string | null
  created_at: string
}

export interface TraverseNode {
  id: string
  source_session_id: string
  target_session_id: string
  depth: number
}

export interface DelegationImpact {
  edge_id: string
  affected_edges: TraverseNode[]
  affected_agents: string[]
  affected_subject_sessions: string[]
}

export interface EffectiveAuthority {
  agent_session_id: string
  inbound_edges: string[]
  effective_scopes: string[]
  effective_resource_ids?: string[]
  effective_resources: string[]
  effective_resource_constrained?: boolean
  effective_max_hops: number | null
  effective_ttl_seconds: number | null
  earliest_expires_at: string | null
}
