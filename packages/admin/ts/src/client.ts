// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient: typed wrapper over the Caracal admin API and agent coordinator.

import { AdminApiError } from './errors.js'
import type {
  AgentSession,
  Application,
  ApplicationInput,
  AuditDetail,
  AuditEvent,
  AuditQuery,
  DCRInput,
  DelegationEdge,
  Grant,
  GrantInput,
  Policy,
  PolicyInput,
  PolicySet,
  PolicySetVersion,
  PolicyVersion,
  Provider,
  ProviderInput,
  LocalBootstrapResult,
  Resource,
  ResourceInput,
  Session,
  SessionQuery,
  TraverseNode,
  Zone,
  ZoneInput,
} from './types.js'

export interface AdminClientOptions {
  apiUrl: string
  coordinatorUrl?: string
  adminToken: string
  coordinatorToken?: string
  fetchImpl?: typeof fetch
}

interface RequestOptions {
  method?: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  base?: 'api' | 'coordinator'
  expectEmpty?: boolean
}

export class AdminClient {
  private readonly apiUrl: string
  private readonly coordinatorUrl: string | undefined
  private readonly adminToken: string
  private readonly coordinatorToken: string | undefined
  private readonly doFetch: typeof fetch

  constructor(opts: AdminClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, '')
    this.coordinatorUrl = opts.coordinatorUrl?.replace(/\/$/, '')
    this.adminToken = opts.adminToken
    this.coordinatorToken = opts.coordinatorToken
    this.doFetch = opts.fetchImpl ?? fetch
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const base = opts.base === 'coordinator' ? this.coordinatorUrl : this.apiUrl
    if (!base) throw new Error('coordinator_url_not_configured')
    const token = opts.base === 'coordinator' ? this.coordinatorToken : this.adminToken
    if (!token) throw new Error('coordinator_token_not_configured')

    const qs = opts.query
      ? '?' + Object.entries(opts.query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : ''
    const url = `${base}${path}${qs}`
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    let body: BodyInit | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    const res = await this.doFetch(url, { method: opts.method ?? 'GET', headers, body })
    if (!res.ok) {
      const text = await res.text()
      let parsed: unknown = text
      let code = res.statusText || 'request_failed'
      try {
        parsed = text ? JSON.parse(text) : {}
        if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string') {
          code = (parsed as { error: string }).error
        }
      } catch { /* keep raw text */ }
      throw new AdminApiError(res.status, code, parsed)
    }
    if (opts.expectEmpty || res.status === 204) return undefined as T
    return await res.json() as T
  }

  // Local bootstrap (development/self-hosted)
  bootstrap(force = false): Promise<LocalBootstrapResult> {
    return this.request<LocalBootstrapResult>('/v1/local/bootstrap', { method: 'POST', body: { force } })
  }

  // Zones
  zones = {
    list: () => this.request<Zone[]>('/v1/zones'),
    get: (id: string) => this.request<Zone>(`/v1/zones/${id}`),
    create: (input: ZoneInput) => this.request<Zone>('/v1/zones', { method: 'POST', body: input }),
    patch: (id: string, input: Partial<ZoneInput>) =>
      this.request<Zone>(`/v1/zones/${id}`, { method: 'PATCH', body: input }),
    delete: (id: string) => this.request<void>(`/v1/zones/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Applications
  applications = {
    list: (zoneId: string) => this.request<Application[]>(`/v1/zones/${zoneId}/applications`),
    get: (zoneId: string, id: string) => this.request<Application>(`/v1/zones/${zoneId}/applications/${id}`),
    create: (zoneId: string, input: ApplicationInput) =>
      this.request<Application>(`/v1/zones/${zoneId}/applications`, { method: 'POST', body: input }),
    patch: (zoneId: string, id: string, input: Partial<ApplicationInput>) =>
      this.request<Application>(`/v1/zones/${zoneId}/applications/${id}`, { method: 'PATCH', body: input }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/applications/${id}`, { method: 'DELETE', expectEmpty: true }),
    dcr: (zoneId: string, input: DCRInput) =>
      this.request<Application>(`/v1/zones/${zoneId}/applications/dcr`, { method: 'POST', body: input }),
  }

  // Resources
  resources = {
    list: (zoneId: string) => this.request<Resource[]>(`/v1/zones/${zoneId}/resources`),
    get: (zoneId: string, id: string) => this.request<Resource>(`/v1/zones/${zoneId}/resources/${id}`),
    create: (zoneId: string, input: ResourceInput) =>
      this.request<Resource>(`/v1/zones/${zoneId}/resources`, { method: 'POST', body: input }),
    patch: (zoneId: string, id: string, input: Partial<ResourceInput>) =>
      this.request<Resource>(`/v1/zones/${zoneId}/resources/${id}`, { method: 'PATCH', body: input }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/resources/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Providers
  providers = {
    list: (zoneId: string) => this.request<Provider[]>(`/v1/zones/${zoneId}/providers`),
    get: (zoneId: string, id: string) => this.request<Provider>(`/v1/zones/${zoneId}/providers/${id}`),
    create: (zoneId: string, input: ProviderInput) =>
      this.request<Provider>(`/v1/zones/${zoneId}/providers`, { method: 'POST', body: input }),
    patch: (zoneId: string, id: string, input: Partial<ProviderInput>) =>
      this.request<Provider>(`/v1/zones/${zoneId}/providers/${id}`, { method: 'PATCH', body: input }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/providers/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Policies (immutable Rego versions)
  policies = {
    list: (zoneId: string) => this.request<Policy[]>(`/v1/zones/${zoneId}/policies`),
    get: (zoneId: string, id: string) =>
      this.request<Policy & { versions: PolicyVersion[] }>(`/v1/zones/${zoneId}/policies/${id}`),
    create: (zoneId: string, input: PolicyInput) =>
      this.request<Policy & { version: PolicyVersion }>(`/v1/zones/${zoneId}/policies`, { method: 'POST', body: input }),
    addVersion: (zoneId: string, id: string, content: string, schemaVersion?: string) =>
      this.request<PolicyVersion>(`/v1/zones/${zoneId}/policies/${id}/versions`, {
        method: 'POST',
        body: { content, schema_version: schemaVersion ?? '2026-03-16' },
      }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/policies/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Policy sets
  policySets = {
    list: (zoneId: string) => this.request<PolicySet[]>(`/v1/zones/${zoneId}/policy-sets`),
    get: (zoneId: string, id: string) => this.request<PolicySet>(`/v1/zones/${zoneId}/policy-sets/${id}`),
    create: (zoneId: string, name: string, description?: string) =>
      this.request<PolicySet>(`/v1/zones/${zoneId}/policy-sets`, {
        method: 'POST',
        body: { name, description },
      }),
    addVersion: (zoneId: string, id: string, manifest: { policy_version_id: string }[]) =>
      this.request<PolicySetVersion>(`/v1/zones/${zoneId}/policy-sets/${id}/versions`, {
        method: 'POST',
        body: { manifest },
      }),
    activate: (zoneId: string, id: string, versionId: string, shadowVersionId?: string) =>
      this.request<{ activated: boolean; version_id: string; shadow_version_id: string | null }>(
        `/v1/zones/${zoneId}/policy-sets/${id}/activate`,
        { method: 'POST', body: { version_id: versionId, shadow_version_id: shadowVersionId } },
      ),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/policy-sets/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Grants
  grants = {
    list: (zoneId: string) => this.request<Grant[]>(`/v1/zones/${zoneId}/grants`),
    get: (zoneId: string, id: string) => this.request<Grant>(`/v1/zones/${zoneId}/grants/${id}`),
    create: (zoneId: string, input: GrantInput) =>
      this.request<Grant>(`/v1/zones/${zoneId}/grants`, { method: 'POST', body: input }),
    revoke: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/grants/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Sessions (read; revocation is a side effect of grant.revoke or agent.terminate)
  sessions = {
    list: (zoneId: string, query?: SessionQuery) =>
      this.request<Session[]>(`/v1/zones/${zoneId}/sessions`, { query: { ...query } }),
  }

  // Audit
  audit = {
    list: (zoneId: string, query?: AuditQuery) =>
      this.request<AuditEvent[]>(`/v1/zones/${zoneId}/audit`, { query: { ...query } }),
    byRequest: (zoneId: string, requestId: string) =>
      this.request<AuditDetail[]>(`/v1/zones/${zoneId}/audit/by-request/${requestId}`),
  }

  // Agents (coordinator)
  agents = {
    list: (zoneId: string) =>
      this.request<AgentSession[]>(`/zones/${zoneId}/agents`, { base: 'coordinator' }),
    get: (zoneId: string, id: string) =>
      this.request<AgentSession>(`/zones/${zoneId}/agents/${id}`, { base: 'coordinator' }),
    children: (zoneId: string, id: string) =>
      this.request<AgentSession[]>(`/zones/${zoneId}/agents/${id}/children`, { base: 'coordinator' }),
    suspend: (zoneId: string, id: string) =>
      this.request<{ suspended: true }>(`/zones/${zoneId}/agents/${id}/suspend`, { method: 'PATCH', base: 'coordinator' }),
    resume: (zoneId: string, id: string) =>
      this.request<{ resumed: true }>(`/zones/${zoneId}/agents/${id}/resume`, { method: 'PATCH', base: 'coordinator' }),
    terminate: (zoneId: string, id: string) =>
      this.request<void>(`/zones/${zoneId}/agents/${id}`, { method: 'DELETE', base: 'coordinator', expectEmpty: true }),
  }

  // Delegations (coordinator)
  delegations = {
    inbound: (zoneId: string, sessionId: string) =>
      this.request<DelegationEdge[]>(`/zones/${zoneId}/delegations/inbound/${sessionId}`, { base: 'coordinator' }),
    outbound: (zoneId: string, sessionId: string) =>
      this.request<DelegationEdge[]>(`/zones/${zoneId}/delegations/outbound/${sessionId}`, { base: 'coordinator' }),
    traverse: (zoneId: string, id: string) =>
      this.request<TraverseNode[]>(`/zones/${zoneId}/delegations/${id}/traverse`, { base: 'coordinator' }),
    revoke: (zoneId: string, id: string) =>
      this.request<{ revoked_edges: number; affected_sessions: number }>(
        `/zones/${zoneId}/delegations/${id}/revoke`,
        { method: 'PATCH', base: 'coordinator' },
      ),
  }
}
