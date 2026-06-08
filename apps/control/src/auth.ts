// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Bearer-token authenticator: validates STS-issued ES256 JWTs against a zone-scoped JWKS and surfaces claims for the dispatch layer.

import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export interface Claims {
  sub: string
  jti: string
  zoneId: string
  clientId: string
  scope: string
  exp: number | undefined
}

interface ZoneEntry {
  keySet: JWTVerifyGetKey
  loadedAt: number
}

export interface AuthOptions {
  jwksUrl: string
  issuer: string
  audience: string
  refreshFloorMs?: number
  jwksTtlMs?: number
  maxStaleMs?: number
  maxZones?: number
  negativeTtlMs?: number
  clockToleranceSec?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_STALE_MS = 10 * 60 * 1000
const DEFAULT_MAX_ZONES = 1024
const DEFAULT_NEGATIVE_TTL_MS = 30_000
const DEFAULT_CLOCK_TOLERANCE_SEC = 60

const ZONE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function isValidZoneId(zoneId: string): boolean {
  return ZONE_ID_PATTERN.test(zoneId)
}

interface NegativeEntry {
  expiresAt: number
}

export class Authenticator {
  private readonly opts: AuthOptions
  private readonly zones = new Map<string, ZoneEntry>()
  private readonly negative = new Map<string, NegativeEntry>()
  private readonly jwksTtlMs: number
  private readonly maxStaleMs: number
  private readonly maxZones: number
  private readonly negativeTtlMs: number
  private readonly clockToleranceSec: number

  constructor(opts: AuthOptions) {
    this.opts = opts
    this.jwksTtlMs = opts.jwksTtlMs ?? opts.refreshFloorMs ?? DEFAULT_JWKS_TTL_MS
    this.maxStaleMs = Math.max(opts.maxStaleMs ?? DEFAULT_MAX_STALE_MS, this.jwksTtlMs)
    this.maxZones = opts.maxZones ?? DEFAULT_MAX_ZONES
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
    this.clockToleranceSec = opts.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC
  }

  async verify(authHeader: string | undefined): Promise<Claims> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError('missing bearer token')
    }
    const token = authHeader.slice('Bearer '.length).trim()
    if (!token) throw new AuthError('missing bearer token')

    const peek = decodePayload(token)
    const zoneId = typeof peek['zone_id'] === 'string' ? (peek['zone_id'] as string) : ''
    if (!zoneId) throw new AuthError('missing zone_id')
    if (!isValidZoneId(zoneId)) throw new AuthError('invalid zone_id')

    const keySet = await this.keySet(zoneId, false)
    let payload
    try {
      ;({ payload } = await jwtVerify(token, keySet, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        algorithms: ['ES256'],
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
        clockTolerance: this.clockToleranceSec,
      }))
    } catch (err) {
      if (isKeyMiss(err)) {
        const refreshed = await this.keySet(zoneId, true)
        ;({ payload } = await jwtVerify(token, refreshed, {
          issuer: this.opts.issuer,
          audience: this.opts.audience,
          algorithms: ['ES256'],
          requiredClaims: ['exp', 'iat', 'jti', 'sub'],
          clockTolerance: this.clockToleranceSec,
        }).catch((e) => { throw new AuthError(`invalid token: ${describe(e)}`) }))
      } else {
        throw new AuthError(`invalid token: ${describe(err)}`)
      }
    }

    const claims: Claims = {
      sub: requireString(payload, 'sub'),
      jti: requireString(payload, 'jti'),
      zoneId,
      clientId: optionalString(payload, 'client_id') ?? '',
      scope: optionalString(payload, 'scope') ?? '',
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    }
    if (typeof payload['zone_id'] !== 'string' || payload['zone_id'] !== zoneId) {
      throw new AuthError('zone_id mismatch')
    }
    return claims
  }

  private async keySet(zoneId: string, force: boolean): Promise<JWTVerifyGetKey> {
    const now = performance.now()
    const cached = this.zones.get(zoneId)
    if (cached && !force) {
      this.zones.delete(zoneId)
      this.zones.set(zoneId, cached)
      if (now - cached.loadedAt < this.jwksTtlMs) return cached.keySet
      try {
        return await this.fetchAndStore(zoneId, now)
      } catch (err) {
        if (now - cached.loadedAt <= this.maxStaleMs) return cached.keySet
        throw err
      }
    }
    if (!force) {
      const neg = this.negative.get(zoneId)
      if (neg && neg.expiresAt > now) throw new AuthError('unknown zone')
      if (neg) this.negative.delete(zoneId)
    }
    return this.fetchAndStore(zoneId, now)
  }

  private async fetchAndStore(zoneId: string, now: number): Promise<JWTVerifyGetKey> {
    let set: JWTVerifyGetKey
    try {
      set = await fetchJwks(this.opts, zoneId)
    } catch (err) {
      if (this.negative.size >= this.maxZones) {
        const oldest = this.negative.keys().next().value
        if (oldest !== undefined) this.negative.delete(oldest)
      }
      this.negative.set(zoneId, { expiresAt: now + this.negativeTtlMs })
      throw err
    }
    if (this.zones.size >= this.maxZones && !this.zones.has(zoneId)) {
      const oldest = this.zones.keys().next().value
      if (oldest !== undefined) this.zones.delete(oldest)
    }
    this.zones.set(zoneId, { keySet: set, loadedAt: now })
    return set
  }
}

async function fetchJwks(opts: AuthOptions, zoneId: string): Promise<JWTVerifyGetKey> {
  const fetcher = opts.fetchImpl ?? fetch
  const u = new URL(opts.jwksUrl)
  u.searchParams.set('zone_id', zoneId)
  const res = await fetcher(u.toString(), { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new AuthError(`jwks status ${res.status}`)
  const body = (await res.json()) as { keys?: object[] }
  if (!body.keys || !Array.isArray(body.keys)) throw new AuthError('jwks: malformed')
  return createLocalJWKSet({ keys: body.keys } as Parameters<typeof createLocalJWKSet>[0])
}

function decodePayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthError('malformed token')
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new AuthError('malformed token payload')
  }
}

function requireString(payload: Record<string, unknown>, name: string): string {
  const v = payload[name]
  if (typeof v !== 'string' || v === '') throw new AuthError(`claim ${name} required`)
  return v
}

function optionalString(payload: Record<string, unknown>, name: string): string | undefined {
  const v = payload[name]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new AuthError(`claim ${name} must be a string`)
  return v
}

function isKeyMiss(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === 'ERR_JWKS_NO_MATCHING_KEY' || code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}
