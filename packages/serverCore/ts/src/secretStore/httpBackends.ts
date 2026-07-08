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

// External backend endpoints must be TLS so bearer credentials and payloads never
// cross the network in the clear; plain http is allowed only for loopback hosts,
// which keeps local development against a same-host backend working.
function httpsBaseUrl(name: string, raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol !== 'https:' && !loopback) throw new Error(`${name} must be an https URL`)
  return raw.replace(/\/+$/, '')
}

function fetchFailureReason(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error'
  const code = (err.cause as { code?: string } | undefined)?.code
  return code ?? err.name
}

async function backendFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    throw new SecretBackendError(`secret backend unreachable: ${fetchFailureReason(err)}`)
  }
}

function backendStatusError(operation: string, status: number): SecretBackendError {
  return new SecretBackendError(`secret backend ${operation} failed with status ${status}`)
}

// String-valued stores receive base64 payloads so envelope bytes survive every backend
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
    this.addr = httpsBaseUrl('CARACAL_VAULT_ADDR', requireEnv('CARACAL_VAULT_ADDR'))
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
    this.baseUrl = httpsBaseUrl('CARACAL_INFISICAL_URL', (process.env.CARACAL_INFISICAL_URL ?? '').trim() || 'https://app.infisical.com')
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

interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiresAt: number
}

// Azure Key Vault: refs become dashed secret names. Access tokens come from the AAD
// client-credentials flow when a client secret is configured, otherwise from the
// IMDS managed-identity endpoint, and are cached until shortly before expiry.
export class AzureKeyVaultBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'azurekeyvault'
  private readonly vaultUrl: string
  private readonly tenantId: string
  private readonly clientId: string
  private readonly clientSecret: string
  private cached: CachedToken | null = null

  constructor() {
    this.vaultUrl = httpsBaseUrl('CARACAL_AZURE_VAULT_URL', requireEnv('CARACAL_AZURE_VAULT_URL'))
    this.clientSecret = (process.env.CARACAL_AZURE_CLIENT_SECRET ?? '').trim()
    this.tenantId = this.clientSecret ? requireEnv('CARACAL_AZURE_TENANT_ID') : ''
    this.clientId = this.clientSecret ? requireEnv('CARACAL_AZURE_CLIENT_ID') : ''
  }

  private name(ref: string): string {
    return ref.replaceAll('/', '-')
  }

  // The IMDS endpoint is link-local and unroutable, reachable only from the VM or
  // pod itself, so plain http is the platform contract here.
  private tokenRequest(): { url: string; init: RequestInit } {
    if (this.clientSecret) {
      return {
        url: `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.clientId,
            client_secret: this.clientSecret,
            scope: 'https://vault.azure.net/.default',
          }).toString(),
        },
      }
    }
    return {
      url: 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net',
      init: { headers: { Metadata: 'true' } },
    }
  }

  private async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.value
    const { url, init } = this.tokenRequest()
    const res = await backendFetch(url, init)
    if (!res.ok) throw backendStatusError('auth', res.status)
    const body = (await res.json()) as { access_token?: string; expires_in?: number | string }
    if (!body.access_token) throw new SecretBackendError('secret backend auth returned no token')
    const ttlSeconds = Number(body.expires_in ?? 3600) || 3600
    this.cached = { value: body.access_token, expiresAt: Date.now() + ttlSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS }
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
// so the backend needs no SDK dependency. Credentials come from static environment keys
// or from the ECS/EKS container credentials endpoint, cached until shortly before expiry.
export class AwsSecretsManagerBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'awssecretsmanager'
  private readonly region: string
  private readonly containerCredentialsUrl: string
  private creds: AwsCredentials | null = null

  constructor() {
    this.region = (process.env.CARACAL_AWS_REGION ?? process.env.AWS_REGION ?? '').trim()
    if (!this.region) throw new Error('CARACAL_AWS_REGION or AWS_REGION is required for the configured secret backend')
    if ((process.env.AWS_ACCESS_KEY_ID ?? '').trim()) {
      this.containerCredentialsUrl = ''
      this.creds = {
        accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
        sessionToken: (process.env.AWS_SESSION_TOKEN ?? '').trim(),
        expiresAt: Number.POSITIVE_INFINITY,
      }
      return
    }
    // The container credentials endpoint (EKS Pod Identity / ECS task roles) is a
    // link-local or localhost address injected by the platform, so plain http is
    // the platform contract here.
    const full = (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ?? '').trim()
    const relative = (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? '').trim()
    if (full) this.containerCredentialsUrl = full
    else if (relative) this.containerCredentialsUrl = `http://169.254.170.2${relative}`
    else throw new Error('AWS_ACCESS_KEY_ID or a container credentials endpoint is required for the configured secret backend')
  }

  private async credentials(): Promise<AwsCredentials> {
    if (this.creds && Date.now() < this.creds.expiresAt) return this.creds
    const headers: Record<string, string> = {}
    const tokenFile = (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ?? '').trim()
    const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN ?? '').trim()
    if (token) headers.Authorization = token
    const res = await backendFetch(this.containerCredentialsUrl, { headers })
    if (!res.ok) throw backendStatusError('auth', res.status)
    const body = (await res.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string }
    if (!body.AccessKeyId || !body.SecretAccessKey) throw new SecretBackendError('secret backend auth returned no credentials')
    const expiration = body.Expiration ? Date.parse(body.Expiration) : Number.NaN
    this.creds = {
      accessKeyId: body.AccessKeyId,
      secretAccessKey: body.SecretAccessKey,
      sessionToken: body.Token ?? '',
      expiresAt: Number.isNaN(expiration) ? Date.now() + 3_600_000 - TOKEN_EXPIRY_SKEW_MS : expiration - TOKEN_EXPIRY_SKEW_MS,
    }
    return this.creds
  }

  private async call(target: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const creds = await this.credentials()
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
    if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken
    const signedHeaderNames = Object.keys(headers).sort()
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('')
    const signedHeaders = signedHeaderNames.join(';')
    const payloadHash = createHash('sha256').update(body).digest('hex')
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
    const scope = `${dateStamp}/${this.region}/secretsmanager/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
    const kDate = createHmac('sha256', `AWS4${creds.secretAccessKey}`).update(dateStamp).digest()
    const kRegion = createHmac('sha256', kDate).update(this.region).digest()
    const kService = createHmac('sha256', kRegion).update('secretsmanager').digest()
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest()
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
    const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
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

// Google Secret Manager: refs become dashed secret ids. Access tokens come from the
// service-account JWT bearer flow when a credentials file is configured, otherwise
// from the metadata server, and are cached until shortly before expiry.
export class GcpSecretManagerBackend implements SecretBackend {
  readonly kind: SecretBackendKind = 'gcpsecretmanager'
  private readonly project: string
  private readonly account: GcpServiceAccount | null
  private cached: CachedToken | null = null

  constructor() {
    this.project = requireEnv('CARACAL_GCP_PROJECT')
    const credentialsPath = (process.env.CARACAL_GCP_CREDENTIALS_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim()
    if (!credentialsPath) {
      this.account = null
      return
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
    const res = this.account ? await this.serviceAccountToken(this.account) : await this.metadataToken()
    if (!res.ok) throw backendStatusError('auth', res.status)
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new SecretBackendError('secret backend auth returned no token')
    this.cached = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - TOKEN_EXPIRY_SKEW_MS }
    return body.access_token
  }

  private serviceAccountToken(account: GcpServiceAccount): Promise<Response> {
    const now = Math.floor(Date.now() / 1000)
    const encode = (part: Record<string, unknown>): string => Buffer.from(JSON.stringify(part)).toString('base64url')
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    })}`
    const signature = createSign('RSA-SHA256').update(signingInput).sign(account.private_key).toString('base64url')
    return backendFetch(account.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${signingInput}.${signature}`,
      }).toString(),
    })
  }

  // The metadata server is link-local and unroutable, reachable only from the VM or
  // pod itself, so plain http is the platform contract here.
  private metadataToken(): Promise<Response> {
    return backendFetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
    })
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
    const added = (await versioned.json()) as { name?: string }
    await this.destroyPriorVersions(name, added.name ?? '')
  }

  // Secret Manager keeps every added version alive (and billed) until destroyed, and
  // reads only ever touch latest, so each write retires the versions before it.
  // Pruning is best effort: the value is already stored when it runs.
  private async destroyPriorVersions(name: string, currentVersion: string): Promise<void> {
    try {
      const listed = await this.request('GET', `projects/${this.project}/secrets/${name}/versions?filter=state:ENABLED`)
      if (!listed.ok) return
      const body = (await listed.json()) as { versions?: { name?: string }[] }
      for (const version of body.versions ?? []) {
        if (!version.name || version.name === currentVersion) continue
        await this.request('POST', `${version.name}:destroy`, '{}')
      }
    } catch {
      return
    }
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
    this.baseUrl = httpsBaseUrl('CARACAL_CUSTOM_SECRETS_URL', requireEnv('CARACAL_CUSTOM_SECRETS_URL'))
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
