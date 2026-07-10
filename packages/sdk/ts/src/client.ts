/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
 */

import {
  bind,
  contextBearer,
  fromEnvelope,
  fromVerifiedEnvelope,
  toEnvelope,
  current,
  type CaracalContext,
  type VerifiedClaims,
} from './context.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { parse } from 'smol-toml'
import {
  decodeEnvelope,
  encodeEnvelope,
  fromHeaders,
  toHeaders,
  HeaderAuthorization,
  type Envelope,
  type HeaderGetter,
} from './envelope.js'
import {
  session as sessionPrimitive,
  startSession as startSessionPrimitive,
  attachSession as attachSessionPrimitive,
  delegate as delegatePrimitive,
  acceptDelegation,
  type Authority,
  type Delegation,
  type SessionInput,
  type SessionHandle,
  type DelegateInput,
} from './primitives.js'
import {
  createDelegation,
  getInboundDelegation,
  revokeDelegation,
  startCoordinatorSession,
  terminateSession,
  type CoordinatorCallEvent,
  type CoordinatorClient,
  type DelegationConstraints,
  type DelegationResponse,
} from './coordinator.js'
import type { JsonObject } from './json.js'
import { CaracalError, OAuthClient, isApprovalRequired, type ApprovalState, type OAuthEvent } from '@caracalai/oauth'
const DEFAULT_STS_URL = 'http://localhost:8080'
const DEFAULT_COORDINATOR_URL = 'http://localhost:4000'
const DEFAULT_GATEWAY_URL = 'http://localhost:8081'
const LIFECYCLE_SCOPE = 'agent:lifecycle'
const APP_MANDATE_TTL_SECONDS = 900
const APP_AUTHORITY_REFRESH_MARGIN_SECONDS = 60
// Each authority entry owns two coordinator sessions. Nineteen entries leave
// room for ten ordinary sessions and the next two-session provisioning cycle.
const APP_AUTHORITY_CACHE_CAP = 19
const APP_SESSION_TTL_BUFFER_SECONDS = 120
const CREDENTIAL_FINGERPRINT_KEY = randomBytes(32)

interface AppAuthorityEntry {
  resourceId: string
  zoneId: string
  applicationId: string
  credentialGeneration: string
  targetSessionId: string
  delegationId: string
  expiresAt: number
  sessions: string[]
}

export interface ResourceBinding {
  resourceId: string
  upstreamPrefix: string
}

export type TokenSource = () => string | Promise<string>

/** The credential triple a client-secret client acts as. */
export interface ClientCredentials {
  zoneId: string
  applicationId: string
  clientSecret: string
}

/**
 * Resolves the current client credentials at each control-plane operation, so
 * a secret rotated by a secrets manager or a credential provisioned after the
 * process started is simply presented on the next exchange - the client is
 * never rebuilt. Returning null or undefined means no usable credential exists
 * yet; the operation fails closed with CredentialsUnavailableError.
 */
export type CredentialsResolver = () => ClientCredentials | null | undefined | Promise<ClientCredentials | null | undefined>

/** A control-plane operation ran while the credentials resolver had no usable credential; the operation fails closed. */
export class CredentialsUnavailableError extends Error {
  constructor() {
    super('Caracal credentials are unavailable: the credentials resolver returned no usable credential')
    this.name = 'CredentialsUnavailableError'
  }
}

/** A minted scoped mandate and the lifetime the STS granted it. */
export interface MintedMandate {
  token: string
  expiresInSeconds: number
}

/** A federated Subject and the mandate proving it. */
export interface FederatedSubject {
  /** Anchors Coordinator attribution when passed as subjectAuthorityRecordId; it does not alone propagate the user sub to later mints. */
  subjectAuthorityRecordId: string
  /** The Subject mandate used for user-facing flows; it carries no resource authority. */
  token: string
  expiresInSeconds: number
}

/**
 * Client-secret credential surface behind a configured Caracal client:
 * resolves the acting identity, invalidates the cached lifecycle token after
 * a server-side rejection, and mints scoped resource mandates for gateway
 * calls. Integrators never construct one: `fromClientSecret` (and profile or
 * environment detection) wires it into the client; the interface exists so
 * the credential surface can be observed and faked in tests.
 */
export interface ClientSecretExchanger {
  invalidate(): void
  /** The zone and application the credentials currently resolve to; fails closed when unresolved. */
  identity(): Promise<{ zoneId: string; applicationId: string; credentialGeneration?: string }>
  mintMandate(
    resourceId: string,
    scopes: string[],
    opts?: { sessionId?: string; delegationId?: string; ttlSeconds?: number; approvalId?: string; signal?: AbortSignal; cache?: boolean },
  ): Promise<MintedMandate>
  /** Exchanges an end user's external identity token for a Subject mandate; never cached. */
  federateSubject(idToken: string, opts?: { ttlSeconds?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<MintedMandate>
  waitForApproval(approvalId: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ApprovalState>
  /** Attaches the observability sink token-exchange events report to. */
  onEvent(cb: (event: OAuthEvent) => void): void
}

export interface CaracalConfig {
  coordinator: CoordinatorClient
  /** Static identity; omitted for a credentials-resolver client, which resolves it through the exchanger per operation. */
  zoneId?: string
  applicationId?: string
  subjectToken?: string
  tokenSource?: TokenSource
  exchanger?: ClientSecretExchanger
  gatewayUrl?: string
  resources?: ResourceBinding[]
  /** Default TTL for sessions run with session(); a session started with startSession lives by its heartbeat lease instead. */
  defaultTtlSeconds?: number
  /** Receives SDK operational warnings (lease loss, cleanup failures, boundary misconfiguration); defaults to console.warn. */
  logger?: (message: string, err?: unknown) => void
}

export interface SessionOptions {
  authority?: Authority
  ttlSeconds?: number
  /** Authority record attached to the Session for Coordinator attribution; it does not alone propagate the user sub to later mints. */
  subjectAuthorityRecordId?: string
  /** Federated Subject mandate proving control of subjectAuthorityRecordId. */
  subjectAuthorityRecordToken?: string
  /** Session to parent under; defaults to the session bound on the calling context. */
  parentSessionId?: string
  /** What this session is for, in operator terms; recorded as metadata.task and shown wherever the session is inspected. */
  task?: string
  metadata?: JsonObject
  /** Role labels the zone's grant policy matches (`input.principal.labels`); descriptive for policy and audit, never grants. */
  labels?: string[]
  /** W3C trace id (32 lowercase hex characters) to correlate the session under; generated when absent. */
  traceId?: string
  /**
   * Optional stable operation identifier from a queue, webhook, workflow, or scheduler.
   * Reusing it with the same inputs replays the Coordinator's session-creation result;
   * changed inputs fail with a conflict. It does not suppress this callback or make
   * downstream side effects exactly once. Ordinary code should omit it.
   */
  idempotencyKey?: string
  signal?: AbortSignal
}

export interface StartSessionOptions {
  authority?: Authority
  /** Authority record attached to the Session for Coordinator attribution; it does not alone propagate the user sub to later mints. */
  subjectAuthorityRecordId?: string
  /** Federated Subject mandate proving control of subjectAuthorityRecordId. */
  subjectAuthorityRecordToken?: string
  /** Session to parent under; defaults to the session bound on the calling context. */
  parentSessionId?: string
  /** What this session is for, in operator terms; recorded as metadata.task and shown wherever the session is inspected. */
  task?: string
  metadata?: JsonObject
  /** Role labels the zone's grant policy matches (`input.principal.labels`); descriptive for policy and audit, never grants. */
  labels?: string[]
  /** W3C trace id (32 lowercase hex characters) to correlate the session under; generated when absent. */
  traceId?: string
  /** Optional stable operation identifier; see SessionOptions.idempotencyKey for its creation-only guarantee. */
  idempotencyKey?: string
  /**
   * Auto-heartbeat cadence. Leave unset to derive it from the server lease;
   * a positive value fixes the interval; zero or a negative value disables
   * the background timer, leaving the lease to manual heartbeat calls.
   */
  heartbeatIntervalMs?: number
  /** Called once if the coordinator reports the session permanently gone. */
  onLeaseLost?: (err: unknown) => void
  /** Called when the coordinator reports a different service-session state. */
  onStateChange?: (status: string) => void
  signal?: AbortSignal
}

export interface DelegateOptions {
  toSessionId: string
  toApplicationId: string
  resourceId?: string
  scopes: string[]
  constraints?: DelegationConstraints
  ttlSeconds: number
  signal?: AbortSignal
}

export type LifecycleHook = (ctx: CaracalContext) => void | Promise<void>

/**
 * One delegation presentation by this client. Emitted whenever
 * acceptDelegation binds a delegation - and with `ok: false` when an
 * up-front validation rejects it - so a forensic consumer can correlate
 * which workload presented which delegation on which session.
 */
export interface DelegationAcceptEvent {
  type: 'delegation.accept'
  delegationId: string
  sessionId?: string
  validated: boolean
  ok: boolean
  durationMs: number
}

/** Control-plane operation reported to onEvent subscribers: a token exchange, an approval wait, a coordinator call, or a delegation acceptance. */
export type CaracalEvent = OAuthEvent | CoordinatorCallEvent | DelegationAcceptEvent

export type EventHook = (event: CaracalEvent) => void

/** Identity selection for calls made outside a bound session context. */
export interface CallOptions {
  /** Run the call as the application's own identity instead of a bound session; explicit opt-in. */
  asApplication?: boolean
}

/**
 * Transport behavior options. `scopes` mints the scoped `use=gateway`
 * mandate required by gateway-routed requests for the routed resource and
 * bound session identity; requires a client-secret
 * configuration. `timeoutMs` bounds every request the transport sends when
 * the caller supplies no signal of its own (combined when both are present).
 * `propagation` controls where the context envelope (traceparent, baggage)
 * is written: 'gateway-only' (the default) keeps Caracal correlation ids off
 * third-party hosts; 'always' explicitly propagates to every host for a known
 * Caracal-aware service chain.
 */
export interface TransportOptions extends CallOptions {
  scopes?: string[]
  approvalId?: string
  timeoutMs?: number
  propagation?: 'always' | 'gateway-only'
}

/** Optional mint inputs: a TTL override, the approval id for retrying an approval-gated mint, an explicit context, and an abort signal. */
export interface MandateOptions {
  ttlSeconds?: number
  approvalId?: string
  ctx?: CaracalContext
  signal?: AbortSignal
}

/**
 * Application transport behavior. `scopes` is the authority every request
 * presents; `labels` mark the sessions each mint cycle starts and are the
 * role labels the zone's grant policy matches - unset, they default to the
 * application id, the same default role `ensureGrants` authors, so a grant
 * and its transport align without either naming a role; `mandateTtlSeconds`
 * bounds each minted mandate (the backing sessions outlive it by a small
 * buffer). `timeoutMs` bounds provisioning, the final mint, and dispatch.
 */
export interface ApplicationTransportOptions {
  scopes: string[]
  approvalId?: string
  labels?: string[]
  mandateTtlSeconds?: number
  timeoutMs?: number
}

export interface BindOptions extends CallOptions {
  verify?: (token: string) => VerifiedClaims | Promise<VerifiedClaims>
  /** Trust unsigned propagation because an upstream boundary already verified the request. */
  trustedPropagation?: boolean
}

interface ClientOptions {
  coordinatorUrl: string
  stsUrl: string
  zoneId?: string
  applicationId?: string
  clientSecret?: string
  credentials?: CredentialsResolver
  /**
   * Resources this client mints lifecycle tokens for and routes through the
   * Gateway. Optional for a client that only runs application transports,
   * which mint per resource; session and lifecycle paths require at least one.
   */
  resources?: Array<string | ResourceBinding>
  gatewayUrl?: string
  scope?: string
  /** Seeds CaracalConfig.defaultTtlSeconds for sessions run with session(). */
  defaultTtlSeconds?: number
  fetchImpl?: typeof fetch
}

export interface ClientSecretOptions {
  coordinatorUrl: string
  stsUrl: string
  zoneId: string
  applicationId: string
  clientSecret: string
  resources?: Array<string | ResourceBinding>
  gatewayUrl?: string
  defaultTtlSeconds?: number
  fetchImpl?: typeof fetch
}

export interface GatewayTarget {
  url: string
  headers: Record<string, string>
}

export class Caracal {
  readonly config: CaracalConfig
  private sessionStartHooks: LifecycleHook[] = []
  private sessionEndHooks: LifecycleHook[] = []
  private eventHooks: EventHook[] = []
  private appAuthorities = new Map<string, AppAuthorityEntry>()
  private appInflight = new Map<string, Promise<AppAuthorityEntry>>()
  private appGeneration = 0
  private appProvisionTail: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * Creates a Caracal client from `CARACAL_CONFIG` when set, otherwise from
   * `CARACAL_*` environment variables. No implicit profile paths are read.
   */
  constructor(config: CaracalConfig = detectConfig(process.env)) {
    if ((config.subjectToken === undefined) === (config.tokenSource === undefined)) {
      throw new Error('CaracalConfig requires exactly one of subjectToken or tokenSource')
    }
    if (!config.exchanger && (!config.zoneId || !config.applicationId)) {
      throw new Error('CaracalConfig requires zoneId and applicationId')
    }
    this.config = {
      ...config,
      coordinator: { ...config.coordinator, onEvent: (e) => this.emitEvent(e) },
      ...(config.resources && config.resources.length > 1 ? { resources: sortBindingsLongestFirst(config.resources) } : {}),
    }
    this.config.exchanger?.onEvent((e) => this.emitEvent(e))
  }

  static fromClientSecret(opts: ClientSecretOptions): Caracal {
    return new Caracal(configFromClientSecret(opts))
  }

  /**
   * Releases client-held state: cached application mandates and their
   * in-flight mint cycles are dropped, the credential exchanger's cached
   * lifecycle token is invalidated, and the sessions backing released
   * application transports are terminated best-effort; closing is terminal.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    ++this.appGeneration
    const pending = [...this.appInflight.values()]
    const entries = [...this.appAuthorities.values()].filter((entry) => entry.sessions.length)
    this.appAuthorities.clear()
    if (pending.length) await Promise.allSettled(pending)
    const exchanger = this.config.exchanger
    if (exchanger && entries.length) {
      try {
        const identity = await exchanger.identity()
        const bootstrap = (await exchanger.mintMandate(entries[0].resourceId, [LIFECYCLE_SCOPE])).token
        const sessions = entries.flatMap((entry) => entry.sessions)
        await Promise.allSettled(sessions.map((id) => terminateSession(this.config.coordinator, bootstrap, identity.zoneId, id)))
      } catch (err) {
        this.warnLog('caracal: close could not retire application-transport sessions; the coordinator TTL sweeper will', err)
      }
    }
    exchanger?.invalidate()
  }

  private warnLog(message: string, err?: unknown): void {
    const sink = this.config.logger ?? defaultWarn
    sink(message, err)
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Caracal client is closed')
  }

  /**
   * The zone and application this client acts as: the static configuration
   * when present, otherwise resolved through the credentials source, which
   * fails closed while no usable credential exists. Useful for logging and
   * metric labels.
   */
  async identity(): Promise<{ zoneId: string; applicationId: string }> {
    this.ensureOpen()
    const { zoneId, applicationId, exchanger } = this.config
    if (zoneId && applicationId) return { zoneId, applicationId }
    return exchanger!.identity()
  }

  /**
   * Run fn inside a governed session: a bounded identity Caracal establishes
   * around whatever fn executes - an AI agent step, a job, a tool call, any
   * code. The session binds delegated authority, records audit attribution,
   * and is retired when fn returns. Pass `authority: Authority.narrow([...])`
   * to bound the session to a subset of the caller's scopes.
   *
   * @example
   * ```ts
   * const summary = await caracal.session(async (ctx) => {
   *   log.info({ sessionId: ctx.sessionId }, 'triage run started'); return triageTickets()
   * }, { labels: ['ticket-triage'] })
   * ```
   *
   * @example Narrowed child session
   * ```ts
   * await caracal.session(work, {
   *   authority: Authority.narrow(['tickets:read'], {
   *     resourceId: 'resource://pipernet',
   *     ttlSeconds: 600,
   *   }),
   * })
   * ```
   */
  async session<T>(fn: (ctx: CaracalContext) => Promise<T>, opts: SessionOptions = {}): Promise<T> {
    const identity = await this.identity()
    const input: SessionInput = {
      coordinator: this.config.coordinator,
      zoneId: identity.zoneId,
      applicationId: identity.applicationId,
      subjectToken: await this.rootToken(),
      tokenSource: this.config.tokenSource,
      invalidate: this.invalidate(),
      authority: opts.authority,
      ttlSeconds: opts.ttlSeconds ?? this.config.defaultTtlSeconds,
      subjectAuthorityRecordId: opts.subjectAuthorityRecordId,
      subjectAuthorityRecordToken: opts.subjectAuthorityRecordToken,
      parentSessionId: opts.parentSessionId,
      metadata: taskMetadata(opts),
      labels: opts.labels,
      traceId: opts.traceId,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
      warn: this.config.logger,
      onSessionStart: this.sessionStartHooks.length ? (c) => this.fire(this.sessionStartHooks, c) : undefined,
      onSessionEnd: this.sessionEndHooks.length ? (c) => this.fire(this.sessionEndHooks, c) : undefined,
    }
    return await sessionPrimitive(input, fn)
  }

  /**
   * Start a governed session that outlives a block: the returned handle keeps
   * the session's lease renewed and the holder retires it with close.
   */
  async startSession(opts: StartSessionOptions = {}): Promise<SessionHandle> {
    const identity = await this.identity()
    return await startSessionPrimitive({
      coordinator: this.config.coordinator,
      zoneId: identity.zoneId,
      applicationId: identity.applicationId,
      subjectToken: await this.rootToken(),
      tokenSource: this.config.tokenSource,
      invalidate: this.invalidate(),
      subjectAuthorityRecordId: opts.subjectAuthorityRecordId,
      subjectAuthorityRecordToken: opts.subjectAuthorityRecordToken,
      parentSessionId: opts.parentSessionId,
      authority: opts.authority,
      metadata: taskMetadata(opts),
      labels: opts.labels,
      traceId: opts.traceId,
      idempotencyKey: opts.idempotencyKey,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      onLeaseLost: opts.onLeaseLost,
      onStateChange: opts.onStateChange,
      signal: opts.signal,
      warn: this.config.logger,
      onSessionStart: this.sessionStartHooks.length ? (c) => this.fire(this.sessionStartHooks, c) : undefined,
      onSessionEnd: this.sessionEndHooks.length ? (c) => this.fire(this.sessionEndHooks, c) : undefined,
    })
  }

  /**
   * Delegate a slice of the current session's authority to an existing peer
   * session and return the created delegation. The receiving session accepts
   * it with acceptDelegation.
   */
  delegate(opts: DelegateOptions): Promise<Delegation> {
    this.ensureOpen()
    const input: DelegateInput = {
      coordinator: this.config.coordinator,
      toSessionId: opts.toSessionId,
      toApplicationId: opts.toApplicationId,
      resourceId: opts.resourceId,
      scopes: opts.scopes,
      constraints: opts.constraints,
      ttlSeconds: opts.ttlSeconds,
      signal: opts.signal,
    }
    return delegatePrimitive(input)
  }

  /** Revoke a Delegation issued by this application. */
  async revokeDelegation(delegationId: string, signal?: AbortSignal): Promise<void> {
    const ctx = current()
    const identity = await this.identity()
    await revokeDelegation(
      this.config.coordinator,
      ctx ? await contextBearer(ctx) : await this.rootToken(),
      identity.zoneId,
      delegationId,
      signal,
    )
  }

  /**
   * Run fn under a delegation received from a peer: the current session
   * context is rebound so token exchanges inside fn present the delegation.
   * Acceptance is local; the STS re-validates the delegation on every mint,
   * so a wrong or revoked id fails at first use. Pass `{ validate: true }`
   * to check the delegation up front instead: the coordinator's inbound
   * listing for this session must hold it live, so a mistyped or already
   * revoked id fails here with a targeted error.
   */
  async acceptDelegation<T>(delegationId: string, fn: () => Promise<T>, opts: { validate?: boolean } = {}): Promise<T> {
    this.ensureOpen()
    const ctx = current()
    if (!ctx) throw new Error('acceptDelegation requires a Caracal context bound on this path')
    const start = performance.now()
    const emit = (ok: boolean) =>
      this.emitEvent({
        type: 'delegation.accept',
        delegationId,
        sessionId: ctx.sessionId,
        validated: opts.validate === true,
        ok,
        durationMs: performance.now() - start,
      })
    if (opts.validate) {
      if (!ctx.sessionId) throw new Error('acceptDelegation validation requires an active session in context')
      let match
      try {
        match = await getInboundDelegation(this.config.coordinator, await contextBearer(ctx), ctx.zoneId, ctx.sessionId, delegationId)
      } catch {
        emit(false)
        throw new Error(
          `acceptDelegation: delegation ${delegationId} is not live for session ${ctx.sessionId}; confirm the issuer created it for this session and it has not been revoked`,
        )
      }
      if (match.status !== 'active') {
        emit(false)
        throw new Error(
          `acceptDelegation: delegation ${delegationId} is not live for session ${ctx.sessionId}; confirm the issuer created it for this session and it has not been revoked`,
        )
      }
    }
    emit(true)
    return bind(acceptDelegation(ctx, delegationId), fn)
  }

  /**
   * Re-attach to a service session that already exists - typically after a
   * process restart, using a session id the previous holder persisted (for
   * example from SessionHandle.sessionId). The session is validated with an
   * immediate lease renewal, and the returned handle renews and retires it
   * exactly like one from startSession.
   */
  async attachSession(
    sessionId: string,
    opts: {
      heartbeatIntervalMs?: number
      onLeaseLost?: (err: unknown) => void
      onStateChange?: (status: string) => void
      signal?: AbortSignal
    } = {},
  ): Promise<SessionHandle> {
    const identity = await this.identity()
    return await attachSessionPrimitive({
      coordinator: this.config.coordinator,
      zoneId: identity.zoneId,
      applicationId: identity.applicationId,
      subjectToken: await this.rootToken(),
      tokenSource: this.config.tokenSource,
      invalidate: this.invalidate(),
      sessionId,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      onLeaseLost: opts.onLeaseLost,
      onStateChange: opts.onStateChange,
      signal: opts.signal,
      warn: this.config.logger,
      onSessionEnd: this.sessionEndHooks.length ? (c) => this.fire(this.sessionEndHooks, c) : undefined,
    })
  }

  bind<T>(ctx: CaracalContext, fn: () => Promise<T>): Promise<T> {
    this.ensureOpen()
    return bind(ctx, fn)
  }

  onSessionStart(cb: LifecycleHook): () => void {
    this.sessionStartHooks.push(cb)
    return () => {
      const index = this.sessionStartHooks.indexOf(cb)
      if (index !== -1) this.sessionStartHooks.splice(index, 1)
    }
  }

  onSessionEnd(cb: LifecycleHook): () => void {
    this.sessionEndHooks.push(cb)
    return () => {
      const index = this.sessionEndHooks.indexOf(cb)
      if (index !== -1) this.sessionEndHooks.splice(index, 1)
    }
  }

  /**
   * Subscribes to control-plane operation events: token exchanges (with cache
   * outcome), approval waits, and coordinator calls, each carrying outcome and
   * duration. Bridge them to any metrics or tracing system; a hook that throws
   * is ignored and never disturbs the operation that emitted the event.
   * Returns a disposer that unsubscribes the hook.
   */
  onEvent(cb: EventHook): () => void {
    this.eventHooks.push(cb)
    return () => {
      const index = this.eventHooks.indexOf(cb)
      if (index !== -1) this.eventHooks.splice(index, 1)
    }
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
   * refreshed own-credential token use headersAsync. Calling as the
   * application's own identity requires `{ asApplication: true }`.
   */
  headers(opts: CallOptions = {}): Record<string, string> {
    this.ensureOpen()
    const ctx = current()
    if (!ctx) {
      if (!opts.asApplication) {
        throw new Error(
          "Caracal.headers(): no Caracal session context is bound. Pass { asApplication: true } to call as the application's own identity.",
        )
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
   * Async variant of headers. For contexts this process established from its
   * own credentials, the bearer is resolved fresh through the token source so
   * long-lived holders never present an expired token; inbound contexts stay
   * pinned to the caller's token.
   */
  async headersAsync(opts: CallOptions = {}): Promise<Record<string, string>> {
    this.ensureOpen()
    const ctx = current()
    if (!ctx) {
      if (!opts.asApplication) {
        throw new Error(
          "Caracal.headersAsync(): no Caracal session context is bound. Pass { asApplication: true } to call as the application's own identity.",
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
    headers: Headers | Record<string, string | string[] | undefined> | HeaderGetter,
    fn: () => Promise<T>,
    opts: BindOptions = {},
  ): Promise<T> {
    this.ensureOpen()
    if (opts.verify && opts.trustedPropagation) {
      throw new Error('Caracal.bindFromHeaders(): choose either verify or trustedPropagation, not both')
    }
    const env =
      typeof headers === 'function'
        ? decodeEnvelope(headers)
        : headers instanceof Headers
          ? decodeEnvelope((n) => headers.get(n) ?? undefined)
          : fromHeaders(headers)
    let claims: VerifiedClaims | undefined
    let rootInjected = false
    if (env.subjectToken && !opts.verify && !opts.trustedPropagation && productionEnv(process.env)) {
      throw new Error(
        'Caracal.bindFromHeaders(): production ingress requires { verify } or { trustedPropagation: true } when an upstream boundary already verified the request',
      )
    }
    if (!env.subjectToken) {
      if (!opts.asApplication) {
        throw new Error(
          "Caracal.bindFromHeaders(): inbound request is missing a bearer token. Pass { asApplication: true } only for trusted ingress that should run as the application's own identity.",
        )
      }
      env.subjectToken = await this.rootToken()
      env.sessionId = undefined
      env.delegationId = undefined
      env.parentDelegationId = undefined
      env.subjectAuthorityRecordId = undefined
      env.hop = 0
      rootInjected = true
    } else if (opts.verify) {
      const verified = await opts.verify(env.subjectToken)
      if (!verified) throw new Error('Caracal.bindFromHeaders(): verify must return complete VerifiedClaims')
      claims = verified
    }
    const ctx = claims ? fromVerifiedEnvelope(env as Envelope, claims) : fromEnvelope(env as Envelope, await this.identity())
    return await bind(rootInjected ? { ...ctx, ownToken: true } : ctx, fn)
  }

  /**
   * Returns a fetch-shaped function that injects the Caracal context envelope
   * (traceparent, tracestate, baggage) onto outbound requests, merging with any
   * headers the caller or an OpenTelemetry SDK already set. The bearer is
   * attached only to gateway-routed calls, where the Gateway terminates it at
   * the trust boundary: a scoped mandate when `scopes` is set, or an already
   * gateway-class context token. Lifecycle and resource tokens fail locally.
   * No default timeout is applied unless `timeoutMs` is set; a caller-supplied
   * `init.signal` still applies (combined when both are present). Pass to any
   * provider SDK that accepts a custom fetch.
   *
   * @example Hand the transport to a provider SDK
   * ```ts
   * const openai = new OpenAI({
   *   baseURL: 'https://api.pipernet.example/v1',
   *   apiKey: 'unused-gateway-injects-credentials',
   *   fetch: caracal.transport({ scopes: ['chat:complete'] }),
   * })
   * ```
   */
  transport(opts: TransportOptions = {}): typeof fetch {
    this.ensureOpen()
    const outer = this
    const appAllowed = opts.asApplication === true
    const scopes = opts.scopes
    const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      outer.ensureOpen()
      const ctx = current()
      if (!ctx && !appAllowed) {
        throw new Error(
          "Caracal.transport(): no Caracal session context is bound. Pass { asApplication: true } to call as the application's own identity.",
        )
      }
      const request = input instanceof Request ? input : undefined
      if (request?.bodyUsed) throw new TypeError('Caracal.transport(): cannot send a Request whose body was already consumed')
      const merged = new Headers(request?.headers)
      if (init?.headers) new Headers(init.headers).forEach((value, key) => merged.set(key, value))
      const fetchImpl = outer.config.coordinator.fetchImpl ?? fetch
      const explicitResource = merged.get('X-Caracal-Resource') ?? undefined
      const rewritten = outer.routeThroughGateway(input, explicitResource)
      const gatewayBound = rewritten !== null || outer.targetsGateway(input)
      if (opts.propagation === 'always' || gatewayBound) {
        const env: Envelope = ctx ? toEnvelope(ctx) : { hop: 0 }
        encodeEnvelope(
          env,
          (k, v) => merged.set(k, v),
          (k) => merged.get(k) ?? undefined,
        )
      }
      let signal = init?.signal ?? request?.signal
      if (opts.timeoutMs) {
        const timeout = AbortSignal.timeout(opts.timeoutMs)
        signal = signal ? AbortSignal.any([signal, timeout]) : timeout
      }
      const bounded = { ...init, signal, headers: merged, ...(gatewayBound ? { redirect: 'manual' as const } : {}) }
      if (rewritten) {
        merged.set('X-Caracal-Resource', rewritten.resourceId)
        merged.set('Authorization', `Bearer ${await outer.gatewayToken(ctx, rewritten.resourceId, scopes, opts.approvalId, signal)}`)
        return fetchImpl(request ? new Request(rewritten.url, new Request(request, bounded)) : rewritten.url, bounded)
      }
      if (gatewayBound) {
        merged.set('Authorization', `Bearer ${await outer.gatewayToken(ctx, explicitResource, scopes, opts.approvalId, signal)}`)
      }
      return fetchImpl(request ? new Request(request, bounded) : (input as URL), request ? undefined : bounded)
    }) as typeof fetch
    return fn
  }

  /**
   * Resolves the bearer for a gateway-bound request: a scoped mandate when
   * scopes are set and the routed resource is known, or an existing
   * gateway-class context token. Other token classes fail before dispatch.
   */
  private async gatewayToken(
    ctx: CaracalContext | undefined,
    resourceId: string | undefined,
    scopes: string[] | undefined,
    approvalId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (scopes?.length && !resourceId) {
      throw new Error('Caracal.transport(): scopes require X-Caracal-Resource or a configured resource binding')
    }
    if (scopes?.length && resourceId) {
      const exchanger = this.config.exchanger
      if (!exchanger) throw new Error('Caracal.transport(): scopes require a client-secret configuration')
      try {
        const minted = await exchanger.mintMandate(resourceId, scopes, {
          sessionId: ctx?.sessionId,
          delegationId: ctx?.delegationId,
          approvalId,
          signal,
          cache: false,
        })
        return minted.token
      } catch (err) {
        throw lifecycleAuthorityHint(err, ctx)
      }
    }
    const token = !ctx
      ? await this.rootToken()
      : ctx.ownToken && this.config.tokenSource
        ? await this.config.tokenSource()
        : ctx.subjectToken
    const use = decodeJwtPayload(token)?.use
    if (typeof use === 'string' && use !== 'gateway') {
      throw new Error(
        `Caracal.transport(): Gateway calls require a scoped use=gateway mandate; received use=${use}. Pass scopes with a delegated session, or use applicationTransport() for application-owned work.`,
      )
    }
    return token
  }

  /**
   * Mints a scoped mandate narrowed to `resourceId` and `scopes`. A bound
   * Session and Delegation produce an uncached, one-shot `use=gateway`
   * mandate. Application-principal lifecycle calls produce a reusable
   * `use=session` mandate that may be cached and refreshed before expiry.
   * The STS evaluates policy against the bound authority.
   *
   * When a scope is approval-gated this throws ApprovalRequiredError; retry
   * with `approvalId` set to the returned approval id once an authenticated
   * approver has satisfied it. Requires a client-secret configuration.
   */
  async mintMandate(resourceId: string, scopes: string[], opts: MandateOptions = {}): Promise<MintedMandate> {
    this.ensureOpen()
    const exchanger = this.config.exchanger
    if (!exchanger) throw new Error('Caracal.mintMandate(): requires a client-secret configuration')
    const ctx = opts.ctx ?? current()
    try {
      return await exchanger.mintMandate(resourceId, scopes, {
        sessionId: ctx?.sessionId,
        delegationId: ctx?.delegationId,
        ttlSeconds: opts.ttlSeconds,
        approvalId: opts.approvalId,
        signal: opts.signal,
      })
    } catch (err) {
      throw lifecycleAuthorityHint(err, ctx)
    }
  }

  /**
   * Exchange an end user's identity token from a zone-trusted external issuer
   * for the Subject's Caracal Authority record. The returned subjectAuthorityRecordId
   * anchors governed work to that user (`session(fn, { subjectAuthorityRecordId })`),
   * and the returned token is the user's own mandate for user-facing flows
   * such as approval decisions. Never cached: each federation is an explicit
   * identity event, recorded in the audit stream. Requires a client-secret
   * configuration and a subject issuer registered on the zone.
   */
  async federateSubject(
    idToken: string,
    opts: { ttlSeconds?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<FederatedSubject> {
    this.ensureOpen()
    const exchanger = this.config.exchanger
    if (!exchanger) throw new Error('Caracal.federateSubject(): requires a client-secret configuration')
    const minted = await exchanger.federateSubject(idToken, opts)
    const authorityRecordId = decodeJwtPayload(minted.token)?.sid
    if (typeof authorityRecordId !== 'string' || !authorityRecordId) {
      throw new Error('Caracal.federateSubject(): the minted Subject mandate carries no authority record ID')
    }
    return { subjectAuthorityRecordId: authorityRecordId, token: minted.token, expiresInSeconds: minted.expiresInSeconds }
  }

  /**
   * Long-polls an approval until an approver decides it, it
   * expires, or the timeout elapses. Returns the final lifecycle state:
   * 'approved' means retrying the mint with `approvalId` set will succeed;
   * 'rejected', 'expired', and 'consumed' are terminal; 'pending' means the
   * timeout elapsed with no decision and waiting again is safe. Pass `signal`
   * to abort the wait early.
   */
  waitForApproval(approvalId: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ApprovalState> {
    this.ensureOpen()
    const exchanger = this.config.exchanger
    if (!exchanger) throw new Error('Caracal.waitForApproval(): requires a client-secret configuration')
    return exchanger.waitForApproval(approvalId, opts)
  }

  /**
   * Runs an approval-gated operation end to end. fn is invoked once; when it
   * throws ApprovalRequiredError the client long-polls the approval and, on
   * approval, invokes fn again with the approval id so the retried mint
   * consumes the decision. Any other outcome (rejected, expired, consumed, or
   * the wait timing out) rethrows the original ApprovalRequiredError, whose
   * approvalId lets the caller resume the wait later.
   *
   * @example
   * ```ts
   * const mandate = await caracal.withApproval((approvalId) =>
   *   caracal.mintMandate('resource://pipernet', ['funds:transfer'], { approvalId }),
   * )
   * ```
   */
  async withApproval<T>(fn: (approvalId?: string) => Promise<T>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    this.ensureOpen()
    try {
      return await fn()
    } catch (err) {
      if (!isApprovalRequired(err)) throw err
      const state = await this.waitForApproval(err.approvalId, opts)
      if (state !== 'approved') throw err
      return await fn(err.approvalId)
    }
  }

  gatewayRequest(resourceId: string, path: string = '/'): GatewayTarget {
    this.ensureOpen()
    if (!this.config.gatewayUrl) throw new Error('Caracal.gatewayRequest(): gatewayUrl is not configured')
    if (!resourceId.trim()) throw new Error('Caracal.gatewayRequest(): resourceId is required')
    return {
      url: joinGatewayPath(this.config.gatewayUrl, path),
      headers: { 'X-Caracal-Resource': resourceId },
    }
  }

  /**
   * One-call happy path: sends `init` to `path` on the given resource through the
   * Gateway with Caracal context and authority injected. Accepts the transport
   * options inline: pass `scopes` to authorize with a scoped resource mandate and
   * `asApplication` to call as the application's own identity. The resource header
   * always wins over any caller-supplied `X-Caracal-Resource`. No default timeout
   * is applied; pass `signal` (e.g. AbortSignal.timeout) to bound a call.
   */
  fetch(resourceId: string, path: string = '/', init: RequestInit & TransportOptions = {}): Promise<Response> {
    const { scopes, approvalId, asApplication, timeoutMs, propagation, ...rest } = init
    const request = this.gatewayRequest(resourceId, path)
    const headers = new Headers(rest.headers ?? {})
    for (const [key, value] of Object.entries(request.headers)) headers.set(key, value)
    return this.transport({ scopes, approvalId, asApplication, timeoutMs, propagation })(request.url, { ...rest, headers })
  }

  /**
   * A fetch pinned to one resource, running as the application's own
   * identity rather than a bound session context: each mint cycle bootstraps
   * a lifecycle token, starts a source/target session pair, narrows the
   * target to `scopes` on the resource over a delegation, and mints a fresh
   * single-use mandate for every request. Authority cycles are cached per
   * resolved identity, resource, scope set, effective labels, and mandate
   * TTL, then re-provisioned on a fresh session pair before expiry; sessions from
   * a failed cycle are terminated best-effort. Requests already addressed to
   * the Gateway pass through unchanged; other absolute URLs are rewritten
   * onto it. When a scope is approval-gated the request rejects with
   * ApprovalRequiredError. Requires a client-secret configuration.
   *
   * Provisioning costs four control-plane calls (bootstrap mint, two session
   * Session starts, one Delegation) roughly once per TTL. Every Gateway request then
   * performs one uncached final mint so its replay-protected JTI is unique.
   *
   * @example Application-identity LLM transport
   * ```ts
   * const llm = new OpenAI({
   *   baseURL: 'https://api.pipernet.example/v1',
   *   apiKey: 'unused-gateway-injects-credentials',
   *   fetch: caracal.applicationTransport('resource://pipernet', { scopes: ['chat:complete'] }),
   * })
   * ```
   */
  applicationTransport(resourceId: string, opts: ApplicationTransportOptions): typeof fetch {
    this.ensureOpen()
    const exchanger = this.config.exchanger
    if (!exchanger) throw new Error('Caracal.applicationTransport(): requires a client-secret configuration')
    if (!this.config.gatewayUrl)
      throw new Error('Caracal.applicationTransport(): requires gatewayUrl so mandates are sent only to the Gateway')
    if (!resourceId.trim()) throw new Error('Caracal.applicationTransport(): resourceId is required')
    if (!opts.scopes.length) throw new Error('Caracal.applicationTransport(): scopes are required')
    const scopes = [...new Set(opts.scopes)].sort()
    const outer = this
    const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      outer.ensureOpen()
      const request = input instanceof Request ? input : undefined
      if (request?.bodyUsed) throw new TypeError('Caracal.applicationTransport(): cannot send a Request whose body was already consumed')
      let signal = init?.signal ?? request?.signal
      if (opts.timeoutMs) {
        const timeout = AbortSignal.timeout(opts.timeoutMs)
        signal = signal ? AbortSignal.any([signal, timeout]) : timeout
      }
      const authority = await outer.appAuthority(exchanger, resourceId, scopes, opts, signal)
      outer.ensureOpen()
      const minted = await exchanger.mintMandate(resourceId, scopes, {
        sessionId: authority.targetSessionId,
        delegationId: authority.delegationId,
        ttlSeconds: opts.mandateTtlSeconds ?? APP_MANDATE_TTL_SECONDS,
        approvalId: opts.approvalId,
        cache: false,
        signal,
      })
      const merged = new Headers(request?.headers)
      if (init?.headers) new Headers(init.headers).forEach((value, key) => merged.set(key, value))
      merged.set('Authorization', `Bearer ${minted.token}`)
      merged.set('X-Caracal-Resource', resourceId)
      encodeEnvelope(
        { sessionId: authority.targetSessionId, delegationId: authority.delegationId, hop: 0 },
        (key, value) => merged.set(key, value),
        (key) => merged.get(key) ?? undefined,
      )
      const fetchImpl = outer.config.coordinator.fetchImpl ?? fetch
      const rewritten = outer.routeThroughGateway(input, resourceId)
      if (!rewritten) throw new Error('Caracal.applicationTransport(): request could not be pinned to the configured Gateway')
      const requestInit = { ...init, headers: merged, signal, redirect: 'manual' as const }
      return fetchImpl(request ? new Request(rewritten.url, new Request(request, requestInit)) : rewritten.url, requestInit)
    }) as typeof fetch
    return fn
  }

  private async appAuthority(
    exchanger: ClientSecretExchanger,
    resourceId: string,
    scopes: string[],
    opts: ApplicationTransportOptions,
    signal?: AbortSignal,
  ): Promise<AppAuthorityEntry> {
    // The cache key carries the acting identity, so a credential re-provisioned into a
    // different zone or application can never be served a mandate minted for the old one.
    // Labels and TTL also shape the mint cycle, so transports with different
    // attribution or lifetime requirements must not share a cached mandate.
    const identity = await exchanger.identity()
    this.ensureOpen()
    const credentialGeneration = identity.credentialGeneration ?? ''
    const mandateTtl = opts.mandateTtlSeconds ?? APP_MANDATE_TTL_SECONDS
    const labels = opts.labels ?? [identity.applicationId]
    const stale: AppAuthorityEntry[] = []
    const now = Date.now() / 1000
    for (const [cachedKey, entry] of this.appAuthorities) {
      if (
        entry.expiresAt <= now ||
        (entry.zoneId === identity.zoneId &&
          entry.applicationId === identity.applicationId &&
          entry.credentialGeneration !== credentialGeneration)
      ) {
        this.appAuthorities.delete(cachedKey)
        stale.push(entry)
      }
    }
    if (stale.length) await this.retireAppAuthorities(exchanger, stale)
    this.ensureOpen()
    const key = `${identity.zoneId}::${identity.applicationId}::${credentialGeneration}::${resourceId}::${scopes.join(' ')}::${JSON.stringify(labels)}::${mandateTtl}`
    const cached = this.appAuthorities.get(key)
    if (cached && Date.now() / 1000 < cached.expiresAt - APP_AUTHORITY_REFRESH_MARGIN_SECONDS) return cached
    const generation = this.appGeneration
    const inflightKey = `${generation}::${key}`
    const inflight = this.appInflight.get(inflightKey)
    if (inflight) return inflight
    const pending = (async () => {
      try {
        const fresh = await this.withAppProvisioning(signal, () =>
          this.appAuthorityCycle(exchanger, identity, resourceId, scopes, opts, signal),
        )
        if (generation !== this.appGeneration) {
          await this.retireAppAuthorities(exchanger, [fresh])
          return fresh
        }
        this.appAuthorities.set(key, fresh)
        const evicted: AppAuthorityEntry[] = []
        if (this.appAuthorities.size > APP_AUTHORITY_CACHE_CAP) {
          const now = Date.now() / 1000
          for (const [k, entry] of this.appAuthorities) {
            if (entry.expiresAt <= now && k !== key) {
              this.appAuthorities.delete(k)
              evicted.push(entry)
            }
          }
          for (const [k, entry] of this.appAuthorities) {
            if (this.appAuthorities.size <= APP_AUTHORITY_CACHE_CAP) break
            if (k !== key) {
              this.appAuthorities.delete(k)
              evicted.push(entry)
            }
          }
        }
        if (evicted.length) await this.retireAppAuthorities(exchanger, evicted)
        return fresh
      } finally {
        this.appInflight.delete(inflightKey)
      }
    })()
    this.appInflight.set(inflightKey, pending)
    return pending
  }

  private async withAppProvisioning<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = this.appProvisionTail
    let release!: () => void
    this.appProvisionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    if (signal?.aborted) {
      void previous.finally(release)
      throw signal.reason
    }
    let abort: (() => void) | undefined
    try {
      if (signal) {
        await Promise.race([
          previous,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason)
            signal.addEventListener('abort', abort, { once: true })
          }),
        ])
      } else {
        await previous
      }
      return await fn()
    } catch (err) {
      if (signal?.aborted) void previous.finally(release)
      else release()
      throw err
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
      if (!signal?.aborted) release()
    }
  }

  private async appAuthorityCycle(
    exchanger: ClientSecretExchanger,
    identity: { zoneId: string; applicationId: string; credentialGeneration?: string },
    resourceId: string,
    scopes: string[],
    opts: ApplicationTransportOptions,
    signal?: AbortSignal,
  ): Promise<AppAuthorityEntry> {
    const mandateTtl = opts.mandateTtlSeconds ?? APP_MANDATE_TTL_SECONDS
    const sessionTtl = mandateTtl + APP_SESSION_TTL_BUFFER_SECONDS
    const bootstrap = (await exchanger.mintMandate(resourceId, [LIFECYCLE_SCOPE], { signal })).token
    const sessionRequest = {
      zoneId: identity.zoneId,
      applicationId: identity.applicationId,
      labels: opts.labels ?? [identity.applicationId],
      ttlSeconds: sessionTtl,
    }
    const sessions: string[] = []
    try {
      const source = (
        await startCoordinatorSession(
          this.config.coordinator,
          bootstrap,
          { ...sessionRequest, idempotencyKey: crypto.randomUUID() },
          signal,
        )
      ).sessionId
      sessions.push(source)
      const target = (
        await startCoordinatorSession(
          this.config.coordinator,
          bootstrap,
          { ...sessionRequest, idempotencyKey: crypto.randomUUID() },
          signal,
        )
      ).sessionId
      sessions.push(target)
      const edge = await createDelegation(
        this.config.coordinator,
        bootstrap,
        {
          zoneId: identity.zoneId,
          issuerApplicationId: identity.applicationId,
          sourceSessionId: source,
          targetSessionId: target,
          receiverApplicationId: identity.applicationId,
          scopes,
          constraints: { resources: [resourceId] },
          ttlSeconds: sessionTtl,
        },
        signal,
      )
      return {
        resourceId,
        zoneId: identity.zoneId,
        applicationId: identity.applicationId,
        credentialGeneration: identity.credentialGeneration ?? '',
        targetSessionId: target,
        delegationId: edge.delegationId,
        expiresAt: Date.now() / 1000 + sessionTtl,
        sessions,
      }
    } catch (err) {
      await Promise.allSettled(sessions.map((id) => terminateSession(this.config.coordinator, bootstrap, identity.zoneId, id)))
      throw err
    }
  }

  private async retireAppAuthorities(exchanger: ClientSecretExchanger, entries: AppAuthorityEntry[]): Promise<void> {
    if (!entries.length) return
    try {
      const bootstrap = (await exchanger.mintMandate(entries[0].resourceId, [LIFECYCLE_SCOPE])).token
      await Promise.allSettled(
        entries.flatMap((entry) => entry.sessions.map((id) => terminateSession(this.config.coordinator, bootstrap, entry.zoneId, id))),
      )
    } catch (err) {
      this.warnLog('caracal: could not retire application-transport sessions; the coordinator TTL sweeper will', err)
    }
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
    if (pathContainsTraversal(parsed.pathname)) return null
    if (targetsGatewayPath(parsed, gw)) return { url: raw, resourceId: explicitResource ?? '' }
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

  /** Reports whether the request is inside the configured Gateway origin and base path. */
  private targetsGateway(input: RequestInfo | URL): boolean {
    const gw = this.config.gatewayUrl
    if (!gw) return false
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    try {
      return targetsGatewayPath(new URL(raw), gw)
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
    this.ensureOpen()
    if (this.config.subjectToken) return this.config.subjectToken
    throw new Error(
      'Caracal.headers(): this client uses an async token source. Use headersAsync({ asApplication: true }) for application-identity headers.',
    )
  }

  private async rootToken(): Promise<string> {
    this.ensureOpen()
    if (this.config.tokenSource) return await this.config.tokenSource()
    if (this.config.subjectToken) return this.config.subjectToken
    throw new Error('Caracal client has no subject token source')
  }
}

export function createAdvancedClient(config: CaracalConfig): Caracal {
  return new Caracal(config)
}

export function createAdvancedClientFromEnv(env: NodeJS.ProcessEnv): Caracal {
  return new Caracal(configFromEnv(env))
}

export function createAdvancedClientFromConfig(path: string, env: NodeJS.ProcessEnv = process.env): Caracal {
  return new Caracal(configFromProfile(path, env))
}

export function createAdvancedClientFromCredentials(
  opts: Omit<ClientOptions, 'zoneId' | 'applicationId' | 'clientSecret'> & { credentials: CredentialsResolver },
): Caracal {
  return new Caracal(configFromClientSecret(opts))
}

function productionEnv(env: NodeJS.ProcessEnv): boolean {
  return env.CARACAL_ENV === 'production'
}

let insecureConfigWarned = false

function defaultWarn(message: string, err?: unknown): void {
  if (err === undefined) console.warn(message)
  else console.warn(message, err)
}

/**
 * A policy deny for a session that carries no delegation is almost always the
 * lifecycle-only-authority trap: under the platform decision contract,
 * resource mandates only mint over a delegation. Append the remediation so
 * the developer does not need the policy model to decode the deny.
 */
function lifecycleAuthorityHint(err: unknown, ctx: CaracalContext | undefined): unknown {
  if (!(err instanceof CaracalError)) return err
  if (err.code !== 'access_denied') return err
  if (!ctx?.sessionId || ctx.delegationId) return err
  return new CaracalError(
    err.code,
    `${err.message} (hint: the bound session has no delegation, so it holds lifecycle-only authority; narrow the session with Authority.narrow, accept one with acceptDelegation, or call as the application with applicationTransport; decision contract: https://docs.caracal.run/concepts/policy/)`,
    { requestId: err.requestId, httpStatus: err.httpStatus, details: err.details },
  )
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  if (host === '::1' || host === '[::1]') return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

function assertProductionTransport(name: string, value: string | undefined, env: NodeJS.ProcessEnv): void {
  if (!value) return
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Caracal SDK: ${name} is not a valid URL: ${value}`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error(`Caracal SDK: ${name} must be an absolute http or https URL: ${value}`)
  }
  if (!productionEnv(env)) return
  if (env.CARACAL_ALLOW_INSECURE_CONFIG_URLS === 'true') {
    // The override disables the https requirement for the whole control
    // plane, so its presence in production must be loud and unmissable.
    if (!insecureConfigWarned) {
      insecureConfigWarned = true
      defaultWarn(
        'caracal: CARACAL_ALLOW_INSECURE_CONFIG_URLS is active in production; control-plane traffic may travel over plaintext http - remove the override once TLS is in place',
      )
    }
    return
  }
  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return
  throw new Error(
    `Caracal SDK: ${name} must use https in production; http is limited to loopback hosts unless CARACAL_ALLOW_INSECURE_CONFIG_URLS=true`,
  )
}

function serviceUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]
  if (value) return value
  if (productionEnv(env)) throw new Error(`Caracal SDK: ${key} is required in production`)
  return fallback
}

function stsUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return serviceUrl(env, 'CARACAL_STS_URL', DEFAULT_STS_URL)
}

interface ProfileResources {
  resources: Array<string | ResourceBinding>
  bindings?: ResourceBinding[]
}

interface CredentialEntry {
  resource: string
  upstream_prefix?: string
}

function detectConfig(env: NodeJS.ProcessEnv): CaracalConfig {
  const path = env.CARACAL_CONFIG
  if (path) return configFromProfile(path, env)
  return configFromEnv(env)
}

function configFromEnv(env: NodeJS.ProcessEnv): CaracalConfig {
  const url = serviceUrl(env, 'CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const zoneId = env.CARACAL_ZONE_ID
  const applicationId = env.CARACAL_APPLICATION_ID
  const subjectToken = env.CARACAL_BOOTSTRAP_TOKEN
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
  const profileResources = resourcesFromEnv(env)
  const resources = profileResources.bindings
  const defaultTtlSeconds = defaultTtlFromEnv(env)
  if (clientSecret && subjectToken) {
    throw new Error('Caracal: configure exactly one of CARACAL_APP_CLIENT_SECRET and CARACAL_BOOTSTRAP_TOKEN')
  }
  if (clientSecret) {
    return configFromClientSecret(
      {
        coordinatorUrl: url,
        stsUrl,
        zoneId: zoneId!,
        applicationId: applicationId!,
        clientSecret,
        resources: resourceIdsFromEnv(env.CARACAL_APP_RESOURCES, profileResources.resources),
        gatewayUrl,
        defaultTtlSeconds,
      },
      env,
    )
  }
  if (!subjectToken) {
    throw new Error('Caracal.fromEnv: provide CARACAL_APP_CLIENT_SECRET or CARACAL_BOOTSTRAP_TOKEN')
  }
  validateBootstrapToken(subjectToken!)
  assertProductionTransport('CARACAL_COORDINATOR_URL', url, env)
  assertProductionTransport('CARACAL_GATEWAY_URL', gatewayUrl, env)
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

function configFromClientSecret(opts: ClientOptions, env: NodeJS.ProcessEnv = process.env): CaracalConfig {
  const missing = [
    ['coordinatorUrl', opts.coordinatorUrl],
    ['stsUrl', opts.stsUrl],
    ...(opts.credentials
      ? []
      : [
          ['zoneId', opts.zoneId],
          ['applicationId', opts.applicationId],
          ['clientSecret', opts.clientSecret],
        ]),
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) throw new Error(`Caracal.fromClientSecret missing ${missing.join(', ')}`)
  if (opts.credentials && (opts.zoneId ?? opts.applicationId ?? opts.clientSecret) !== undefined) {
    throw new Error('Caracal.fromClientSecret: pass either credentials or the zoneId/applicationId/clientSecret triple, not both')
  }
  if (opts.defaultTtlSeconds !== undefined && (!Number.isInteger(opts.defaultTtlSeconds) || opts.defaultTtlSeconds <= 0)) {
    throw new Error('Caracal.fromClientSecret: defaultTtlSeconds must be a positive integer')
  }
  assertProductionTransport('coordinatorUrl', opts.coordinatorUrl, env)
  assertProductionTransport('stsUrl', opts.stsUrl, env)
  assertProductionTransport('gatewayUrl', opts.gatewayUrl, env)
  const credentials: CredentialsResolver =
    opts.credentials ?? (() => ({ zoneId: opts.zoneId!, applicationId: opts.applicationId!, clientSecret: opts.clientSecret! }))
  const resourceValues = opts.resources ?? []
  for (const value of resourceValues) {
    const resourceId = typeof value === 'string' ? value : value.resourceId
    if (!resourceId.trim()) throw new Error('Caracal.fromClientSecret: resource IDs must be non-empty')
    if (typeof value !== 'string' && !isAbsoluteUrl(value.upstreamPrefix)) {
      throw new Error(`Caracal.fromClientSecret: upstreamPrefix must be an absolute http or https URL: ${value.upstreamPrefix}`)
    }
  }
  const resourceIds = resourceValues.map((value) => (typeof value === 'string' ? value : value.resourceId))
  const bindings = resourceValues.filter((value): value is ResourceBinding => typeof value !== 'string')
  const tokenSource = createClientSecretTokenSource(opts.stsUrl, credentials, resourceIds, opts.scope, opts.fetchImpl)
  return {
    coordinator: { baseUrl: opts.coordinatorUrl, fetchImpl: opts.fetchImpl },
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
  const stsUrl = stringValue(value, 'sts_url') ?? env.CARACAL_STS_URL ?? serviceUrl(env, 'CARACAL_STS_URL', DEFAULT_STS_URL)
  const coordinatorUrl = stringValue(value, 'coordinator_url') ?? serviceUrl(env, 'CARACAL_COORDINATOR_URL', DEFAULT_COORDINATOR_URL)
  const resources = resourcesFromProfile(value, path, env)
  return configFromClientSecret(
    {
      coordinatorUrl,
      stsUrl,
      zoneId,
      applicationId,
      clientSecret: clientSecretFromProfile(value, path, env, zoneId, applicationId),
      resources: resources.resources,
      gatewayUrl: stringValue(value, 'gateway_url') ?? serviceUrl(env, 'CARACAL_GATEWAY_URL', DEFAULT_GATEWAY_URL),
      defaultTtlSeconds: profileTtlSeconds(value, path) ?? defaultTtlFromEnv(env),
    },
    env,
  )
}

function profileTtlSeconds(record: Record<string, unknown>, source: string): number | undefined {
  const value = record.default_ttl_seconds
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${source}: default_ttl_seconds must be a positive integer`)
  }
  return value
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
  if (!file) throw new Error(`${source}: client secret is required via app_client_secret or app_client_secret_file`)
  return readSecretFile(file)
}

function clientSecretFromEnv(env: NodeJS.ProcessEnv, zoneId: string, applicationId: string): string | undefined {
  if (env.CARACAL_APP_CLIENT_SECRET && env.CARACAL_APP_CLIENT_SECRET_FILE) {
    throw new Error('Caracal.fromEnv: set only one of CARACAL_APP_CLIENT_SECRET or CARACAL_APP_CLIENT_SECRET_FILE')
  }
  if (env.CARACAL_APP_CLIENT_SECRET_FILE) return readSecretFile(env.CARACAL_APP_CLIENT_SECRET_FILE)
  if (env.CARACAL_APP_CLIENT_SECRET) return env.CARACAL_APP_CLIENT_SECRET
  return undefined
}

function readSecretFile(path: string): string {
  if (!existsSync(path)) throw new Error(`Caracal profile secret file does not exist: ${path}`)
  assertSecretFileSecure(path)
  const secret = readFileSync(path, 'utf8').trim()
  if (!secret) throw new Error(`Caracal profile secret file is empty: ${path}`)
  return secret
}

function resourcesFromProfile(record: Record<string, unknown>, source: string, env: NodeJS.ProcessEnv): ProfileResources {
  const credentials = [
    ...credentialEntries(record.credentials, `${source}.credentials`),
    ...credentialEntries(record.optional_credentials, `${source}.optional_credentials`),
  ]
  const resources = resourcesFromCredentials(credentials)
  const resolved = resolveProfileResources(resources.resources, resources.bindings ?? [], env)
  return resolved
}

function resourcesFromEnv(env: NodeJS.ProcessEnv): ProfileResources {
  return resolveProfileResources([], [], env)
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
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.host)
  } catch {
    return false
  }
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

function targetsGatewayPath(target: URL, gatewayUrl: string): boolean {
  let gateway: URL
  try {
    gateway = new URL(gatewayUrl)
  } catch {
    return false
  }
  if (!sameOrigin(target, gatewayUrl) || pathContainsTraversal(target.pathname)) return false
  const base = gateway.pathname.replace(/\/+$/, '') || '/'
  return base === '/' || target.pathname === base || target.pathname.startsWith(`${base}/`)
}

function pathContainsTraversal(pathname: string): boolean {
  let decoded = pathname
  for (let depth = 0; depth < 8; depth++) {
    if (decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..')) return true
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return true
    }
    if (next === decoded) return false
    decoded = next
  }
  return true
}

function joinGatewayPath(gatewayUrl: string, path: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    throw new Error('Caracal.gatewayRequest(): path must be relative to the configured gateway')
  }
  if (path.includes('#')) throw new Error('Caracal.gatewayRequest(): path must not contain a fragment')
  const gateway = new URL(gatewayUrl)
  const normalized = path.startsWith('/') ? path : `/${path}`
  const queryIndex = normalized.indexOf('?')
  const pathname = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : normalized.slice(queryIndex + 1)
  // Dot segments could climb out of a base-pathed gateway once the URL
  // normalizes, so the path must arrive already resolved.
  if (pathContainsTraversal(pathname)) {
    throw new Error('Caracal.gatewayRequest(): path must not contain dot segments')
  }
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
  resources: Array<string | ResourceBinding> | undefined,
): Array<string | ResourceBinding> {
  const explicit =
    raw
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  // Binding-derived ids always join the STS audience set so a routed resource
  // can never be minted without an audience.
  return compactResourceValues([...explicit, ...(resources ?? [])])
}

/**
 * Client-secret credential surface: a lifecycle token source backed by the
 * OAuth client's cached, single-flighted exchange, plus scoped mandate
 * minting for gateway calls. Credentials resolve per operation, so a rotated
 * secret is simply presented on the next exchange; a credential that resolves
 * to a different zone or application rebuilds the backing OAuth client so no
 * cached state crosses identities. `invalidate` forces the next lifecycle
 * token to bypass the cache after a server-side rejection.
 */
function createClientSecretTokenSource(
  stsUrl: string,
  credentials: CredentialsResolver,
  resources: string[],
  scope = LIFECYCLE_SCOPE,
  fetchImpl?: typeof fetch,
): ClientSecretExchanger & { source: TokenSource } {
  let active: { zoneId: string; applicationId: string; secretId: string; client: OAuthClient } | undefined
  let events: ((event: OAuthEvent) => void) | undefined
  let force = false
  const resolve = async (): Promise<{ creds: ClientCredentials; client: OAuthClient }> => {
    const creds = await credentials()
    if (!creds?.zoneId || !creds.applicationId || !creds.clientSecret) throw new CredentialsUnavailableError()
    const secretId = createHmac('sha256', CREDENTIAL_FINGERPRINT_KEY).update(creds.clientSecret).digest('hex')
    if (!active || active.zoneId !== creds.zoneId || active.applicationId !== creds.applicationId || active.secretId !== secretId) {
      const client = new OAuthClient(stsUrl, creds.zoneId, creds.applicationId, undefined, fetchImpl)
      client.onEvent = (event) => events?.(event)
      active = { zoneId: creds.zoneId, applicationId: creds.applicationId, secretId, client }
    }
    return { creds, client: active.client }
  }
  return {
    source: async () => {
      if (!resources.length) {
        throw new Error('Caracal: this client has no resources configured; session and lifecycle paths require at least one')
      }
      const { creds, client } = await resolve()
      const forceRefresh = force
      force = false
      const token = await client.exchange('', resources, { clientSecret: creds.clientSecret, scopes: [scope], forceRefresh })
      return token.accessToken
    },
    invalidate: () => {
      force = true
      active?.client.invalidate()
    },
    identity: async () => {
      const { creds } = await resolve()
      return {
        zoneId: creds.zoneId,
        applicationId: creds.applicationId,
        credentialGeneration: createHmac('sha256', CREDENTIAL_FINGERPRINT_KEY).update(creds.clientSecret).digest('hex'),
      }
    },
    mintMandate: async (resourceId, scopes, opts = {}) => {
      const { creds, client } = await resolve()
      const token = await client.exchange('', resourceId, {
        clientSecret: creds.clientSecret,
        scopes: [...new Set(scopes)].sort(),
        sessionId: opts.sessionId,
        delegationId: opts.delegationId,
        ttlSeconds: opts.ttlSeconds,
        challengeId: opts.approvalId,
        signal: opts.signal,
        cache: opts.cache ?? !(opts.sessionId && opts.delegationId),
      })
      return { token: token.accessToken, expiresInSeconds: token.expiresIn }
    },
    federateSubject: async (idToken, opts = {}) => {
      const { creds, client } = await resolve()
      const token = await client.federateSubject(idToken, {
        clientSecret: creds.clientSecret,
        ttlSeconds: opts.ttlSeconds,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      })
      return { token: token.accessToken, expiresInSeconds: token.expiresIn }
    },
    waitForApproval: async (approvalId, opts = {}) => (await resolve()).client.waitForApproval(approvalId, opts),
    onEvent: (cb) => {
      events = cb
    },
  }
}
function sortBindingsLongestFirst(bindings: ResourceBinding[]): ResourceBinding[] {
  return [...bindings].sort((a, b) => b.upstreamPrefix.length - a.upstreamPrefix.length)
}

/**
 * Local sanity check on the bootstrap subject token. When the token has a JWT
 * shape, rejects `alg: none` tokens - the platform never issues them, so the
 * shape only appears in forgeries and miswired test fixtures - and rejects
 * tokens that are malformed or already expired. Opaque tokens are accepted.
 */
function validateBootstrapToken(token: string): void {
  const alg = decodeJwtSegment(token, 0)?.alg
  if (typeof alg === 'string' && alg.toLowerCase() === 'none') {
    throw new Error('CARACAL_BOOTSTRAP_TOKEN uses alg "none": unsigned tokens are never valid; supply a token minted by the platform')
  }
  const exp = decodeJwtPayload(token)?.exp
  if (typeof exp !== 'number') return
  if (exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('CARACAL_BOOTSTRAP_TOKEN is expired: refresh the bootstrap token before starting the application')
  }
}

/** Decodes a JWT payload without verifying it - verification is the STS's job. Returns undefined for opaque or malformed tokens. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  return decodeJwtSegment(token, 1)
}

function decodeJwtSegment(token: string, index: number): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const padded = parts[index] + '='.repeat((4 - (parts[index].length % 4)) % 4)
    const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
    const json = typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('utf-8') : atob(b64)
    const payload: unknown = JSON.parse(json)
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

/** Folds the task option into session metadata; an explicit task wins over a metadata.task the caller also set. */
function taskMetadata(opts: { task?: string; metadata?: JsonObject }): JsonObject | undefined {
  return opts.task === undefined ? opts.metadata : { ...opts.metadata, task: opts.task }
}
