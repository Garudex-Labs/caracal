// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Hardened outbound OAuth token-endpoint client shared by provider grant exchange and provider connection tests.

import { createHash, createPrivateKey, randomUUID, sign, X509Certificate, type KeyObject } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { providerSecretConfigRef, type SecretBackend } from '@caracalai/server-core'

const PROVIDER_TOKEN_EXCHANGE_TIMEOUT_MS = 15_000
const PROVIDER_TOKEN_EXCHANGE_MAX_BODY_BYTES = 64 * 1024

// Resolves a provider's stored credential document from the secret backend. An empty
// record means the provider has no secrets, which is valid for public-client kinds.
export async function readProviderSecrets(secrets: SecretBackend, zoneId: string, providerId: string): Promise<Record<string, string>> {
  const value = await secrets.get(providerSecretConfigRef(zoneId, providerId))
  if (!value) return {}
  try {
    return JSON.parse(value.toString('utf8')) as Record<string, string>
  } finally {
    value.fill(0)
  }
}

export function stringConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function stringListConfig(config: Record<string, unknown>, key: string): string[] {
  const value = config[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}

export function recordConfig(config: Record<string, unknown>, key: string): Record<string, string> {
  const value = config[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const params: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.trim().length > 0) params[name] = item.trim()
  }
  return params
}

export function ensureHttpsEndpoint(raw: string, label: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error(`${label} must be https`)
  }
  return url
}

export function ensureAllowedTokenEndpoint(raw: string, hosts: string[]): URL {
  const url = ensureHttpsEndpoint(raw, 'provider token endpoint')
  if (hosts.length === 0) {
    throw new Error('provider has no allowed_token_hosts configured')
  }
  if (!hosts.some((host) => host.trim().toLowerCase() === url.hostname.toLowerCase())) {
    throw new Error('provider token endpoint host is not allowlisted')
  }
  return url
}

// Extract the IPv4 address embedded in a NAT64 well-known-prefix address
// (64:ff9b::/96, RFC 6052), or null when value is not such an address.
function nat64EmbeddedIpv4(value: string): string | null {
  const lower = value.toLowerCase()
  if (!lower.startsWith('64:ff9b::')) return null
  const tail = lower.slice('64:ff9b::'.length)
  if (tail === '') return null
  if (tail.includes('.')) {
    return isIP(tail) === 4 ? tail : null
  }
  const groups = tail.split(':')
  if (groups.length < 2) return null
  const hi = Number.parseInt(groups[groups.length - 2]!, 16)
  const lo = Number.parseInt(groups[groups.length - 1]!, 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 0xffff || lo > 0xffff) return null
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

function isUnsafeIpAddress(value: string): boolean {
  const nat64 = nat64EmbeddedIpv4(value)
  if (nat64) return isUnsafeIpAddress(nat64)
  const ip = value.startsWith('::ffff:') ? value.slice(7) : value
  const family = isIP(ip)
  if (family === 4) {
    const parts = ip.split('.').map(Number)
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224
    )
  }
  const lower = ip.toLowerCase()
  return (
    family === 6 &&
    (lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80:') ||
      lower.startsWith('ff'))
  )
}

async function resolveSafeHost(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const addresses = await lookup(host, { all: true, verbatim: false })
  if (addresses.length === 0) throw new Error('provider token endpoint resolves to no addresses')
  for (const address of addresses) {
    if (isUnsafeIpAddress(address.address)) throw new Error('provider token endpoint resolves to a non-routable address')
  }
  return addresses.filter((address): address is { address: string; family: 4 | 6 } => address.family === 4 || address.family === 6)
}

export interface TokenRequestParts {
  headers: Record<string, string>
  body: URLSearchParams
}

function assertionSigning(key: KeyObject): { alg: string; hash: string } {
  if (key.asymmetricKeyType === 'rsa') return { alg: 'RS256', hash: 'sha256' }
  if (key.asymmetricKeyType === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve
    if (curve === 'prime256v1') return { alg: 'ES256', hash: 'sha256' }
    if (curve === 'secp384r1') return { alg: 'ES384', hash: 'sha384' }
    if (curve === 'secp521r1') return { alg: 'ES512', hash: 'sha512' }
    throw new Error(`unsupported EC curve for client assertion: ${curve ?? 'unknown'}`)
  }
  throw new Error(`unsupported private key type for client assertion: ${key.asymmetricKeyType ?? 'unknown'}`)
}

function signAssertion(claims: Record<string, unknown>, keyId: string, privateKeyPem: string, certificatePem?: string): string {
  const key = createPrivateKey(privateKeyPem)
  const { alg, hash } = assertionSigning(key)
  const header: Record<string, string> = { alg, typ: 'JWT' }
  if (keyId) header.kid = keyId
  if (certificatePem) {
    // Microsoft Entra ID certificate credentials identify the signing certificate by
    // thumbprint header rather than kid; both digest forms are emitted since verifiers
    // accept either and ignore the one they do not use.
    const der = new X509Certificate(certificatePem).raw
    header.x5t = createHash('sha1').update(der).digest('base64url')
    header['x5t#S256'] = createHash('sha256').update(der).digest('base64url')
  }
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  const signature = sign(hash, Buffer.from(signingInput), key.asymmetricKeyType === 'ec' ? { key, dsaEncoding: 'ieee-p1363' } : key)
  return `${signingInput}.${signature.toString('base64url')}`
}

export function buildClientAssertion(
  audience: string,
  clientId: string,
  keyId: string,
  privateKeyPem: string,
  certificatePem?: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: clientId, sub: clientId, aud: audience, iat: now, exp: now + 60, jti: randomUUID() }
  return signAssertion(claims, keyId, privateKeyPem, certificatePem)
}

export interface GrantAssertionInput {
  tokenEndpoint: string
  clientId: string
  subject?: string
  audience?: string
  scopes: string[]
  keyId: string
  privateKeyPem: string
}

// RFC 7523 section 2.1 authorization grant: the assertion itself is the grant, so the
// scopes ride inside the JWT as Google's service-account flow expects rather than as a
// form parameter, and the audience defaults to the token endpoint.
export function buildGrantAssertion(input: GrantAssertionInput): string {
  const now = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = {
    iss: input.clientId,
    sub: input.subject || input.clientId,
    aud: input.audience || input.tokenEndpoint,
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  }
  if (input.scopes.length > 0) claims.scope = input.scopes.join(' ')
  return signAssertion(claims, input.keyId, input.privateKeyPem)
}

export function buildTokenRequest(
  form: URLSearchParams,
  clientId: string,
  clientSecret: string,
  method: string,
  assertion?: string,
): TokenRequestParts {
  const body = new URLSearchParams(form)
  // Accept pins the response to JSON: endpoints that predate RFC 6749 defaults, such as
  // GitHub's, answer form-encoded without it.
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (method === 'client_secret_post') {
    body.set('client_id', clientId)
    body.set('client_secret', clientSecret)
  } else if (method === 'private_key_jwt') {
    if (!assertion) throw new Error('private_key_jwt requires a client assertion')
    body.set('client_id', clientId)
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    body.set('client_assertion', assertion)
  } else if (method === 'none') {
    body.set('client_id', clientId)
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }
  return { headers, body }
}

export async function exchangeProviderToken(endpoint: URL, parts: TokenRequestParts): Promise<{ statusCode: number; body: string }> {
  const body = parts.body.toString()
  return providerHttpRequest(endpoint, 'POST', { ...parts.headers, 'Content-Length': Buffer.byteLength(body).toString() }, body)
}

// Fetches an issuer's published discovery document (OIDC or RFC 8414) with the same
// outbound hardening as the token exchange: SSRF-pinned DNS, HTTPS-only, no redirects,
// bounded response size, and a hard timeout.
export async function fetchProviderMetadata(endpoint: URL): Promise<{ statusCode: number; body: string }> {
  return providerHttpRequest(endpoint, 'GET', { Accept: 'application/json' })
}

async function providerHttpRequest(
  endpoint: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  await resolveSafeHost(endpoint.hostname)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: Error | undefined, value?: { statusCode: number; body: string }) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value ?? { statusCode: 0, body: '' })
    }
    const req = httpsRequest(
      endpoint,
      {
        method,
        headers,
        timeout: PROVIDER_TOKEN_EXCHANGE_TIMEOUT_MS,
        lookup: async (host, _options, callback) => {
          try {
            const addresses = await resolveSafeHost(host)
            callback(null, addresses[0].address, addresses[0].family)
          } catch (err) {
            callback(err instanceof Error ? err : new Error(String(err)), '', 4)
          }
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (Buffer.byteLength(text) > PROVIDER_TOKEN_EXCHANGE_MAX_BODY_BYTES) {
            res.destroy(new Error('provider token response too large'))
          }
        })
        res.on('end', () => finish(undefined, { statusCode: res.statusCode ?? 0, body: text }))
        res.on('error', finish)
      },
    )
    req.on('timeout', () => req.destroy(new Error('provider token exchange timed out')))
    req.on('error', finish)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
