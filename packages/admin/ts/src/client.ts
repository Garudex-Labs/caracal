// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient: typed wrapper over the Caracal admin API and agent coordinator.

import { AdminApiError } from './errors.js'
import type { JsonValue } from '@caracalai/core'
import type {
  AgentSession,
  Application,
  ApplicationInput,
  AuditDetail,
  AuditEvent,
  AuditQuery,
  DCRInput,
  DelegationEdge,
  DelegationImpact,
  Grant,
  GrantInput,
  Policy,
  PolicyInput,
  PolicySet,
  PolicySetVersion,
  PolicyTemplate,
  PolicyVersion,
  Provider,
  ProviderInput,
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
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
}

interface RequestOptions {
  method?: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  base?: 'api' | 'coordinator'
  expectEmpty?: boolean
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3
const MAX_RETRY_AFTER_MS = 30_000

function jitterBackoff(attempt: number): number {
  const base = Math.min(2 ** attempt * 250, 5_000)
  return base / 2 + Math.random() * (base / 2)
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)
}

function canRetryMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after')
  if (!h) return undefined
  const secs = Number(h)
  if (Number.isFinite(secs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, secs * 1000))
  const date = Date.parse(h)
  if (!Number.isNaN(date)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()))
  return undefined
}

export class AdminClient {
  private readonly apiUrl: string
  private readonly coordinatorUrl: string | undefined
  private readonly adminToken: string
  private readonly coordinatorToken: string | undefined
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly callerSignal: AbortSignal | undefined

  constructor(opts: AdminClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, '')
    this.coordinatorUrl = opts.coordinatorUrl?.replace(/\/$/, '')
    this.adminToken = opts.adminToken
    this.coordinatorToken = opts.coordinatorToken
    this.doFetch = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = opts.retries ?? DEFAULT_RETRIES
    this.callerSignal = opts.signal
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
    const method = opts.method ?? 'GET'
    const retries = canRetryMethod(method) ? this.retries : 0

    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('admin_request_timeout')), this.timeoutMs)
      const onAbort = () => controller.abort((opts.signal ?? this.callerSignal)?.reason)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.callerSignal?.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await this.doFetch(url, { method, headers, body, signal: controller.signal })
        if (!res.ok) {
          if (attempt < retries && shouldRetry(res.status)) {
            const wait = retryAfterMs(res) ?? jitterBackoff(attempt)
            await new Promise(r => setTimeout(r, wait))
            continue
          }
          const text = await res.text()
          let parsed: JsonValue = text
          let code = res.statusText || 'request_failed'
          try {
            parsed = text ? JSON.parse(text) : {}
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed && typeof parsed.error === 'string') {
              code = (parsed as { error: string }).error
            }
          } catch { /* keep raw text */ }
          throw new AdminApiError(res.status, code, parsed)
        }
        if (opts.expectEmpty || res.status === 204) return undefined as T
        return await res.json() as T
      } catch (err) {
        lastErr = err
        if (err instanceof AdminApiError) throw err
        if ((opts.signal ?? this.callerSignal)?.aborted) throw err
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, jitterBackoff(attempt)))
          continue
        }
        throw err
      } finally {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        this.callerSignal?.removeEventListener('abort', onAbort)
      }
    }
    throw lastErr ?? new Error('admin_request_exhausted')
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

  policyTemplates = {
    list: () => this.request<PolicyTemplate[]>('/v1/policy-templates'),
    get: async (id: string) => {
      const templates = await this.request<PolicyTemplate[]>('/v1/policy-templates')
      const template = templates.find((item) => item.id === id)
      if (!template) throw new AdminApiError(404, 'policy_template_not_found', { error: 'policy_template_not_found', id })
      return template
    },
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
    active: (zoneId: string) =>
      this.request<{ items: DelegationEdge[]; next_cursor: string | null }>(`/zones/${zoneId}/delegations/active`, { base: 'coordinator' }),
    inbound: (zoneId: string, sessionId: string) =>
      this.request<DelegationEdge[]>(`/zones/${zoneId}/delegations/inbound/${sessionId}`, { base: 'coordinator' }),
    outbound: (zoneId: string, sessionId: string) =>
      this.request<DelegationEdge[]>(`/zones/${zoneId}/delegations/outbound/${sessionId}`, { base: 'coordinator' }),
    traverse: (zoneId: string, id: string) =>
      this.request<TraverseNode[]>(`/zones/${zoneId}/delegations/${id}/traverse`, { base: 'coordinator' }),
    impact: (zoneId: string, id: string) =>
      this.request<DelegationImpact>(`/zones/${zoneId}/delegations/${id}/impact`, { base: 'coordinator' }),
    revoke: (zoneId: string, id: string) =>
      this.request<{ revoked_edges: number; affected_sessions: number }>(
        `/zones/${zoneId}/delegations/${id}/revoke`,
        { method: 'PATCH', base: 'coordinator' },
      ),
  }
}
