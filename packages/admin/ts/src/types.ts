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

export interface ResourceInput {
  name?: string
  identifier: string
  upstream_url?: string | null
  gateway_application_id?: string | null
  scopes: string[]
  credential_provider_id?: string | null
}

export type ProviderKind = 'oauth2' | 'apikey'

export interface Provider {
  id: string
  zone_id: string
  name: string
  identifier: string
  kind: ProviderKind
  config_json: JsonObject
  created_at: string
  updated_at: string
}

export interface ProviderInput {
  name?: string
  identifier: string
  kind: ProviderKind
  config_json: JsonObject
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
  limit?: number
}

export interface SessionQuery {
  status?: 'active' | 'revoked' | 'expired'
  subject_id?: string
  limit?: number
}

export interface AgentSession {
  agent_session_id: string
  zone_id: string
  application_id: string
  parent_id: string | null
  subject_session_id: string
  status: string
  depth: number
  spawned_at: string
  terminated_at: string | null
}

export interface DelegationEdge {
  id: string
  zone_id: string
  source_session_id: string
  target_session_id: string
  issuer_application_id: string
  receiver_application_id: string
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
