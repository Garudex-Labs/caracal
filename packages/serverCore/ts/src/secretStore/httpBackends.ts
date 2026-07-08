// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// External SecretBackend implementations: Vault, Infisical, Azure Key Vault, AWS Secrets Manager, Google Secret Manager, and the custom REST contract.

import { createHmac, createSign, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SecretBackendError, type SecretBackend, type SecretBackendKind } from './backend.js'

const REQUEST_TIMEOUT_MS = 10_000
const TOKEN_EXPIRY_SKEW_MS = 60_000

function requireEnv(name: string): string {
  const value = (process.env[name] ?? '').trim()
  if (!value) throw new Error(`${name} is required for the configured secret backend`)
  return value
}

async function backendFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new SecretBackendError('secret backend unreachable')
  }
}

function backendStatusError(operation: string, status: number): SecretBackendError {
  return new SecretBackendError(`secret backend ${operation} failed with status ${status}`)
}

// String-valued stores receive base64 payloads so arbitrary bytes survive every backend
// unchanged; the builtin backend stores raw bytes and never round-trips through this.
function encodeValue(value: Buffer): string {
  return value.toString('base64')
}

function decodeValue(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

// HashiCorp Vault KV v2: values live under the configured mount, addressed by ref path.
export class VaultBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'vault'
  private readonly addr: string
  private readonly token: string
  private readonly mount: string
  private readonly namespace: string

  constructor() {
    this.addr = requireEnv('CARACAL_VAULT_ADDR').replace(/\/+$/, '')
    this.token = requireEnv('CARACAL_VAULT_TOKEN')
    this.mount = (process.env.CARACAL_VAULT_MOUNT ?? 'secret').trim() || 'secret'
    this.namespace = (process.env.CARACAL_VAULT_NAMESPACE ?? '').trim()
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'X-Vault-Token': this.token }
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace
    return headers
  }

  async put(ref: string, value: Buffer): Promise<void> {
    const res = await backendFetch(`${this.addr}/v1/${this.mount}/data/${ref}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { value: encodeValue(value) } }),
    })
    if (!res.ok) throw backendStatusError('write', res.status)
  }

  async get(ref: string): Promise<Buffer | null> {
    const res = await backendFetch(`${this.addr}/v1/${this.mount}/data/${ref}`, { headers: this.headers() })
    if (res.status === 404) return null
    if (!res.ok) throw backendStatusError('read', res.status)
    const body = (await res.json()) as { data?: { data?: { value?: string } } }
    const value = body.data?.data?.value
    if (typeof value !== 'string') throw new SecretBackendError('secret backend returned an unexpected payload')
    return decodeValue(value)
  }

  async delete(ref: string): Promise<void> {
    const res = await backendFetch(`${this.addr}/v1/${this.mount}/metadata/${ref}`, { method: 'DELETE', headers: this.headers() })
    if (!res.ok && res.status !== 404) throw backendStatusError('delete', res.status)
  }
}

// Infisical: refs become dotted secret names inside one project environment and path.
export class InfisicalBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'infisical'
  private readonly baseUrl: string
  private readonly token: string
  private readonly projectId: string
  private readonly environment: string
  private readonly path: string

  constructor() {
    this.baseUrl = ((process.env.CARACAL_INFISICAL_URL ?? '').trim() || 'https://app.infisical.com').replace(/\/+$/, '')
    this.token = requireEnv('CARACAL_INFISICAL_TOKEN')
    this.projectId = requireEnv('CARACAL_INFISICAL_PROJECT_ID')
    this.environment = (process.env.CARACAL_INFISICAL_ENV ?? 'prod').trim() || 'prod'
    this.path = (process.env.CARACAL_INFISICAL_PATH ?? '/').trim() || '/'
  }

  private name(ref: string): string {
    return ref.replaceAll('/', '.')
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }
  }

  private body(extra: Record<string, unknown>): string {
    return JSON.stringify({ workspaceId: this.projectId, environment: this.environment, secretPath: this.path, ...extra })
  }

  async put(ref: string, value: Buffer): Promise<void> {
    const url = `${this.baseUrl}/api/v3/secrets/raw/${this.name(ref)}`
    const payload = this.body({ secretValue: encodeValue(value), type: 'shared' })
    const created = await backendFetch(url, { method: 'POST', headers: this.headers(), body: payload })
    if (created.ok) return
    const updated = await backendFetch(url, { method: 'PATCH', headers: this.headers(), body: payload })
    if (!updated.ok) throw backendStatusError('write', updated.status)
  }

  async get(ref: string): Promise<Buffer | null> {
    const query = new URLSearchParams({ workspaceId: this.projectId, environment: this.environment, secretPath: this.path })
    const res = await backendFetch(`${this.baseUrl}/api/v3/secrets/raw/${this.name(ref)}?${query}`, { headers: this.headers() })
    if (res.status === 404) return null
    if (!res.ok) throw backendStatusError('read', res.status)
    const body = (await res.json()) as { secret?: { secretValue?: string } }
    const value = body.secret?.secretValue
    if (typeof value !== 'string') throw new SecretBackendError('secret backend returned an unexpected payload')
    return decodeValue(value)
  }

  async delete(ref: string): Promise<void> {
    const res = await backendFetch(`${this.baseUrl}/api/v3/secrets/raw/${this.name(ref)}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: this.body({}),
    })
    if (!res.ok && res.status !== 404) throw backendStatusError('delete', res.status)
  }
}

interface CachedToken {
  value: string
  expiresAt: number
}

// Azure Key Vault: refs become dashed secret names; access tokens come from the AAD
// client-credentials flow and are cached until shortly before expiry.
export class AzureKeyVaultBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'azurekeyvault'
  private readonly vaultUrl: string
  private readonly tenantId: string
  private readonly clientId: string
  private readonly clientSecret: string
  private cached: CachedToken | null = null

  constructor() {
    this.vaultUrl = requireEnv('CARACAL_AZURE_VAULT_URL').replace(/\/+$/, '')
    this.tenantId = requireEnv('CARACAL_AZURE_TENANT_ID')
    this.clientId = requireEnv('CARACAL_AZURE_CLIENT_ID')
    this.clientSecret = requireEnv('CARACAL_AZURE_CLIENT_SECRET')
  }

  private name(ref: string): string {
    return ref.replaceAll('/', '-')
  }

  private async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.value
    const res = await backendFetch(`https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'https://vault.azure.net/.default',
      }).toString(),
    })
    if (!res.ok) throw backendStatusError('auth', res.status)
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new SecretBackendError('secret backend auth returned no token')
    this.cached = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - TOKEN_EXPIRY_SKEW_MS }
    return body.access_token
  }

  private async request(method: string, ref: string, body?: string): Promise<Response> {
    const token = await this.accessToken()
    return backendFetch(`${this.vaultUrl}/secrets/${this.name(ref)}?api-version=7.4`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    })
  }

  async put(ref: string, value: Buffer): Promise<void> {
    const res = await this.request('PUT', ref, JSON.stringify({ value: encodeValue(value) }))
    if (!res.ok) throw backendStatusError('write', res.status)
  }

  async get(ref: string): Promise<Buffer | null> {
    const res = await this.request('GET', ref)
    if (res.status === 404) return null
    if (!res.ok) throw backendStatusError('read', res.status)
    const body = (await res.json()) as { value?: string }
    if (typeof body.value !== 'string') throw new SecretBackendError('secret backend returned an unexpected payload')
    return decodeValue(body.value)
  }

  async delete(ref: string): Promise<void> {
    const res = await this.request('DELETE', ref)
    if (!res.ok && res.status !== 404) throw backendStatusError('delete', res.status)
  }
}

// AWS Secrets Manager over the JSON 1.1 protocol with hand-rolled SigV4 request signing,
// so the backend needs no SDK dependency.
export class AwsSecretsManagerBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'awssecretsmanager'
  private readonly region: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly sessionToken: string

  constructor() {
    this.region = (process.env.CARACAL_AWS_REGION ?? process.env.AWS_REGION ?? '').trim()
    if (!this.region) throw new Error('CARACAL_AWS_REGION or AWS_REGION is required for the configured secret backend')
    this.accessKeyId = requireEnv('AWS_ACCESS_KEY_ID')
    this.secretAccessKey = requireEnv('AWS_SECRET_ACCESS_KEY')
    this.sessionToken = (process.env.AWS_SESSION_TOKEN ?? '').trim()
  }

  private async call(target: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const host = `secretsmanager.${this.region}.amazonaws.com`
    const body = JSON.stringify(payload)
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const headers: Record<string, string> = {
      'content-type': 'application/x-amz-json-1.1',
      host,
      'x-amz-date': amzDate,
      'x-amz-target': `secretsmanager.${target}`,
    }
    if (this.sessionToken) headers['x-amz-security-token'] = this.sessionToken
    const signedHeaderNames = Object.keys(headers).sort()
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('')
    const signedHeaders = signedHeaderNames.join(';')
    const payloadHash = createHash('sha256').update(body).digest('hex')
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
    const scope = `${dateStamp}/${this.region}/secretsmanager/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
    const kDate = createHmac('sha256', `AWS4${this.secretAccessKey}`).update(dateStamp).digest()
    const kRegion = createHmac('sha256', kDate).update(this.region).digest()
    const kService = createHmac('sha256', kRegion).update('secretsmanager').digest()
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest()
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    const res = await backendFetch(`https://${host}/`, {
      method: 'POST',
      headers: { ...headers, authorization },
      body,
    })
    const text = await res.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      parsed = {}
    }
    return { status: res.status, body: parsed }
  }

  private static notFound(body: Record<string, unknown>): boolean {
    return typeof body.__type === 'string' && body.__type.includes('ResourceNotFoundException')
  }

  async put(ref: string, value: Buffer): Promise<void> {
    const secretString = encodeValue(value)
    const updated = await this.call('PutSecretValue', { SecretId: ref, SecretString: secretString })
    if (updated.status >= 200 && updated.status < 300) return
    if (!AwsSecretsManagerBackend.notFound(updated.body)) throw backendStatusError('write', updated.status)
    const created = await this.call('CreateSecret', { Name: ref, SecretString: secretString })
    if (created.status < 200 || created.status >= 300) throw backendStatusError('write', created.status)
  }

  async get(ref: string): Promise<Buffer | null> {
    const res = await this.call('GetSecretValue', { SecretId: ref })
    if (AwsSecretsManagerBackend.notFound(res.body)) return null
    if (res.status < 200 || res.status >= 300) throw backendStatusError('read', res.status)
    const value = res.body.SecretString
    if (typeof value !== 'string') throw new SecretBackendError('secret backend returned an unexpected payload')
    return decodeValue(value)
  }

  async delete(ref: string): Promise<void> {
    const res = await this.call('DeleteSecret', { SecretId: ref, ForceDeleteWithoutRecovery: true })
    if (res.status >= 200 && res.status < 300) return
    if (!AwsSecretsManagerBackend.notFound(res.body)) throw backendStatusError('delete', res.status)
  }
}

interface GcpServiceAccount {
  client_email: string
  private_key: string
  token_uri: string
}

// Google Secret Manager: refs become dashed secret ids; access tokens come from the
// service-account JWT bearer flow and are cached until shortly before expiry.
export class GcpSecretManagerBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'gcpsecretmanager'
  private readonly project: string
  private readonly account: GcpServiceAccount
  private cached: CachedToken | null = null

  constructor() {
    this.project = requireEnv('CARACAL_GCP_PROJECT')
    const credentialsPath = (process.env.CARACAL_GCP_CREDENTIALS_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim()
    if (!credentialsPath) {
      throw new Error('CARACAL_GCP_CREDENTIALS_FILE or GOOGLE_APPLICATION_CREDENTIALS is required for the configured secret backend')
    }
    const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Partial<GcpServiceAccount>
    if (!parsed.client_email || !parsed.private_key)
      throw new Error('GCP service account credentials file is missing client_email or private_key')
    this.account = {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      token_uri: parsed.token_uri ?? 'https://oauth2.googleapis.com/token',
    }
  }

  private name(ref: string): string {
    return ref.replaceAll('/', '-')
  }

  private async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.value
    const now = Math.floor(Date.now() / 1000)
    const encode = (part: Record<string, unknown>): string => Buffer.from(JSON.stringify(part)).toString('base64url')
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: this.account.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: this.account.token_uri,
      iat: now,
      exp: now + 3600,
    })}`
    const signature = createSign('RSA-SHA256').update(signingInput).sign(this.account.private_key).toString('base64url')
    const res = await backendFetch(this.account.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${signingInput}.${signature}`,
      }).toString(),
    })
    if (!res.ok) throw backendStatusError('auth', res.status)
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new SecretBackendError('secret backend auth returned no token')
    this.cached = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - TOKEN_EXPIRY_SKEW_MS }
    return body.access_token
  }

  private async request(method: string, path: string, body?: string): Promise<Response> {
    const token = await this.accessToken()
    return backendFetch(`https://secretmanager.googleapis.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    })
  }

  async put(ref: string, value: Buffer): Promise<void> {
    const name = this.name(ref)
    const created = await this.request(
      'POST',
      `projects/${this.project}/secrets?secretId=${name}`,
      JSON.stringify({ replication: { automatic: {} } }),
    )
    if (!created.ok && created.status !== 409) throw backendStatusError('write', created.status)
    const versioned = await this.request(
      'POST',
      `projects/${this.project}/secrets/${name}:addVersion`,
      JSON.stringify({ payload: { data: value.toString('base64') } }),
    )
    if (!versioned.ok) throw backendStatusError('write', versioned.status)
  }

  async get(ref: string): Promise<Buffer | null> {
    const res = await this.request('GET', `projects/${this.project}/secrets/${this.name(ref)}/versions/latest:access`)
    if (res.status === 404) return null
    if (!res.ok) throw backendStatusError('read', res.status)
    const body = (await res.json()) as { payload?: { data?: string } }
    const data = body.payload?.data
    if (typeof data !== 'string') throw new SecretBackendError('secret backend returned an unexpected payload')
    return Buffer.from(data, 'base64')
  }

  async delete(ref: string): Promise<void> {
    const res = await this.request('DELETE', `projects/${this.project}/secrets/${this.name(ref)}`)
    if (!res.ok && res.status !== 404) throw backendStatusError('delete', res.status)
  }
}

// The custom contract: any HTTPS service exposing GET/PUT/DELETE {base}/secrets/{ref}
// with bearer auth and octet-stream bodies plugs in as a backend without code changes.
export class CustomBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'custom'
  private readonly baseUrl: string
  private readonly token: string

  constructor() {
    this.baseUrl = requireEnv('CARACAL_CUSTOM_SECRETS_URL').replace(/\/+$/, '')
    this.token = requireEnv('CARACAL_CUSTOM_SECRETS_TOKEN')
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }

  async put(ref: string, value: Buffer): Promise<void> {
    const res = await backendFetch(`${this.baseUrl}/secrets/${ref}`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(value),
    })
    if (!res.ok) throw backendStatusError('write', res.status)
  }

  async get(ref: string): Promise<Buffer | null> {
    const res = await backendFetch(`${this.baseUrl}/secrets/${ref}`, { headers: this.headers() })
    if (res.status === 404) return null
    if (!res.ok) throw backendStatusError('read', res.status)
    return Buffer.from(await res.arrayBuffer())
  }

  async delete(ref: string): Promise<void> {
    const res = await backendFetch(`${this.baseUrl}/secrets/${ref}`, { method: 'DELETE', headers: this.headers() })
    if (!res.ok && res.status !== 404) throw backendStatusError('delete', res.status)
  }
}
