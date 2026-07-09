// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient: typed wrapper over the Caracal admin API and agent coordinator.

import { AdminApiError } from './errors.js'
import type { JsonValue } from '@caracalai/core'
import type {
  AgentListQuery,
  AgentSession,
  Application,
  ApplicationInput,
  ApplicationPatchInput,
  AdminAuditEvent,
  AdminAuditQuery,
  AuditDetail,
  AuditEvent,
  AuditQuery,
  DCRInput,
  DecisionTrace,
  DelegationEdge,
  DelegationImpact,
  EffectiveAuthority,
  Grant,
  GrantInput,
  GrantQuery,
  SubjectIssuer,
  SubjectIssuerInput,
  SubjectIssuerPatch,
  Policy,
  PolicyInput,
  PolicySet,
  PolicySetActivationStatus,
  PolicySetSimulation,
  PolicySetVersion,
  PolicyTemplate,
  PolicyValidation,
  PolicyVersion,
  Provider,
  ProviderConnection,
  ProviderConnectionAuthorize,
  ProviderConnectionAuthorizeInput,
  ProviderConnectionInput,
  ProviderConnectionRevokeInput,
  ProviderInput,
  ProviderPatchInput,
  Resource,
  ResourceInput,
  Session,
  SessionQuery,
  SubjectRevokeInput,
  SubjectRevokeResult,
  AgentSessionRow,
  AgentSessionQuery,
  StepUpChallenge,
  StepUpDecision,
  TraverseNode,
  Workload,
  WorkloadUpdateInput,
  Zone,
  ZoneDcrStatus,
  ZoneInput,
  ZonePatchInput,
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
  // Default headers sent on every request, merged under per-call headers. Used to carry request-
  // scoped attribution (the human a call acts for) on the control plane's in-process admin hop.
  headers?: Record<string, string>
}

interface RequestOptions {
  method?: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  base?: 'api' | 'coordinator'
  expectEmpty?: boolean
  signal?: AbortSignal
  headers?: Record<string, string>
}

interface ListResponse<T> {
  items: T[]
  next_cursor: string | null
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3
const MAX_RETRY_AFTER_MS = 30_000
const MAX_LIST_PAGES = 50

function grantListQuery(query?: GrantQuery): Record<string, string | number | undefined> | undefined {
  if (!query) return undefined
  const { scopes, subject_id, user_id, ...rest } = query
  return {
    ...rest,
    user_id: user_id ?? subject_id,
    scopes: scopes?.join(','),
  }
}

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
  private readonly defaultHeaders: Record<string, string> | undefined

  constructor(opts: AdminClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, '')
    this.coordinatorUrl = opts.coordinatorUrl?.replace(/\/$/, '')
    this.adminToken = opts.adminToken
    this.coordinatorToken = opts.coordinatorToken
    this.doFetch = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = opts.retries ?? DEFAULT_RETRIES
    this.callerSignal = opts.signal
    this.defaultHeaders = opts.headers
  }

  // Derives a client that shares this one's configuration but sends the given headers on every
  // request, merged under any existing default headers. Used to attach request-scoped attribution
  // to the control plane's in-process admin hop without mutating the shared client.
  withDefaultHeaders(headers: Record<string, string>): AdminClient {
    return new AdminClient({
      apiUrl: this.apiUrl,
      coordinatorUrl: this.coordinatorUrl,
      adminToken: this.adminToken,
      coordinatorToken: this.coordinatorToken,
      fetchImpl: this.doFetch,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      signal: this.callerSignal,
      headers: { ...this.defaultHeaders, ...headers },
    })
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const base = opts.base === 'coordinator' ? this.coordinatorUrl : this.apiUrl
    if (!base) throw new Error('coordinator_url_not_configured')
    const token = opts.base === 'coordinator' ? this.coordinatorToken : this.adminToken
    if (!token) throw new Error('coordinator_token_not_configured')

    const pairs = opts.query
      ? Object.entries(opts.query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      : []
    const qs = pairs.length ? '?' + pairs.join('&') : ''
    const url = `${base}${path}${qs}`
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...this.defaultHeaders, ...opts.headers }
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
            await new Promise((r) => setTimeout(r, wait))
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
          } catch {
            /* keep raw text */
          }
          throw new AdminApiError(res.status, code, parsed, undefined, opts.base ?? 'api')
        }
        if (opts.expectEmpty || res.status === 204) return undefined as T
        return (await res.json()) as T
      } catch (err) {
        lastErr = err
        if (err instanceof AdminApiError) throw err
        if ((opts.signal ?? this.callerSignal)?.aborted) throw err
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, jitterBackoff(attempt)))
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

  // Drains a keyset-paginated collection by following next_cursor until exhausted, so a
  // list is the complete collection rather than a silently truncated first page. The page
  // cap bounds the walk against a server bug that never terminates the cursor chain.
  private async listAll<T>(path: string, label: string, query?: Record<string, string | number | undefined>): Promise<T[]> {
    const items: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await this.request<ListResponse<T>>(path, { query: { ...query, cursor } })
      if (!Array.isArray(response.items)) throw new Error(`${label} response missing items`)
      items.push(...response.items)
      if (!response.next_cursor) return items
      cursor = response.next_cursor
    }
    throw new Error(`${label} pagination did not terminate`)
  }

  // Zones
  zones = {
    list: () => this.listAll<Zone>('/v1/zones', 'zones'),
    get: (id: string) => this.request<Zone>(`/v1/zones/${id}`),
    dcrStatus: (id: string) => this.request<ZoneDcrStatus>(`/v1/zones/${id}/dcr-status`),
    create: (input: ZoneInput) => this.request<Zone>('/v1/zones', { method: 'POST', body: input }),
    patch: (id: string, input: ZonePatchInput) => this.request<Zone>(`/v1/zones/${id}`, { method: 'PATCH', body: input }),
    delete: (id: string) => this.request<void>(`/v1/zones/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Applications
  applications = {
    list: (zoneId: string) => this.listAll<Application>(`/v1/zones/${zoneId}/applications`, 'applications'),
    get: (zoneId: string, id: string) => this.request<Application>(`/v1/zones/${zoneId}/applications/${id}`),
    create: (zoneId: string, input: ApplicationInput) =>
      this.request<Application>(`/v1/zones/${zoneId}/applications`, { method: 'POST', body: input }),
    patch: (zoneId: string, id: string, input: ApplicationPatchInput) =>
      this.request<Application>(`/v1/zones/${zoneId}/applications/${id}`, { method: 'PATCH', body: input }),
    // Rotates the credential server-side; the response carries the plaintext secret and
    // the sealed custody copy in the Secret Store is replaced with it.
    rotateSecret: (zoneId: string, id: string) =>
      this.request<Application>(`/v1/zones/${zoneId}/applications/${id}/rotate-secret`, { method: 'POST' }),
    // Retrieves the client secret from Secret Store custody. Every call is recorded
    // in the zone audit timeline as a credential reveal.
    getClientSecret: (zoneId: string, id: string) =>
      this.request<{ client_secret: string }>(`/v1/zones/${zoneId}/applications/${id}/client-secret`),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/applications/${id}`, { method: 'DELETE', expectEmpty: true }),
    // DCR (Dynamic Client Registration) is the sole programmatic path for minting
    // short-lived self-registering client identities. Caracal does not create DCR
    // applications on your behalf. Creation requires an admin token, the zone's dcr_enabled gate,
    // and is rate-limited, capped per zone, and auto-expiring (<=1h). The client
    // secret is returned once and never retrievable again.
    dcr: (zoneId: string, input: DCRInput) =>
      this.request<Application>(`/v1/zones/${zoneId}/applications/dcr`, { method: 'POST', body: input }),
  }

  // Resources
  resources = {
    list: (zoneId: string) => this.listAll<Resource>(`/v1/zones/${zoneId}/resources`, 'resources'),
    get: (zoneId: string, id: string) => this.request<Resource>(`/v1/zones/${zoneId}/resources/${id}`),
    create: (zoneId: string, input: ResourceInput) =>
      this.request<Resource>(`/v1/zones/${zoneId}/resources`, {
        method: 'POST',
        body: input,
      }),
    patch: (zoneId: string, id: string, input: Partial<ResourceInput>) =>
      this.request<Resource>(`/v1/zones/${zoneId}/resources/${id}`, {
        method: 'PATCH',
        body: input,
      }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/resources/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Providers
  providers = {
    list: (zoneId: string) => this.listAll<Provider>(`/v1/zones/${zoneId}/providers`, 'providers'),
    get: (zoneId: string, id: string) => this.request<Provider>(`/v1/zones/${zoneId}/providers/${id}`),
    create: (zoneId: string, input: ProviderInput) =>
      this.request<Provider>(`/v1/zones/${zoneId}/providers`, { method: 'POST', body: input }),
    patch: (zoneId: string, id: string, input: ProviderPatchInput) =>
      this.request<Provider>(`/v1/zones/${zoneId}/providers/${id}`, { method: 'PATCH', body: input }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/providers/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Policies (immutable Rego versions)
  policies = {
    list: (zoneId: string) => this.listAll<Policy>(`/v1/zones/${zoneId}/policies`, 'policies'),
    get: (zoneId: string, id: string) => this.request<Policy & { versions: PolicyVersion[] }>(`/v1/zones/${zoneId}/policies/${id}`),
    create: (zoneId: string, input: PolicyInput) =>
      this.request<Policy & { version_id: string; version: PolicyVersion }>(`/v1/zones/${zoneId}/policies`, {
        method: 'POST',
        body: input,
      }),
    validate: (content: string) =>
      this.request<PolicyValidation>('/v1/policies/validate', {
        method: 'POST',
        body: { content },
      }),
    addVersion: (zoneId: string, id: string, content: string) =>
      this.request<PolicyVersion & { version_id: string }>(`/v1/zones/${zoneId}/policies/${id}/versions`, {
        method: 'POST',
        body: { content },
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
    list: (zoneId: string) => this.listAll<PolicySet>(`/v1/zones/${zoneId}/policy-sets`, 'policy sets'),
    get: (zoneId: string, id: string) => this.request<PolicySet>(`/v1/zones/${zoneId}/policy-sets/${id}`),
    create: (zoneId: string, name: string, description?: string) =>
      this.request<PolicySet>(`/v1/zones/${zoneId}/policy-sets`, {
        method: 'POST',
        body: { name, description },
      }),
    addVersion: (zoneId: string, id: string, manifest: { policy_version_id: string }[]) =>
      this.request<PolicySetVersion & { version_id: string }>(`/v1/zones/${zoneId}/policy-sets/${id}/versions`, {
        method: 'POST',
        body: { manifest },
      }),
    listVersions: (zoneId: string, id: string) =>
      this.listAll<PolicySetVersion>(`/v1/zones/${zoneId}/policy-sets/${id}/versions`, 'policy set versions'),
    simulate: (zoneId: string, id: string, versionId: string, input?: Record<string, unknown>) =>
      this.request<PolicySetSimulation>(`/v1/zones/${zoneId}/policy-sets/${id}/simulate`, {
        method: 'POST',
        body: { version_id: versionId, input },
      }),
    activate: (zoneId: string, id: string, versionId: string) =>
      this.request<{ activated: boolean; version_id: string; outbox_id: string; status_url: string }>(
        `/v1/zones/${zoneId}/policy-sets/${id}/activate`,
        { method: 'POST', body: { version_id: versionId } },
      ),
    activationStatus: (zoneId: string, id: string, versionId?: string, outboxId?: string) =>
      this.request<PolicySetActivationStatus>(`/v1/zones/${zoneId}/policy-sets/${id}/activation-status`, {
        query: {
          ...(versionId ? { version_id: versionId } : {}),
          ...(outboxId ? { outbox_id: outboxId } : {}),
        },
      }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/policy-sets/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Grants
  grants = {
    list: (zoneId: string, query?: GrantQuery) => this.listAll<Grant>(`/v1/zones/${zoneId}/grants`, 'grants', grantListQuery(query)),
    get: (zoneId: string, id: string) => this.request<Grant>(`/v1/zones/${zoneId}/grants/${id}`),
    create: (zoneId: string, input: GrantInput) => this.request<Grant>(`/v1/zones/${zoneId}/grants`, { method: 'POST', body: input }),
    revoke: (zoneId: string, id: string) => this.request<void>(`/v1/zones/${zoneId}/grants/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  subjectIssuers = {
    list: (zoneId: string) => this.listAll<SubjectIssuer>(`/v1/zones/${zoneId}/subject-issuers`, 'subject issuers'),
    get: (zoneId: string, id: string) => this.request<SubjectIssuer>(`/v1/zones/${zoneId}/subject-issuers/${id}`),
    create: (zoneId: string, input: SubjectIssuerInput) =>
      this.request<SubjectIssuer>(`/v1/zones/${zoneId}/subject-issuers`, { method: 'POST', body: input }),
    patch: (zoneId: string, id: string, input: SubjectIssuerPatch) =>
      this.request<SubjectIssuer>(`/v1/zones/${zoneId}/subject-issuers/${id}`, { method: 'PATCH', body: input }),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/subject-issuers/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  providerConnections = {
    create: (zoneId: string, input: ProviderConnectionInput) =>
      this.request<ProviderConnection>(`/v1/zones/${zoneId}/provider-connections`, { method: 'POST', body: input }),
    authorizeOAuth: (zoneId: string, input: ProviderConnectionAuthorizeInput) =>
      this.request<ProviderConnectionAuthorize>(`/v1/zones/${zoneId}/provider-connections/oauth/authorize`, {
        method: 'POST',
        body: input,
      }),
    revoke: (zoneId: string, input: ProviderConnectionRevokeInput) =>
      this.request<ProviderConnection>(`/v1/zones/${zoneId}/provider-connections/revoke`, { method: 'POST', body: input }),
  }

  // Workloads (launcher identities and their credential bindings for caracal run)
  workloads = {
    list: (zoneId: string) => this.listAll<Workload>(`/v1/zones/${zoneId}/workloads`, 'workloads'),
    get: (zoneId: string, id: string) => this.request<Workload>(`/v1/zones/${zoneId}/workloads/${id}`),
    // The response carries the plaintext workload secret; a sealed custody copy stays
    // retrievable through getSecret.
    create: (zoneId: string, input: { name: string }) =>
      this.request<Workload & { secret: string }>(`/v1/zones/${zoneId}/workloads`, { method: 'POST', body: input }),
    update: (zoneId: string, id: string, input: WorkloadUpdateInput) =>
      this.request<Workload>(`/v1/zones/${zoneId}/workloads/${id}`, { method: 'PUT', body: input }),
    // Rotates the credential server-side; the response carries the plaintext secret and
    // the sealed custody copy in the Secret Store is replaced with it.
    rotateSecret: (zoneId: string, id: string) =>
      this.request<Workload & { secret: string }>(`/v1/zones/${zoneId}/workloads/${id}/rotate-secret`, { method: 'POST' }),
    // Retrieves the workload secret from Secret Store custody. Every call is recorded
    // in the zone audit timeline as a credential reveal.
    getSecret: (zoneId: string, id: string) => this.request<{ secret: string }>(`/v1/zones/${zoneId}/workloads/${id}/secret`),
    delete: (zoneId: string, id: string) =>
      this.request<void>(`/v1/zones/${zoneId}/workloads/${id}`, { method: 'DELETE', expectEmpty: true }),
  }

  // Sessions (read; revocation is a side effect of grant.revoke or agent.terminate)
  sessions = {
    list: async (zoneId: string, query?: SessionQuery) => {
      const response = await this.request<ListResponse<Session>>(`/v1/zones/${zoneId}/sessions`, { query: { ...query } })
      if (!Array.isArray(response.items)) throw new Error('sessions response missing items')
      return response.items
    },
  }

  // Subjects: the kill switch. One call cuts every authority path a subject
  // holds - session records, governed sessions riding them, delegations, and
  // provider connections - and feeds the revocation stream so in-flight
  // mandates die before their exp. Idempotent.
  subjects = {
    revoke: (zoneId: string, input: SubjectRevokeInput) =>
      this.request<SubjectRevokeResult>(`/v1/zones/${zoneId}/subjects/revoke`, { method: 'POST', body: input }),
  }

  // Agent sessions (read; status filtering for active/suspended/terminated). CSV export is
  // available directly from the API endpoint with format=csv.
  agentSessions = {
    list: async (zoneId: string, query?: AgentSessionQuery) => {
      const response = await this.request<ListResponse<AgentSessionRow>>(`/v1/zones/${zoneId}/agent-sessions`, { query: { ...query } })
      if (!Array.isArray(response.items)) throw new Error('agent-sessions response missing items')
      return response.items
    },
  }

  // Audit
  audit = {
    list: async (zoneId: string, query?: AuditQuery) => {
      const response = await this.request<ListResponse<AuditEvent>>(`/v1/zones/${zoneId}/audit`, { query: { ...query } })
      if (!Array.isArray(response.items)) throw new Error('audit response missing items')
      return response.items
    },
    byRequest: (zoneId: string, requestId: string) => this.request<AuditDetail[]>(`/v1/zones/${zoneId}/audit/by-request/${requestId}`),
    explain: (zoneId: string, requestId: string) =>
      this.request<DecisionTrace>(`/v1/zones/${zoneId}/audit/by-request/${requestId}/explain`),
  }

  adminAudit = {
    list: async (zoneId: string, query?: AdminAuditQuery) => {
      const response = await this.request<ListResponse<AdminAuditEvent>>(`/v1/zones/${zoneId}/admin-audit`, { query: { ...query } })
      if (!Array.isArray(response.items)) throw new Error('admin audit response missing items')
      return response.items
    },
  }

  stepUpChallenges = {
    list: (zoneId: string) => this.listAll<StepUpChallenge>(`/v1/zones/${zoneId}/step-up-challenges`, 'step-up challenges'),
    get: (zoneId: string, id: string) => this.request<StepUpChallenge>(`/v1/zones/${zoneId}/step-up-challenges/${id}`),
    approve: (zoneId: string, id: string, reason?: string) =>
      this.request<StepUpDecision>(`/v1/zones/${zoneId}/step-up-challenges/${id}/approve`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    reject: (zoneId: string, id: string, reason?: string) =>
      this.request<StepUpDecision>(`/v1/zones/${zoneId}/step-up-challenges/${id}/reject`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
  }

  // Agents (coordinator)
  agents = {
    list: async (zoneId: string, query?: AgentListQuery) => {
      const response = await this.request<ListResponse<AgentSession>>(`/zones/${zoneId}/agents`, {
        base: 'coordinator',
        query: { ...query },
      })
      if (!Array.isArray(response.items)) throw new Error('agents response missing items')
      return response.items
    },
    get: (zoneId: string, id: string) => this.request<AgentSession>(`/zones/${zoneId}/agents/${id}`, { base: 'coordinator' }),
    children: async (zoneId: string, id: string, query?: AgentListQuery) => {
      const response = await this.request<ListResponse<AgentSession>>(`/zones/${zoneId}/agents/${id}/children`, {
        base: 'coordinator',
        query: { ...query },
      })
      if (!Array.isArray(response.items)) throw new Error('agent children response missing items')
      return response.items
    },
    suspend: (zoneId: string, id: string) =>
      this.request<{ suspended: true }>(`/zones/${zoneId}/agents/${id}/suspend`, { method: 'PATCH', base: 'coordinator' }),
    resume: (zoneId: string, id: string) =>
      this.request<{ resumed: true }>(`/zones/${zoneId}/agents/${id}/resume`, { method: 'PATCH', base: 'coordinator' }),
    terminate: (zoneId: string, id: string) =>
      this.request<void>(`/zones/${zoneId}/agents/${id}`, { method: 'DELETE', base: 'coordinator', expectEmpty: true }),
    effectiveAuthority: (zoneId: string, id: string) =>
      this.request<EffectiveAuthority>(`/zones/${zoneId}/agents/${id}/effective-authority`, { base: 'coordinator' }),
  }

  // Delegations (coordinator)
  delegations = {
    active: (zoneId: string) => this.request<ListResponse<DelegationEdge>>(`/zones/${zoneId}/delegations/active`, { base: 'coordinator' }),
    inbound: (zoneId: string, sessionId: string) =>
      this.request<DelegationEdge[]>(`/zones/${zoneId}/delegations/inbound/${sessionId}`, { base: 'coordinator' }),
    outbound: (zoneId: string, sessionId: string) =>
      this.request<DelegationEdge[]>(`/zones/${zoneId}/delegations/outbound/${sessionId}`, { base: 'coordinator' }),
    traverse: (zoneId: string, id: string) =>
      this.request<TraverseNode[]>(`/zones/${zoneId}/delegations/${id}/traverse`, { base: 'coordinator' }),
    impact: (zoneId: string, id: string) =>
      this.request<DelegationImpact>(`/zones/${zoneId}/delegations/${id}/impact`, { base: 'coordinator' }),
    revoke: (zoneId: string, id: string) =>
      this.request<{ revoked_edges: number; affected_sessions: number }>(`/zones/${zoneId}/delegations/${id}/revoke`, {
        method: 'PATCH',
        base: 'coordinator',
      }),
  }
}
