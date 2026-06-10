/*
 * Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
 * Caracal, a product of Garudex Labs
 *
 * Caracal: drop-in bound client wrapping zone, application, subject token, and coordinator.
 */

import { bind, fromEnvelope, toEnvelope, current, type CaracalContext } from './context.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { decodeEnvelope, toHeaders, type Envelope, type HeaderGetter } from './envelope.js'
import { type CoordinatorClient } from './coordinator.js'
import {
  spawn as spawnPrimitive,
  spawnService as spawnServicePrimitive,
  delegate as delegatePrimitive,
  type Grant,
  type SpawnInput,
  type ServiceAgent,
  type DelegateInput,
} from './primitives.js'
import { type DelegationConstraints } from './coordinator.js'
import type { JsonObject } from './json.js'
import { OAuthClient } from '@caracalai/oauth'

const DEFAULT_STS_URL = 'http://localhost:8080'
const DEFAULT_COORDINATOR_URL = 'http://localhost:4000'
const DEFAULT_GATEWAY_URL = 'http://localhost:8081'

export interface ResourceBinding {
  resourceId: string
  upstreamPrefix: string
}

export type TokenSource = () => string | Promise<string>

export interface CaracalConfig {
  coordinator: CoordinatorClient
  zoneId: string
  applicationId: string
  subjectToken?: string
  tokenSource?: TokenSource
  gatewayUrl?: string
  resources?: ResourceBinding[]
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
}

export interface ServiceOptions {
  ttlSeconds?: number
  subjectSessionId?: string
  parentId?: string
  metadata?: JsonObject
  labels?: string[]
  traceId?: string
  heartbeatIntervalMs?: number
}

export interface DelegateOptions {
  to: string
  toApplicationId: string
  resourceId?: string
  scopes: string[]
  constraints?: DelegationConstraints
  ttlSeconds?: number
}

export type LifecycleHook = (ctx: CaracalContext) => void | Promise<void>

export interface RootOptions {
  allowRoot?: boolean
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
    this.config =
      config.resources && config.resources.length > 1 ? { ...config, resources: sortBindingsLongestFirst(config.resources) } : config
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
      grant: opts.grant,
      ttlSeconds: opts.ttlSeconds ?? this.config.defaultTtlSeconds,
      subjectSessionId: opts.subjectSessionId,
      parentId: opts.parentId,
      metadata: opts.metadata,
      labels: opts.labels,
      traceId: opts.traceId,
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
      ttlSeconds: opts.ttlSeconds ?? this.config.defaultTtlSeconds,
      subjectSessionId: opts.subjectSessionId,
      parentId: opts.parentId,
      metadata: opts.metadata,
      labels: opts.labels,
      traceId: opts.traceId,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      onAgentStart: this.agentStartHooks.length ? (c) => this.fire(this.agentStartHooks, c) : undefined,
    })
  }

  delegate<T>(opts: DelegateOptions, fn: () => Promise<T>): Promise<T> {
    const input: DelegateInput = {
      coordinator: this.config.coordinator,
      toAgentSessionId: opts.to,
      toApplicationId: opts.toApplicationId,
      resourceId: opts.resourceId,
      scopes: opts.scopes,
      constraints: opts.constraints,
      ttlSeconds: opts.ttlSeconds,
    }
    return delegatePrimitive(input, fn)
  }

  bind<T>(ctx: CaracalContext, fn: () => Promise<T>): Promise<T> {
    return bind(ctx, fn) as Promise<T>
  }

  onAgentStart(cb: LifecycleHook): void {
    this.agentStartHooks.push(cb)
  }

  onAgentEnd(cb: LifecycleHook): void {
    this.agentEndHooks.push(cb)
  }

  private async fire(hooks: LifecycleHook[], ctx: CaracalContext): Promise<void> {
    for (const h of hooks) await h(ctx)
  }

  current(): CaracalContext | undefined {
    return current()
  }

  headers(opts: RootOptions = {}): Record<string, string> {
    const ctx = current()
    if (!ctx) {
      if (!opts.allowRoot) {
        throw new Error('Caracal.headers(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.')
      }
      return toHeaders({
        subjectToken: this.rootTokenSync(),
        hop: 0,
      })
    }
    return toHeaders(toEnvelope(ctx))
  }

  async headersAsync(opts: RootOptions = {}): Promise<Record<string, string>> {
    const ctx = current()
    if (!ctx) {
      if (!opts.allowRoot) {
        throw new Error(
          'Caracal.headersAsync(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.',
        )
      }
      return toHeaders({ subjectToken: await this.rootToken(), hop: 0 })
    }
    return toHeaders(toEnvelope(ctx))
  }

  async bindFromHeaders<T>(
    headers: Record<string, string | string[] | undefined> | HeaderGetter,
    fn: () => Promise<T>,
    opts: RootOptions = {},
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
    if (!env.subjectToken) {
      if (!opts.allowRoot) {
        throw new Error(
          'Caracal.bindFromHeaders(): inbound request is missing a bearer token. Pass { allowRoot: true } only for trusted service-root ingress.',
        )
      }
      env.subjectToken = await this.rootToken()
    }
    const ctx = fromEnvelope(env as Envelope, {
      zoneId: this.config.zoneId,
      applicationId: this.config.applicationId,
    })
    return (await bind(ctx, fn)) as T
  }

  /**
   * Returns a fetch-shaped function that injects the Caracal envelope (traceparent
   * + baggage) onto outbound requests and, for gateway-routed calls, replaces the
   * `Authorization` header with the current subject token. Pass to any provider
   * SDK that accepts a custom fetch.
   */
  transport(opts: RootOptions = {}): typeof fetch {
    const outer = this
    const rootAllowed = opts.allowRoot === true
    const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const ctx = current()
      if (!ctx && !rootAllowed) {
        throw new Error('Caracal.transport(): no Caracal context is bound. Pass { allowRoot: true } to use the application subject token.')
      }
      const env: Envelope = ctx ? toEnvelope(ctx) : { subjectToken: await outer.rootToken(), hop: 0 }
      const merged = new Headers(init?.headers ?? {})
      for (const [k, v] of Object.entries(toHeaders(env))) {
        if (!merged.has(k)) merged.set(k, v)
      }
      const fetchImpl = outer.config.coordinator.fetchImpl ?? fetch

      const explicitResource = merged.get('X-Caracal-Resource') ?? undefined
      const rewritten = outer.routeThroughGateway(input, explicitResource)
      if (rewritten) {
        merged.set('X-Caracal-Resource', rewritten.resourceId)
        merged.set('Authorization', `Bearer ${env.subjectToken}`)
        return fetchImpl(rewritten.url as unknown as URL, { ...init, headers: merged })
      }
      return fetchImpl(input as URL, { ...init, headers: merged })
    }) as typeof fetch
    return fn
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
   * wins over any caller-supplied `X-Caracal-Resource`.
   */
  fetch(resourceId: string, path: string = '/', init: RequestInit = {}, opts: RootOptions = {}): Promise<Response> {
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

  /**
   * Binds Caracal context after a verifier boundary. This does not verify JWT
   * signatures, audience, scopes, token use, or revocation.
   */
  contextMiddleware(opts: RootOptions = {}) {
    return (req: { headers: Record<string, string | string[] | undefined> }, _res: unknown, next: (err?: unknown) => void): void => {
      this.bindFromHeaders(
        req.headers,
        async () => {
          next()
        },
        opts,
      ).catch(next)
    }
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

function serviceUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]
  if (value) return value
  if (env.NODE_ENV === 'production') throw new Error(`Caracal SDK: ${key} is required when NODE_ENV=production`)
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
  if (env.NODE_ENV === 'production') return undefined
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
  if (clientSecret) {
    return configFromClientSecret({
      coordinatorUrl: url,
      stsUrl,
      zoneId: zoneId!,
      applicationId: applicationId!,
      clientSecret,
      resources: resourceIdsFromEnv(env.CARACAL_APP_RESOURCES, profileResources.credentialResources ?? [], profileResources.resources),
      gatewayUrl,
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
  }
}

function configFromClientSecret(opts: ClientSecretOptions): CaracalConfig {
  const resourceIds = opts.resources.map((value) => (typeof value === 'string' ? value : value.resourceId))
  if (!resourceIds.length) throw new Error('Caracal.fromClientSecret requires at least one resource')
  const bindings = opts.resources.filter((value): value is ResourceBinding => typeof value !== 'string')
  return {
    coordinator: { baseUrl: opts.coordinatorUrl },
    zoneId: opts.zoneId,
    applicationId: opts.applicationId,
    tokenSource: createClientSecretTokenSource(
      opts.stsUrl,
      opts.zoneId,
      opts.applicationId,
      opts.clientSecret,
      resourceIds,
      opts.scope,
      opts.fetchImpl,
    ),
    gatewayUrl: opts.gatewayUrl,
    resources: bindings.length ? bindings : undefined,
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
  })
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
  if ((mode & 0o022) !== 0) throw new Error(`Caracal profile secret file permissions are too broad: ${path}`)
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
  if (inline) return inline
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
  const localFile = existingLocalFile(defaultClientSecretPath(env, zoneId, applicationId), env)
  if (localFile) return readSecretFile(localFile)
  return env.CARACAL_APP_CLIENT_SECRET
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
  const explicit = raw
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (explicit?.length) return compactResourceValues([...first, ...explicit])
  if (resources?.length) return resources
  throw new Error(
    'Caracal.fromEnv: client-secret mode requires resources via CARACAL_APP_RESOURCES, CARACAL_RUN_CREDENTIALS, CARACAL_RESOURCES, or CARACAL_RESOURCES_FILE',
  )
}

function createClientSecretTokenSource(
  stsUrl: string,
  zoneId: string,
  applicationId: string,
  clientSecret: string,
  resources: string[],
  scope = 'agent:lifecycle',
  fetchImpl?: typeof fetch,
): TokenSource {
  const client = new OAuthClient(stsUrl, zoneId, applicationId, undefined, fetchImpl)
  return async () => {
    const token = await client.exchange('', resources, { clientSecret, scopes: [scope] })
    return token.accessToken
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
