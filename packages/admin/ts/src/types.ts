// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Public type definitions for the Caracal admin SDK.

import type { JsonObject, JsonValue } from '@caracalai/core'

export interface Zone {
  id: string
  org_id: string
  name: string
  slug: string
  dcr_enabled: boolean
  pkce_required: boolean
  login_flow: string
  created_at: string
  updated_at: string
}

export interface ZoneInput {
  org_id?: string
  name: string
  slug?: string
  dcr_enabled?: boolean
  pkce_required?: boolean
  login_flow?: string
}

export type RegistrationMethod = 'managed' | 'dcr'
export type CredentialType = 'token' | 'password' | 'public-key' | 'url' | 'public'

export interface Application {
  id: string
  zone_id: string
  name: string
  registration_method: RegistrationMethod
  credential_type: CredentialType
  traits: string[]
  consent: string
  created_at: string
}

export interface ApplicationInput {
  name: string
  registration_method: RegistrationMethod
  credential_type?: CredentialType
  client_secret?: string
  traits?: string[]
  consent?: boolean
}

export interface DCRInput {
  name: string
  credential_type?: CredentialType
  client_secret?: string
  traits?: string[]
  expires_in?: number
}

export interface Resource {
  id: string
  zone_id: string
  name: string
  identifier: string
  upstream_url: string | null
  prefix: boolean
  scopes: string[]
  credential_provider_id: string | null
  created_at: string
  updated_at: string
}

export interface ResourceInput {
  name?: string
  identifier: string
  upstream_url?: string
  prefix?: boolean
  scopes: string[]
  credential_provider_id?: string
}

export type ProviderKind = 'oauth2' | 'oidc' | 'apikey' | 'workload'

export interface Provider {
  id: string
  zone_id: string
  name: string
  identifier: string
  kind: ProviderKind | null
  owner_type: string
  client_id: string | null
  config_json: JsonObject
  created_at: string
  updated_at: string
}

export interface ProviderInput {
  name?: string
  identifier: string
  kind?: ProviderKind
  owner_type?: string
  client_id?: string
  config_json?: JsonObject
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
  id: string
  zone_id: string
  application_id: string
  parent_id: string | null
  session_sid: string
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
