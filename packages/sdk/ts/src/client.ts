/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
 */

import { bind, fromEnvelope, toEnvelope, current, type CaracalContext, type VerifiedClaims } from './context.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { decodeEnvelope, encodeEnvelope, toHeaders, HeaderAuthorization, type Envelope, type HeaderGetter } from './envelope.js'
import {
  spawn as spawnPrimitive,
  spawnService as spawnServicePrimitive,
  delegate as delegatePrimitive,
  adoptDelegation,
  type Grant,
  type SpawnInput,
  type ServiceAgent,
  type DelegateInput,
} from './primitives.js'
import { type CoordinatorCallEvent, type CoordinatorClient, type DelegationConstraints, type DelegationResponse } from './coordinator.js'
import type { JsonObject } from './json.js'
import { OAuthClient, type OAuthEvent } from '@caracalai/oauth'
const DEFAULT_STS_URL = 'http://localhost:8080'
const DEFAULT_COORDINATOR_URL = 'http://localhost:4000'
const DEFAULT_GATEWAY_URL = 'http://localhost:8081'

export interface ResourceBinding {
  resourceId: string
  upstreamPrefix: string
}

export type TokenSource = () => string | Promise<string>

/**
 * Client-secret credential surface behind a configured Caracal client:
 * invalidates the cached lifecycle token after a server-side rejection and
 * mints scoped resource mandates for gateway calls.
 */
export interface ClientSecretExchanger {
  invalidate(): void
  mintMandate(
    resourceId: string,
    scopes: string[],
    opts?: { agentSessionId?: string; delegationEdgeId?: string; ttlSeconds?: number; approvalId?: string },
  ): Promise<string>
  waitForApproval(challengeId: string, opts?: { timeoutMs?: number }): Promise<string>
  /** Backing OAuth client; the Caracal facade attaches its event sink here. */
  client?: OAuthClient
}

export interface CaracalConfig {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken?: string
  tokenSource?: TokenSource
  exchanger?: ClientSecretExchanger
  gatewayUrl?: string
  resources?: ResourceBinding[]
  /** Default TTL for task spawns; a service session lives by its heartbeat lease instead. */
  defaultTtlSeconds?: number
}

export interface SpawnOptions {
  grant?: Grant
  ttlSeconds?: number
  subjectSessionId?: string
  parentId?: string
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  signal?: AbortSignal
}

export interface ServiceOptions {
  grant?: Grant
  ttlSeconds?: number
  subjectSessionId?: string
  parentId?: string
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  /**
   * Auto-heartbeat cadence. Leave unset to derive it from the server lease;
   * a positive value fixes the interval; zero or a negative value disables
   * the background timer, leaving the lease to manual heartbeat calls.
   */
  heartbeatIntervalMs?: number
  /** Called once if the coordinator reports the session permanently gone. */
  onLeaseLost?: (err: unknown) => void
  signal?: AbortSignal
}

export interface DelegateOptions {
  to: string
  toApplicationId: string
  resourceId?: string
  scopes: string[]
  constraints?: DelegationConstraints
  ttlSeconds?: number
  signal?: AbortSignal
}

export type LifecycleHook = (ctx: CaracalContext) => void | Promise<void>

/** Control-plane operation reported to onEvent subscribers: a token exchange, an approval wait, or a coordinator call. */
export type CaracalEvent = OAuthEvent | CoordinatorCallEvent

export type EventHook = (event: CaracalEvent) => void

export interface RootOptions {
  allowRoot?: boolean
}

/**
 * Transport behavior options. `scopes` switches gateway-routed requests from
 * the raw subject token to a scoped resource mandate minted for the routed
 * resource and the bound agent identity; requires a client-secret
 * configuration.
 */
export interface TransportOptions extends RootOptions {
  scopes?: string[]
}

/** Optional mint inputs: a TTL override, the approval challenge id for retrying an approval-gated mint, and an explicit context. */
export interface MandateOptions {
  ttlSeconds?: number
  approvalId?: string
  ctx?: CaracalContext
}

export interface BindOptions extends RootOptions {
  verify?: (token: string) => void | VerifiedClaims | Promise<void | VerifiedClaims>
}

export interface ClientSecretOptions {
  coordinatorUrl: string
  stsUrl: string
  zoneId: string
  applicationId: string
  clientSecret: string
  resources: Array<string | ResourceBinding>
  gatewayUrl?: string
  scope?: string
  /** Seeds CaracalConfig.defaultTtlSeconds for task spawns. */
  defaultTtlSeconds?: number
  fetchImpl?: typeof fetch
}

export interface CaracalOptions {
  env?: NodeJS.ProcessEnv
  configPath?: string
  clientSecret?: Partial<ClientSecretOptions>
}

export interface GatewayRequest {
  url: string
  headers: Record<string, string>
}

export class Caracal {
  readonly config: CaracalConfig
  private agentStartHooks: LifecycleHook[] = []
  private agentEndHooks: LifecycleHook[] = []
  private eventHooks: EventHook[] = []

  /**
   * Creates a Caracal client. With no arguments, credentials are
   * auto-detected from `CARACAL_CONFIG`, the default generated profile, or
   * environment variables. Pass `CaracalOptions` to steer detection or a
   * `CaracalConfig` for full programmatic control.
   */
  constructor(opts: CaracalConfig | CaracalOptions = {}) {
    const config = 'coordinator' in opts ? opts : detectConfig(opts)
    if ((config.subjectToken === undefined) === (config.tokenSource === undefined)) {
      throw new Error('CaracalConfig requires exactly one of subjectToken or tokenSource')
    }
    this.config = {
      ...config,
      coordinator: { ...config.coordinator, onEvent: (e) => this.emitEvent(e) },
      ...(config.resources && config.resources.length > 1 ? { resources: sortBindingsLongestFirst(config.resources) } : {}),
    }
    if (this.config.exchanger?.client) this.config.exchanger.client.onEvent = (e) => this.emitEvent(e)
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Caracal {
    return new Caracal(configFromEnv(env))
  }

  static fromClientSecret(opts: ClientSecretOptions): Caracal {
    return new Caracal(configFromClientSecret(opts))
  }

  static fromConfig(path = defaultProfilePath(), env: NodeJS.ProcessEnv = process.env): Caracal {
    return new Caracal(configFromProfile(path, env))
  }

  async close(): Promise<void> {}

  async spawn<T>(fn: () => Promise<T>, opts: SpawnOptions = {}): Promise<T> {
    const input: SpawnInput = {
      coordinator: this.config.coordinator,
      zoneId: this.config.zoneId,
      applicationId: this.config.applicationId,
      subjectToken: await this.rootToken(),
      tokenSource: this.config.tokenSource,
      invalidate: this.invalidate(),
      grant: opts.grant,
      ttlSeconds: opts.ttlSeconds ?? this.config.defaultTtlSeconds,
      subjectSessionId: opts.subjectSessionId,
      parentId: opts.parentId,
      metadata: opts.metadata,
      labels: opts.labels,
      traceId: opts.traceId,
      signal: opts.signal,
      onAgentStart: this.agentStartHooks.length ? (c) => this.fire(this.agentStartHooks, c) : undefined,
      onAgentEnd: this.agentEndHooks.length ? (c) => this.fire(this.agentEndHooks, c) : undefined,
    }
    return await spawnPrimitive(input, fn)
  }

  async spawnService(opts: ServiceOptions = {}): Promise<ServiceAgent> {
    return await spawnServicePrimitive({
      coordinator: this.config.coordinator,
      zoneId: this.config.zoneId,
      applicationId: this.config.applicationId,
      subjectToken: await this.rootToken(),
      tokenSource: this.config.tokenSource,
      invalidate: this.invalidate(),
      ttlSeconds: opts.ttlSeconds,
      subjectSessionId: opts.subjectSessionId,
      parentId: opts.parentId,
      grant: opts.grant,
      metadata: opts.metadata,
      labels: opts.labels,
      traceId: opts.traceId,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      onLeaseLost: opts.onLeaseLost,
      signal: opts.signal,
      onAgentStart: this.agentStartHooks.length ? (c) => this.fire(this.agentStartHooks, c) : undefined,
      onAgentEnd: this.agentEndHooks.length ? (c) => this.fire(this.agentEndHooks, c) : undefined,
    })
  }

  /**
   * Delegate a slice of the current agent's authority to an existing peer
   * session and return the created edge. The receiving agent adopts the edge
   * with adoptDelegation.
   */
  delegate(opts: DelegateOptions): Promise<DelegationResponse> {
    const input: DelegateInput = {
      coordinator: this.config.coordinator,
      toAgentSessionId: opts.to,
      toApplicationId: opts.toApplicationId,
      resourceId: opts.resourceId,
      scopes: opts.scopes,
      constraints: opts.constraints,
      ttlSeconds: opts.ttlSeconds,
      signal: opts.signal,
    }
    return delegatePrimitive(input)
  }

  /**
   * Run fn under a delegation edge received from a peer: the current agent
   * context is rebound so token exchanges inside fn present the edge.
   */
  adoptDelegation<T>(delegationEdgeId: string, fn: () => Promise<T>): Promise<T> {
    const ctx = current()
    if (!ctx) throw new Error('adoptDelegation requires a Caracal context bound on this path')
    return bind(adoptDelegation(ctx, delegationEdgeId), fn)
  }

  bind<T>(ctx: CaracalContext, fn: () => Promise<T>): Promise<T> {
    return bind(ctx, fn)
  }

  onAgentStart(cb: LifecycleHook): void {
    this.agentStartHooks.push(cb)
  }

  onAgentEnd(cb: LifecycleHook): void {
    this.agentEndHooks.push(cb)
  }

  /**
   * Subscribes to control-plane operation events: token exchanges (with cache
   * outcome), approval waits, and coordinator calls, each carrying outcome and
   * duration. Bridge them to any metrics or tracing system; a hook that throws
   * is ignored and never disturbs the operation that emitted the event.
   */
  onEvent(cb: EventHook): void {
    this.eventHooks.push(cb)
  }

  private emitEvent(event: CaracalEvent): void {
    for (const h of this.eventHooks) {
      try {
        h(event)
      } catch {
        // The observability sink must never break the operation path.
      }
    }
  }

  private async fire(hooks: LifecycleHook[], ctx: CaracalContext): Promise<void> {
    for (const h of hooks) await h(ctx)
  }

  current(): CaracalContext | undefined {
    return current()
  }

  /**
   * Envelope headers plus the bearer credential for the current context.
   * The context token is returned as bound; long-lived holders needing a
   * refreshed own-credential token use headersAsync. Root application
   * identity requires `{ allowRoot: true }`.
   */
  headers(opts: RootOptions = {}): Record<string, string> {
    const ctx = current()
    if (!ctx) {
      if (!opts.allowRoot) {
        throw new Error('Caracal.headers(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.')
      }
      return {
        ...toHeaders({ hop: 0 }),
        [HeaderAuthorization]: `Bearer ${this.rootTokenSync()}`,
      }
    }
    return {
      ...toHeaders(toEnvelope(ctx)),
      [HeaderAuthorization]: `Bearer ${ctx.subjectToken}`,
    }
  }

  /**
   * Async variant of headers. For contexts this process spawned from its own
   * credentials, the bearer is resolved fresh through the token source so
   * long-lived holders never present an expired token; inbound contexts stay
   * pinned to the caller's token.
   */
  async headersAsync(opts: RootOptions = {}): Promise<Record<string, string>> {
    const ctx = current()
    if (!ctx) {
      if (!opts.allowRoot) {
        throw new Error(
          'Caracal.headersAsync(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.',
        )
      }
      return {
        ...toHeaders({ hop: 0 }),
        [HeaderAuthorization]: `Bearer ${await this.rootToken()}`,
      }
    }
    const token = ctx.ownToken && this.config.tokenSource ? await this.config.tokenSource() : ctx.subjectToken
    return {
      ...toHeaders(toEnvelope(ctx)),
      [HeaderAuthorization]: `Bearer ${token}`,
    }
  }

  async bindFromHeaders<T>(
    headers: Record<string, string | string[] | undefined> | HeaderGetter,
    fn: () => Promise<T>,
    opts: BindOptions = {},
  ): Promise<T> {
    const env =
      typeof headers === 'function'
        ? decodeEnvelope(headers)
        : decodeEnvelope((n) => {
            const lower = n.toLowerCase()
            for (const k of Object.keys(headers)) {
              if (k.toLowerCase() === lower) {
                const v = (headers as Record<string, string | string[] | undefined>)[k]
                return Array.isArray(v) ? v[0] : v
              }
            }
            return undefined
          })
    let claims: VerifiedClaims | undefined
    let rootInjected = false
    if (!env.subjectToken) {
      if (!opts.allowRoot) {
        throw new Error(
          'Caracal.bindFromHeaders(): inbound request is missing a bearer token. Pass { allowRoot: true } only for trusted service-root ingress.',
        )
      }
      env.subjectToken = await this.rootToken()
      rootInjected = true
    } else if (opts.verify) {
      const verified = await opts.verify(env.subjectToken)
      if (verified) claims = verified
    }
    if (claims) {
      if (claims.agentSessionId !== undefined) env.agentSessionId = claims.agentSessionId
      if (claims.delegationEdgeId !== undefined) env.delegationEdgeId = claims.delegationEdgeId
      if (claims.parentEdgeId !== undefined) env.parentEdgeId = claims.parentEdgeId
      if (claims.sessionId !== undefined) env.sessionId = claims.sessionId
      if (claims.hop !== undefined) env.hop = claims.hop
    }
    const ctx = fromEnvelope(env as Envelope, {
      zoneId: claims?.zoneId ?? this.config.zoneId,
      applicationId: claims?.applicationId ?? this.config.applicationId,
    })
    return await bind(rootInjected ? { ...ctx, ownToken: true } : ctx, fn)
  }

  /**
   * Returns a fetch-shaped function that injects the Caracal context envelope
   * (traceparent, tracestate, baggage) onto outbound requests, merging with any
   * headers the caller or an OpenTelemetry SDK already set. The bearer is
   * attached only to gateway-routed calls, where the Gateway terminates it at
   * the trust boundary: a scoped mandate when `scopes` is set, otherwise the
   * context's subject token. No default timeout is applied; pass
   * `init.signal` (e.g. AbortSignal.timeout) to bound a call. Pass to any
   * provider SDK that accepts a custom fetch.
   */
  transport(opts: TransportOptions = {}): typeof fetch {
    const outer = this
    const rootAllowed = opts.allowRoot === true
    const scopes = opts.scopes
    const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const ctx = current()
      if (!ctx && !rootAllowed) {
        throw new Error('Caracal.transport(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.')
      }
      const env: Envelope = ctx ? toEnvelope(ctx) : { hop: 0 }
      const merged = new Headers(init?.headers ?? {})
      encodeEnvelope(
        env,
        (k, v) => merged.set(k, v),
        (k) => merged.get(k) ?? undefined,
      )
      const fetchImpl = outer.config.coordinator.fetchImpl ?? fetch

      const explicitResource = merged.get('X-Caracal-Resource') ?? undefined
      const rewritten = outer.routeThroughGateway(input, explicitResource)
      if (rewritten) {
        merged.set('X-Caracal-Resource', rewritten.resourceId)
        merged.set('Authorization', `Bearer ${await outer.gatewayToken(ctx, rewritten.resourceId, scopes)}`)
        return fetchImpl(rewritten.url as unknown as URL, { ...init, headers: merged })
      }
      if (outer.targetsGateway(input)) {
        merged.set('Authorization', `Bearer ${await outer.gatewayToken(ctx, explicitResource, scopes)}`)
      }
      return fetchImpl(input as URL, { ...init, headers: merged })
    }) as typeof fetch
    return fn
  }

  /**
   * Resolves the bearer for a gateway-bound request: a scoped mandate when
   * scopes are set and the routed resource is known, a fresh token from the
   * token source for contexts this process spawned from its own credentials,
   * the pinned context token for inbound-bound contexts, or the application
   * token in root mode.
   */
  private async gatewayToken(ctx: CaracalContext | undefined, resourceId: string | undefined, scopes: string[] | undefined): Promise<string> {
    if (scopes?.length && resourceId) {
      const exchanger = this.config.exchanger
      if (!exchanger) throw new Error('Caracal.transport(): scopes require a client-secret configuration')
      return exchanger.mintMandate(resourceId, scopes, {
        agentSessionId: ctx?.agentSessionId,
        delegationEdgeId: ctx?.delegationEdgeId,
      })
    }
    if (!ctx) return this.rootToken()
    if (ctx.ownToken && this.config.tokenSource) return await this.config.tokenSource()
    return ctx.subjectToken
  }

  /**
   * Mints a resource mandate for the current agent: a short-lived token
   * audienced to `resourceId` and narrowed to `scopes`, carrying the agent
   * session and delegation edge of the bound context. The STS evaluates
   * policy against that agent's authority, so a narrowed child can mint only
   * what its delegation edge allows. Results are cached per resource, scope
   * set, and agent identity, and refreshed before expiry.
   *
   * When a scope is approval-gated this throws InteractionRequiredError;
   * retry with `approvalId` set to the returned challenge id once an
   * authenticated approver has satisfied it. Requires a client-secret
   * configuration.
   */
  mintMandate(resourceId: string, scopes: string[], opts: MandateOptions = {}): Promise<string> {
    const exchanger = this.config.exchanger
    if (!exchanger) throw new Error('Caracal.mintMandate(): requires a client-secret configuration')
    const ctx = opts.ctx ?? current()
    return exchanger.mintMandate(resourceId, scopes, {
      agentSessionId: ctx?.agentSessionId,
      delegationEdgeId: ctx?.delegationEdgeId,
      ttlSeconds: opts.ttlSeconds,
      approvalId: opts.approvalId,
    })
  }

  /**
   * Long-polls an approval challenge until an approver decides it, it
   * expires, or the timeout elapses. Returns the final lifecycle state:
   * 'approved' means retrying the mint with `approvalId` set will succeed;
   * 'rejected' and 'expired' are terminal; 'pending' means the timeout
   * elapsed with no decision and waiting again is safe.
   */
  waitForApproval(challengeId: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    const exchanger = this.config.exchanger
    if (!exchanger) throw new Error('Caracal.waitForApproval(): requires a client-secret configuration')
    return exchanger.waitForApproval(challengeId, opts)
  }

  gatewayRequest(resourceId: string, path: string = '/'): GatewayRequest {
    if (!this.config.gatewayUrl) throw new Error('Caracal.gatewayRequest(): gatewayUrl is not configured')
    if (!resourceId.trim()) throw new Error('Caracal.gatewayRequest(): resourceId is required')
    return {
      url: joinGatewayPath(this.config.gatewayUrl, path),
      headers: { 'X-Caracal-Resource': resourceId },
    }
  }

  /**
   * One-call happy path: sends `init` to `path` on the given resource through the
   * Gateway with Caracal context and authority injected. Equivalent to building a
   * `gatewayRequest` and calling it with `transport`. The resource header always
   * wins over any caller-supplied `X-Caracal-Resource`. No default timeout is
   * applied; pass `init.signal` (e.g. AbortSignal.timeout) to bound a call.
   */
  fetch(resourceId: string, path: string = '/', init: RequestInit = {}, opts: TransportOptions = {}): Promise<Response> {
    const request = this.gatewayRequest(resourceId, path)
    const headers = new Headers(init.headers ?? {})
    for (const [key, value] of Object.entries(request.headers)) headers.set(key, value)
    return this.transport(opts)(request.url, { ...init, headers })
  }

  private routeThroughGateway(input: RequestInfo | URL, explicitResource: string | undefined): { url: string; resourceId: string } | null {
    const gw = this.config.gatewayUrl
    if (!gw) return null
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return null
    }
    if (sameOrigin(parsed, gw)) return null
    const binding = explicitResource
      ? this.config.resources?.find((b) => b.resourceId === explicitResource)
      : this.config.resources?.find((b) => urlMatchesPrefix(parsed, b.upstreamPrefix))
    if (!binding && !explicitResource) return null

    const gateway = new URL(gw)
    let suffix = parsed.pathname + parsed.search
    if (binding) {
      const prefix = new URL(binding.upstreamPrefix)
      if (parsed.pathname.startsWith(prefix.pathname) && prefix.pathname !== '/') {
        suffix = parsed.pathname.slice(prefix.pathname.length) + parsed.search
        if (!suffix.startsWith('/')) suffix = '/' + suffix
      }
    }
    const base = gateway.origin + gateway.pathname.replace(/\/$/, '')
    const target = base + suffix
    return { url: target, resourceId: binding?.resourceId ?? explicitResource! }
  }

  /** Reports whether the request is already addressed to the Gateway origin, where the subject token terminates. */
  private targetsGateway(input: RequestInfo | URL): boolean {
    const gw = this.config.gatewayUrl
    if (!gw) return false
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    try {
      return sameOrigin(new URL(raw), gw)
    } catch {
      return false
    }
  }

  /**
   * Binds Caracal context at the inbound request boundary. Pass `verify` to
   * enforce the bearer token before binding; without it this middleware only
   * propagates context and must sit behind a verifier boundary. Boundary
   * failures (missing token, verify rejection) answer 401 directly; errors
   * thrown by downstream handlers still flow to the framework error path.
   */
  contextMiddleware(opts: BindOptions = {}) {
    return (
      req: { headers: Record<string, string | string[] | undefined> },
      res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
      next: (err?: unknown) => void,
    ): void => {
      let entered = false
      this.bindFromHeaders(
        req.headers,
        async () => {
          entered = true
          next()
        },
        opts,
      ).catch((err) => {
        if (entered) {
          next(err)
          return
        }
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        res.end('{"error":"unauthorized","error_description":"invalid or missing authorization"}')
      })
    }
  }

  private invalidate(): (() => void) | undefined {
    const exchanger = this.config.exchanger
    return exchanger ? () => exchanger.invalidate() : undefined
  }

  private rootTokenSync(): string {
    if (this.config.subjectToken) return this.config.subjectToken
    throw new Error('Caracal.headers(): this client uses an async token source. Use headersAsync({ allowRoot: true }) for root headers.')
  }

  private async rootToken(): Promise<string> {
    if (this.config.tokenSource) return await this.config.tokenSource()
    if (this.config.subjectToken) return this.config.subjectToken
    throw new Error('Caracal client has no subject token source')
  }
}

function productionEnv(env: NodeJS.ProcessEnv): boolean {
  // CARACAL_ENV is the language-neutral gate every Caracal SDK honors; when
  // unset, Node deployments fall back to NODE_ENV.
  if (env.CARACAL_ENV) return env.CARACAL_ENV === 'production'
  return env.NODE_ENV === 'production'
}

function serviceUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]
  if (value) return value
  if (productionEnv(env)) throw new Error(`Caracal SDK: ${key} is required in production`)
  return fallback
}

function stsUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return env.CARACAL_STS_URL ?? env.CARACAL_ZONE_URL ?? serviceUrl(env, 'CARACAL_STS_URL', DEFAULT_STS_URL)
}

interface ProfileResources {
  resources: Array<string | ResourceBinding>
  bindings?: ResourceBinding[]
  credentialResources?: Array<string | ResourceBinding>
}

interface CredentialEntry {
  resource: string
  upstream_prefix?: string
}

function defaultProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultConfigDir(env), 'caracal.toml')
}

function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CARACAL_CONFIG_HOME) return env.CARACAL_CONFIG_HOME
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'caracal')
  if (platform() === 'win32') return join(env.APPDATA || env.LOCALAPPDATA || join(homedir(), 'AppData', 'Roaming'), 'Caracal')
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Caracal')
  return join(homedir(), '.config', 'caracal')
}

function defaultCredentialDir(env: NodeJS.ProcessEnv, zoneId: string, applicationId: string): string {
  return join(defaultConfigDir(env), 'runtime', safePathSegment(zoneId), safePathSegment(applicationId))
}

function defaultClientSecretPath(env: NodeJS.ProcessEnv, zoneId: string, applicationId: string): string {
  return join(defaultCredentialDir(env, zoneId, applicationId), 'client-secret')
}

function defaultRunCredentialsPath(env: NodeJS.ProcessEnv, zoneId: string, applicationId: string): string {
  return join(defaultCredentialDir(env, zoneId, applicationId), 'credentials.json')
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_')
  let start = 0
  let end = segment.length
  while (start < end && segment[start] === '_') start += 1
  while (end > start && segment[end - 1] === '_') end -= 1
  return segment.slice(start, end) || 'default'
}

function existingLocalFile(path: string, env: NodeJS.ProcessEnv): string | undefined {
  if (productionEnv(env)) return undefined
  return existsSync(path) ? path : undefined
}

function detectConfig(opts: CaracalOptions): CaracalConfig {
  if (opts.clientSecret && Object.keys(opts.clientSecret).length > 0) {
    const cs = opts.clientSecret
    const missing = [
      ['coordinatorUrl', cs.coordinatorUrl],
      ['stsUrl', cs.stsUrl],
      ['zoneId', cs.zoneId],
      ['applicationId', cs.applicationId],
      ['clientSecret', cs.clientSecret],
      ['resources', cs.resources?.length ? 'set' : undefined],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k)
    if (missing.length) {
      throw new Error(`Caracal: clientSecret missing ${missing.join(', ')}`)
    }
    return configFromClientSecret(cs as ClientSecretOptions)
  }
  const env = opts.env ?? process.env
  if (opts.configPath) return configFromProfile(opts.configPath, env)
  const path = resolveProfilePath(env)
  if (path) return configFromProfile(path, env)
  return configFromEnv(env)
}

function configFromEnv(env: NodeJS.ProcessEnv): CaracalConfig {
  const url = serviceUrl(env, 'CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const zoneId = env.CARACAL_ZONE_ID
  const applicationId = env.CARACAL_APPLICATION_ID
  const subjectToken = env.CARACAL_SUBJECT_TOKEN
  const stsUrl = stsUrlFromEnv(env)
  const gatewayUrl = serviceUrl(env, 'CARACAL_GATEWAY_URL', DEFAULT_GATEWAY_URL)
  const missing = [
    ['CARACAL_ZONE_ID', zoneId],
    ['CARACAL_APPLICATION_ID', applicationId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) {
    throw new Error(`Caracal.fromEnv: missing ${missing.join(', ')}`)
  }
  const clientSecret = clientSecretFromEnv(env, zoneId!, applicationId!)
  const profileResources = resourcesFromEnv(env, zoneId!, applicationId!)
  const resources = profileResources.bindings
  const defaultTtlSeconds = defaultTtlFromEnv(env)
  if (clientSecret) {
    return configFromClientSecret({
      coordinatorUrl: url,
      stsUrl,
      zoneId: zoneId!,
      applicationId: applicationId!,
      clientSecret,
      resources: resourceIdsFromEnv(env.CARACAL_APP_RESOURCES, profileResources.credentialResources ?? [], profileResources.resources),
      gatewayUrl,
      defaultTtlSeconds,
    })
  }
  if (!subjectToken) {
    throw new Error('Caracal.fromEnv: provide CARACAL_APP_CLIENT_SECRET or CARACAL_SUBJECT_TOKEN')
  }
  validateSubjectToken(subjectToken!)
  return {
    coordinator: { baseUrl: url },
    zoneId: zoneId!,
    applicationId: applicationId!,
    subjectToken: subjectToken!,
    gatewayUrl,
    resources,
    defaultTtlSeconds,
  }
}

function defaultTtlFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.CARACAL_DEFAULT_TTL_SECONDS
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Caracal: CARACAL_DEFAULT_TTL_SECONDS must be a positive integer')
  }
  return value
}

function configFromClientSecret(opts: ClientSecretOptions): CaracalConfig {
  const missing = [
    ['coordinatorUrl', opts.coordinatorUrl],
    ['stsUrl', opts.stsUrl],
    ['zoneId', opts.zoneId],
    ['applicationId', opts.applicationId],
    ['clientSecret', opts.clientSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) throw new Error(`Caracal.fromClientSecret missing ${missing.join(', ')}`)
  if (opts.defaultTtlSeconds !== undefined && (!Number.isInteger(opts.defaultTtlSeconds) || opts.defaultTtlSeconds <= 0)) {
    throw new Error('Caracal.fromClientSecret: defaultTtlSeconds must be a positive integer')
  }
  const resourceIds = opts.resources.map((value) => (typeof value === 'string' ? value : value.resourceId))
  if (!resourceIds.length) throw new Error('Caracal.fromClientSecret requires at least one resource')
  const bindings = opts.resources.filter((value): value is ResourceBinding => typeof value !== 'string')
  const tokenSource = createClientSecretTokenSource(
    opts.stsUrl,
    opts.zoneId,
    opts.applicationId,
    opts.clientSecret,
    resourceIds,
    opts.scope,
    opts.fetchImpl,
  )
  return {
    coordinator: { baseUrl: opts.coordinatorUrl },
    zoneId: opts.zoneId,
    applicationId: opts.applicationId,
    tokenSource: tokenSource.source,
    exchanger: tokenSource,
    gatewayUrl: opts.gatewayUrl,
    resources: bindings.length ? bindings : undefined,
    defaultTtlSeconds: opts.defaultTtlSeconds,
  }
}

function configFromProfile(path: string, env: NodeJS.ProcessEnv): CaracalConfig {
  if (!existsSync(path)) throw new Error(`Caracal.fromConfig: profile not found: ${path}`)
  assertProfileFileSecure(path)
  const value = parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error('Caracal.fromConfig: profile must be a TOML table')
  const zoneId = requiredString(value, 'zone_id', path)
  const applicationId = requiredString(value, 'application_id', path)
  const stsUrl =
    stringValue(value, 'sts_url') ??
    stringValue(value, 'zone_url') ??
    env.CARACAL_STS_URL ??
    env.CARACAL_ZONE_URL ??
    serviceUrl(env, 'CARACAL_STS_URL', DEFAULT_STS_URL)
  const coordinatorUrl = stringValue(value, 'coordinator_url') ?? serviceUrl(env, 'CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const resources = resourcesFromProfile(value, path, env, zoneId, applicationId)
  if (!resources.resources.length) {
    throw new Error(
      `Caracal.fromConfig: ${path} requires at least one resource via credentials, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE`,
    )
  }
  return configFromClientSecret({
    coordinatorUrl,
    stsUrl,
    zoneId,
    applicationId,
    clientSecret: clientSecretFromProfile(value, path, env, zoneId, applicationId),
    resources: resources.resources,
    gatewayUrl: stringValue(value, 'gateway_url') ?? serviceUrl(env, 'CARACAL_GATEWAY_URL', DEFAULT_GATEWAY_URL),
    defaultTtlSeconds: profileTtlSeconds(value, path) ?? defaultTtlFromEnv(env),
  })
}

function profileTtlSeconds(record: Record<string, unknown>, source: string): number | undefined {
  const value = record.default_ttl_seconds
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${source}: default_ttl_seconds must be a positive integer`)
  }
  return value
}

function resolveProfilePath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CARACAL_CONFIG) {
    if (!existsSync(env.CARACAL_CONFIG)) throw new Error(`Caracal: profile not found: ${env.CARACAL_CONFIG}`)
    return env.CARACAL_CONFIG
  }
  const path = defaultProfilePath(env)
  return existsSync(path) ? path : undefined
}

function assertProfileFileSecure(path: string): void {
  if (process.platform === 'win32') return
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o022) !== 0) throw new Error(`Caracal.fromConfig: profile permissions are too broad: ${path}`)
}

function assertSecretFileSecure(path: string): void {
  if (process.platform === 'win32') return
  const mode = statSync(path).mode & 0o777
  // A file carrying a secret must be readable only by its owner.
  if ((mode & 0o077) !== 0) throw new Error(`Caracal: secret file must be readable only by its owner: ${path}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Caracal profile: ${key} must be a non-empty string`)
  return value
}

function requiredString(record: Record<string, unknown>, key: string, source: string): string {
  const value = stringValue(record, key)
  if (!value) throw new Error(`${source}: ${key} is required`)
  return value
}

function clientSecretFromProfile(
  record: Record<string, unknown>,
  source: string,
  env: NodeJS.ProcessEnv,
  zoneId: string,
  applicationId: string,
): string {
  const inline = stringValue(record, 'app_client_secret')
  const file = stringValue(record, 'app_client_secret_file')
  if (inline && file) throw new Error(`${source}: set only one of app_client_secret or app_client_secret_file`)
  if (inline) {
    if (process.platform !== 'win32' && (statSync(source).mode & 0o077) !== 0) {
      throw new Error(`${source} carries an inline app_client_secret and must be readable only by its owner`)
    }
    return inline
  }
  const localFile = file ?? existingLocalFile(defaultClientSecretPath(env, zoneId, applicationId), env)
  if (!localFile)
    throw new Error(
      `${source}: client secret is required; local dev/stable auto-detects ${defaultClientSecretPath(env, zoneId, applicationId)} when it exists`,
    )
  return readSecretFile(localFile)
}

function clientSecretFromEnv(env: NodeJS.ProcessEnv, zoneId: string, applicationId: string): string | undefined {
  if (env.CARACAL_APP_CLIENT_SECRET && env.CARACAL_APP_CLIENT_SECRET_FILE) {
    throw new Error('Caracal.fromEnv: set only one of CARACAL_APP_CLIENT_SECRET or CARACAL_APP_CLIENT_SECRET_FILE')
  }
  if (env.CARACAL_APP_CLIENT_SECRET_FILE) return readSecretFile(env.CARACAL_APP_CLIENT_SECRET_FILE)
  if (env.CARACAL_APP_CLIENT_SECRET) return env.CARACAL_APP_CLIENT_SECRET
  const localFile = existingLocalFile(defaultClientSecretPath(env, zoneId, applicationId), env)
  if (localFile) return readSecretFile(localFile)
  return undefined
}

function readSecretFile(path: string): string {
  if (!existsSync(path)) throw new Error(`Caracal profile secret file does not exist: ${path}`)
  assertSecretFileSecure(path)
  const secret = readFileSync(path, 'utf8').trim()
  if (!secret) throw new Error(`Caracal profile secret file is empty: ${path}`)
  return secret
}

function resourcesFromProfile(
  record: Record<string, unknown>,
  source: string,
  env: NodeJS.ProcessEnv,
  zoneId: string,
  applicationId: string,
): ProfileResources {
  const credentials = [
    ...credentialEntries(record.credentials, `${source}.credentials`),
    ...credentialEntries(record.optional_credentials, `${source}.optional_credentials`),
    ...credentialManifestFromEnv(env, zoneId, applicationId),
  ]
  const resources = resourcesFromCredentials(credentials)
  const resolved = resolveProfileResources(resources.resources, resources.bindings ?? [], env)
  return { ...resolved, credentialResources: resources.resources }
}

function resourcesFromEnv(env: NodeJS.ProcessEnv, zoneId: string, applicationId: string): ProfileResources {
  const credentials = credentialManifestFromEnv(env, zoneId, applicationId)
  const resources = resourcesFromCredentials(credentials)
  const resolved = resolveProfileResources(resources.resources, resources.bindings ?? [], env)
  return { ...resolved, credentialResources: resources.resources }
}

function resolveProfileResources(
  resources: Array<string | ResourceBinding>,
  credentialBindings: ResourceBinding[],
  env: NodeJS.ProcessEnv,
): ProfileResources {
  const envBindings = parseResourceBindings(env.CARACAL_RESOURCES) ?? []
  const bindings = sortBindingsLongestFirst(
    mergeResourceBindings(credentialBindings, resourceBindingsFromFile(env.CARACAL_RESOURCES_FILE), envBindings),
  )
  const byResource = new Map<string, string | ResourceBinding>()
  for (const item of resources) byResource.set(typeof item === 'string' ? item : item.resourceId, item)
  for (const binding of bindings) byResource.set(binding.resourceId, binding)
  const values = [...byResource.values()]
  return { resources: values, bindings }
}

function resourceBindingsFromFile(path: string | undefined): ResourceBinding[] {
  if (!path) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const errors: string[] = []
  if (Array.isArray(parsed)) {
    const out: ResourceBinding[] = []
    for (const [index, entry] of parsed.entries()) {
      if (!isRecord(entry)) {
        errors.push(`[${index}]: entry must be an object`)
        continue
      }
      const keys = Object.keys(entry)
      if (keys.length !== 2 || !keys.includes('resource_id') || !keys.includes('upstream_prefix')) {
        errors.push(`[${index}]: expected exactly resource_id and upstream_prefix`)
        continue
      }
      const resourceId = entry.resource_id
      const upstreamPrefix = entry.upstream_prefix
      if (typeof resourceId !== 'string' || !resourceId) {
        errors.push(`[${index}]: resource_id must be a non-empty string`)
        continue
      }
      if (typeof upstreamPrefix !== 'string' || !upstreamPrefix) {
        errors.push(`[${index}]: upstream_prefix must be a non-empty string`)
        continue
      }
      if (!isAbsoluteUrl(upstreamPrefix)) {
        errors.push(`[${index}]: upstream_prefix must be an absolute URL`)
        continue
      }
      out.push({ resourceId, upstreamPrefix })
    }
    if (errors.length) throw new Error(`invalid CARACAL_RESOURCES_FILE:\n- ${errors.join('\n- ')}`)
    return out
  }
  if (isRecord(parsed)) {
    const out: ResourceBinding[] = []
    for (const [resourceId, upstreamPrefix] of Object.entries(parsed)) {
      if (!resourceId) {
        errors.push('key must be a non-empty string')
        continue
      }
      if (typeof upstreamPrefix !== 'string' || !upstreamPrefix) {
        errors.push(`entry ${JSON.stringify(resourceId)} upstream_prefix must be a non-empty string`)
        continue
      }
      if (!isAbsoluteUrl(upstreamPrefix)) {
        errors.push(`entry ${JSON.stringify(resourceId)} upstream_prefix must be an absolute URL`)
        continue
      }
      out.push({ resourceId, upstreamPrefix })
    }
    if (errors.length) throw new Error(`invalid CARACAL_RESOURCES_FILE:\n- ${errors.join('\n- ')}`)
    return out
  }
  throw new Error('CARACAL_RESOURCES_FILE must contain an object or array')
}

function mergeResourceBindings(...sources: ResourceBinding[][]): ResourceBinding[] {
  const order: string[] = []
  const byResource = new Map<string, ResourceBinding>()
  for (const source of sources) {
    for (const binding of source) {
      if (!byResource.has(binding.resourceId)) order.push(binding.resourceId)
      byResource.set(binding.resourceId, binding)
    }
  }
  return order.map((resourceId) => byResource.get(resourceId)!)
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return Boolean(parsed.protocol && parsed.host)
  } catch {
    return false
  }
}

function credentialManifestFromEnv(env: NodeJS.ProcessEnv, zoneId: string, applicationId: string): CredentialEntry[] {
  const file = env.CARACAL_RUN_CREDENTIALS_FILE
  const inline = env.CARACAL_RUN_CREDENTIALS
  if (file && inline) throw new Error('Caracal.fromEnv: set only one of CARACAL_RUN_CREDENTIALS or CARACAL_RUN_CREDENTIALS_FILE')
  const localFile = !file && !inline ? existingLocalFile(defaultRunCredentialsPath(env, zoneId, applicationId), env) : undefined
  if (!file && !inline && !localFile) return []
  const raw = file || localFile ? readSecretFile(file ?? localFile!) : inline!
  const parsed = JSON.parse(raw) as unknown
  const manifest = Array.isArray(parsed) ? { credentials: parsed } : parsed
  if (!isRecord(manifest)) throw new Error('Caracal.fromEnv: credential manifest must be an array or object')
  return [
    ...credentialEntries(manifest.credentials, 'CARACAL_RUN_CREDENTIALS.credentials'),
    ...credentialEntries(manifest.optional_credentials, 'CARACAL_RUN_CREDENTIALS.optional_credentials'),
  ]
}

function credentialEntries(value: unknown, source: string): CredentialEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${source} must be an array`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${source}[${index}] must be an object`)
    const resource = stringValue(entry, 'resource')
    if (!resource) throw new Error(`${source}[${index}].resource is required`)
    const upstreamPrefix = stringValue(entry, 'upstream_prefix')
    return upstreamPrefix ? { resource, upstream_prefix: upstreamPrefix } : { resource }
  })
}

function resourcesFromCredentials(credentials: CredentialEntry[]): ProfileResources {
  const values: Array<string | ResourceBinding> = []
  const seen = new Set<string>()
  for (const credential of credentials) {
    if (seen.has(credential.resource)) continue
    seen.add(credential.resource)
    values.push(
      credential.upstream_prefix ? { resourceId: credential.resource, upstreamPrefix: credential.upstream_prefix } : credential.resource,
    )
  }
  const bindings = values.filter((value): value is ResourceBinding => typeof value !== 'string')
  return { resources: values, bindings }
}

function sameOrigin(a: URL, b: string): boolean {
  try {
    const o = new URL(b)
    return a.protocol === o.protocol && a.host === o.host
  } catch {
    return false
  }
}

function joinGatewayPath(gatewayUrl: string, path: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    throw new Error('Caracal.gatewayRequest(): path must be relative to the configured gateway')
  }
  const gateway = new URL(gatewayUrl)
  const normalized = path.startsWith('/') ? path : `/${path}`
  const queryIndex = normalized.indexOf('?')
  const pathname = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : normalized.slice(queryIndex + 1)
  const base = gateway.origin + gateway.pathname.replace(/\/$/, '')
  return `${base}${pathname || '/'}${query ? `?${query}` : ''}`
}

function urlMatchesPrefix(target: URL, prefix: string): boolean {
  let p: URL
  try {
    p = new URL(prefix)
  } catch {
    return false
  }
  if (p.protocol !== target.protocol) return false
  if (p.host !== target.host) return false
  if (p.pathname === '/' || p.pathname === '') return true
  return target.pathname === p.pathname || target.pathname.startsWith(p.pathname.endsWith('/') ? p.pathname : p.pathname + '/')
}

function parseResourceBindings(raw: string | undefined): ResourceBinding[] | undefined {
  if (!raw) return undefined
  const out: ResourceBinding[] = []
  const errors: string[] = []
  for (const [index, entry] of raw.split(',').entries()) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) {
      errors.push(`entry ${index + 1} must use resourceId=upstreamPrefix`)
      continue
    }
    const resourceId = trimmed.slice(0, idx).trim()
    const upstreamPrefix = trimmed.slice(idx + 1).trim()
    if (!resourceId || !upstreamPrefix) {
      errors.push(`entry ${index + 1} must contain non-empty resourceId and upstreamPrefix`)
      continue
    }
    if (!isAbsoluteUrl(upstreamPrefix)) {
      errors.push(`entry ${index + 1} upstreamPrefix must be an absolute URL`)
      continue
    }
    out.push({ resourceId, upstreamPrefix })
  }
  if (errors.length) {
    throw new Error(`Caracal.fromEnv: invalid CARACAL_RESOURCES:\n- ${errors.join('\n- ')}`)
  }
  return out.length ? sortBindingsLongestFirst(out) : undefined
}

function compactResourceValues(values: Array<string | ResourceBinding>): Array<string | ResourceBinding> {
  const seen = new Set<string>()
  const out: Array<string | ResourceBinding> = []
  for (const value of values) {
    const resourceId = typeof value === 'string' ? value : value.resourceId
    if (!resourceId || seen.has(resourceId)) continue
    seen.add(resourceId)
    out.push(value)
  }
  return out
}

function resourceIdsFromEnv(
  raw: string | undefined,
  first: Array<string | ResourceBinding>,
  resources: Array<string | ResourceBinding> | undefined,
): Array<string | ResourceBinding> {
  const explicit =
    raw
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  // Binding-derived ids always join the STS audience set so a routed resource
  // can never be minted without an audience.
  const values = compactResourceValues([...first, ...explicit, ...(resources ?? [])])
  if (values.length) return values
  throw new Error(
    'Caracal.fromEnv: client-secret mode requires resources via CARACAL_APP_RESOURCES, CARACAL_RUN_CREDENTIALS, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE',
  )
}

/**
 * Client-secret credential surface: a lifecycle token source backed by the
 * OAuth client's cached, single-flighted exchange, plus scoped mandate
 * minting for gateway calls. `invalidate` forces the next lifecycle token to
 * bypass the cache after a server-side rejection.
 */
function createClientSecretTokenSource(
  stsUrl: string,
  zoneId: string,
  applicationId: string,
  clientSecret: string,
  resources: string[],
  scope = 'agent:lifecycle',
  fetchImpl?: typeof fetch,
): ClientSecretExchanger & { source: TokenSource } {
  const client = new OAuthClient(stsUrl, zoneId, applicationId, undefined, fetchImpl)
  let force = false
  return {
    client,
    source: async () => {
      const forceRefresh = force
      force = false
      const token = await client.exchange('', resources, { clientSecret, scopes: [scope], forceRefresh })
      return token.accessToken
    },
    invalidate: () => {
      force = true
    },
    mintMandate: async (resourceId, scopes, opts = {}) => {
      const token = await client.exchange('', resourceId, {
        clientSecret,
        scopes: [...new Set(scopes)].sort(),
        agentSessionId: opts.agentSessionId,
        delegationEdgeId: opts.delegationEdgeId,
        ttlSeconds: opts.ttlSeconds,
        challengeId: opts.approvalId,
      })
      return token.accessToken
    },
    waitForApproval: (challengeId, opts = {}) => client.waitForApproval(challengeId, opts),
  }
}

function sortBindingsLongestFirst(bindings: ResourceBinding[]): ResourceBinding[] {
  return [...bindings].sort((a, b) => b.upstreamPrefix.length - a.upstreamPrefix.length)
}

/**
 * Local sanity check on the bootstrap subject token. When the token has a JWT
 * shape, decodes the payload and rejects tokens that are malformed or already
 * expired. Opaque tokens are accepted.
 */
function validateSubjectToken(token: string): void {
  const parts = token.split('.')
  if (parts.length !== 3) return
  let payloadJson: string
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4)
    const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
    payloadJson = typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('utf-8') : atob(b64)
  } catch {
    return
  }
  let payload: { exp?: number }
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    return
  }
  if (typeof payload.exp !== 'number') return
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('CARACAL_SUBJECT_TOKEN is expired: refresh the bootstrap token before starting the application')
  }
}
