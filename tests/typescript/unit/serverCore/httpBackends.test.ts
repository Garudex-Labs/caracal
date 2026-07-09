// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the external Secret Store backends: Vault, Infisical, Azure Key Vault, AWS Secrets Manager, Google Secret Manager, and custom.

import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AwsSecretsManagerBackend,
  AzureKeyVaultBackend,
  CustomBackend,
  GcpSecretManagerBackend,
  InfisicalBackend,
  VaultBackend,
} from '../../../../packages/serverCore/ts/src/secretStore/index.js'

const ENV_KEYS = [
  'CARACAL_VAULT_ADDR',
  'CARACAL_VAULT_TOKEN',
  'CARACAL_VAULT_MOUNT',
  'CARACAL_VAULT_NAMESPACE',
  'CARACAL_INFISICAL_URL',
  'CARACAL_INFISICAL_TOKEN',
  'CARACAL_INFISICAL_PROJECT_ID',
  'CARACAL_INFISICAL_ENV',
  'CARACAL_INFISICAL_PATH',
  'CARACAL_AZURE_VAULT_URL',
  'CARACAL_AZURE_TENANT_ID',
  'CARACAL_AZURE_CLIENT_ID',
  'CARACAL_AZURE_CLIENT_SECRET',
  'CARACAL_AWS_REGION',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'CARACAL_GCP_PROJECT',
  'CARACAL_GCP_CREDENTIALS_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CARACAL_CUSTOM_SECRETS_URL',
  'CARACAL_CUSTOM_SECRETS_TOKEN',
]

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  vi.unstubAllGlobals()
})

interface Recorded {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

let server: Server
let baseUrl: string
let recorded: Recorded[]
let handle: (req: Recorded) => { status?: number; body?: string | Buffer }

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const record: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
      recorded.push(record)
      const reply = handle(record)
      res.statusCode = reply.status ?? 200
      res.end(reply.body ?? '')
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolveClose) => server.close(resolveClose))
})

beforeEach(() => {
  recorded = []
  handle = () => ({ status: 404 })
})

interface FetchCall {
  url: string
  init: RequestInit
}

function stubFetch(route: (url: string, init: RequestInit) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(route(String(url), init))
  })
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const SECRET = Buffer.from('super-secret-envelope-bytes')

describe('VaultBackend', () => {
  it('rejects a missing address, a routable http address, and a malformed address', () => {
    expect(() => new VaultBackend()).toThrow('CARACAL_VAULT_ADDR is required')
    process.env.CARACAL_VAULT_ADDR = 'http://vault.internal:8200'
    process.env.CARACAL_VAULT_TOKEN = 'tok'
    expect(() => new VaultBackend()).toThrow('must be an https URL')
    process.env.CARACAL_VAULT_ADDR = 'not a url'
    expect(() => new VaultBackend()).toThrow('must be a valid URL')
  })

  it('writes sealed values under the configured mount with token and namespace headers', async () => {
    process.env.CARACAL_VAULT_ADDR = baseUrl
    process.env.CARACAL_VAULT_TOKEN = 'tok'
    process.env.CARACAL_VAULT_MOUNT = 'kv'
    process.env.CARACAL_VAULT_NAMESPACE = 'team-a'
    handle = () => ({ status: 200, body: '{}' })
    await new VaultBackend().put('zones/z1/providers/p1/secretConfig', SECRET)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].method).toBe('POST')
    expect(recorded[0].path).toBe('/v1/kv/data/zones/z1/providers/p1/secretConfig')
    expect(recorded[0].headers['x-vault-token']).toBe('tok')
    expect(recorded[0].headers['x-vault-namespace']).toBe('team-a')
    expect(JSON.parse(recorded[0].body.toString())).toEqual({ data: { value: SECRET.toString('base64') } })
  })

  it('reads values, maps 404 to null, and surfaces failures and malformed payloads', async () => {
    process.env.CARACAL_VAULT_ADDR = baseUrl
    process.env.CARACAL_VAULT_TOKEN = 'tok'
    const backend = new VaultBackend()
    handle = () => ({ status: 200, body: JSON.stringify({ data: { data: { value: SECRET.toString('base64') } } }) })
    const value = await backend.get('zones/z1/providers/p1/secretConfig')
    expect(value?.equals(SECRET)).toBe(true)
    expect(recorded[0].path).toBe('/v1/secret/data/zones/z1/providers/p1/secretConfig')
    handle = () => ({ status: 404 })
    expect(await backend.get('zones/z1/providers/gone/secretConfig')).toBeNull()
    handle = () => ({ status: 500 })
    await expect(backend.get('ref')).rejects.toThrow('secret backend read failed with status 500')
    handle = () => ({ status: 200, body: '{"data":{}}' })
    await expect(backend.get('ref')).rejects.toThrow('secret backend returned an unexpected payload')
  })

  it('surfaces write failures and tolerates deleting a missing secret', async () => {
    process.env.CARACAL_VAULT_ADDR = baseUrl
    process.env.CARACAL_VAULT_TOKEN = 'tok'
    const backend = new VaultBackend()
    handle = () => ({ status: 503 })
    await expect(backend.put('ref', SECRET)).rejects.toThrow('secret backend write failed with status 503')
    handle = () => ({ status: 404 })
    await backend.delete('ref')
    expect(recorded[1].method).toBe('DELETE')
    expect(recorded[1].path).toBe('/v1/secret/metadata/ref')
    handle = () => ({ status: 500 })
    await expect(backend.delete('ref')).rejects.toThrow('secret backend delete failed with status 500')
  })
})

describe('InfisicalBackend', () => {
  it('requires a token and a project id', () => {
    process.env.CARACAL_INFISICAL_URL = baseUrl
    expect(() => new InfisicalBackend()).toThrow('CARACAL_INFISICAL_TOKEN is required')
    process.env.CARACAL_INFISICAL_TOKEN = 'tok'
    expect(() => new InfisicalBackend()).toThrow('CARACAL_INFISICAL_PROJECT_ID is required')
  })

  it('reads dotted secret names scoped to the configured project, environment, and path', async () => {
    process.env.CARACAL_INFISICAL_URL = baseUrl
    process.env.CARACAL_INFISICAL_TOKEN = 'tok'
    process.env.CARACAL_INFISICAL_PROJECT_ID = 'proj-1'
    process.env.CARACAL_INFISICAL_ENV = 'staging'
    process.env.CARACAL_INFISICAL_PATH = '/caracal'
    const backend = new InfisicalBackend()
    handle = () => ({ status: 200, body: JSON.stringify({ secret: { secretValue: SECRET.toString('base64') } }) })
    const value = await backend.get('zones/z1/providers/p1/secretConfig')
    expect(value?.equals(SECRET)).toBe(true)
    const requested = new URL(`${baseUrl}${recorded[0].path}`)
    expect(requested.pathname).toBe('/api/v3/secrets/raw/zones.z1.providers.p1.secretConfig')
    expect(requested.searchParams.get('workspaceId')).toBe('proj-1')
    expect(requested.searchParams.get('environment')).toBe('staging')
    expect(requested.searchParams.get('secretPath')).toBe('/caracal')
    expect(recorded[0].headers.authorization).toBe('Bearer tok')
    handle = () => ({ status: 404 })
    expect(await backend.get('zones/z1/gone')).toBeNull()
    handle = () => ({ status: 500 })
    await expect(backend.get('ref')).rejects.toThrow('secret backend read failed with status 500')
    handle = () => ({ status: 200, body: '{"secret":{}}' })
    await expect(backend.get('ref')).rejects.toThrow('secret backend returned an unexpected payload')
  })

  it('creates on first write and falls back to update when the secret exists', async () => {
    process.env.CARACAL_INFISICAL_URL = baseUrl
    process.env.CARACAL_INFISICAL_TOKEN = 'tok'
    process.env.CARACAL_INFISICAL_PROJECT_ID = 'proj-1'
    const backend = new InfisicalBackend()
    handle = () => ({ status: 200, body: '{}' })
    await backend.put('zones/z1/providers/p1/secretConfig', SECRET)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].method).toBe('POST')
    expect(JSON.parse(recorded[0].body.toString())).toEqual({
      workspaceId: 'proj-1',
      environment: 'prod',
      secretPath: '/',
      secretValue: SECRET.toString('base64'),
      type: 'shared',
    })
    handle = (req) => ({ status: req.method === 'POST' ? 400 : 200, body: '{}' })
    recorded = []
    await backend.put('zones/z1/providers/p1/secretConfig', SECRET)
    expect(recorded.map((req) => req.method)).toEqual(['POST', 'PATCH'])
    handle = () => ({ status: 400 })
    await expect(backend.put('ref', SECRET)).rejects.toThrow('secret backend write failed with status 400')
  })

  it('tolerates deleting a missing secret and surfaces other delete failures', async () => {
    process.env.CARACAL_INFISICAL_URL = baseUrl
    process.env.CARACAL_INFISICAL_TOKEN = 'tok'
    process.env.CARACAL_INFISICAL_PROJECT_ID = 'proj-1'
    const backend = new InfisicalBackend()
    handle = () => ({ status: 404 })
    await backend.delete('zones/z1/providers/p1/secretConfig')
    expect(recorded[0].method).toBe('DELETE')
    handle = () => ({ status: 500 })
    await expect(backend.delete('ref')).rejects.toThrow('secret backend delete failed with status 500')
  })
})

describe('CustomBackend', () => {
  it('requires the base URL and bearer token', () => {
    expect(() => new CustomBackend()).toThrow('CARACAL_CUSTOM_SECRETS_URL is required')
    process.env.CARACAL_CUSTOM_SECRETS_URL = baseUrl
    expect(() => new CustomBackend()).toThrow('CARACAL_CUSTOM_SECRETS_TOKEN is required')
  })

  it('round-trips raw bytes through the REST contract with bearer auth', async () => {
    process.env.CARACAL_CUSTOM_SECRETS_URL = baseUrl
    process.env.CARACAL_CUSTOM_SECRETS_TOKEN = 'tok'
    const backend = new CustomBackend()
    handle = () => ({ status: 200 })
    await backend.put('zones/z1/providers/p1/secretConfig', SECRET)
    expect(recorded[0].method).toBe('PUT')
    expect(recorded[0].path).toBe('/secrets/zones/z1/providers/p1/secretConfig')
    expect(recorded[0].headers.authorization).toBe('Bearer tok')
    expect(recorded[0].headers['content-type']).toBe('application/octet-stream')
    expect(recorded[0].body.equals(SECRET)).toBe(true)
    handle = () => ({ status: 200, body: SECRET })
    const value = await backend.get('zones/z1/providers/p1/secretConfig')
    expect(value?.equals(SECRET)).toBe(true)
    handle = () => ({ status: 404 })
    expect(await backend.get('zones/z1/gone')).toBeNull()
    await backend.delete('zones/z1/gone')
    handle = () => ({ status: 500 })
    await expect(backend.get('ref')).rejects.toThrow('secret backend read failed with status 500')
    await expect(backend.put('ref', SECRET)).rejects.toThrow('secret backend write failed with status 500')
    await expect(backend.delete('ref')).rejects.toThrow('secret backend delete failed with status 500')
  })

  it('maps connection failures to an unreachable error', async () => {
    const closed = createServer(() => {})
    await new Promise<void>((resolveListen) => closed.listen(0, '127.0.0.1', resolveListen))
    const port = (closed.address() as AddressInfo).port
    await new Promise((resolveClose) => closed.close(resolveClose))
    process.env.CARACAL_CUSTOM_SECRETS_URL = `http://127.0.0.1:${port}`
    process.env.CARACAL_CUSTOM_SECRETS_TOKEN = 'tok'
    await expect(new CustomBackend().get('ref')).rejects.toThrow('secret backend unreachable')
  })
})

describe('AzureKeyVaultBackend', () => {
  it('validates the vault URL and the client-credentials configuration', () => {
    expect(() => new AzureKeyVaultBackend()).toThrow('CARACAL_AZURE_VAULT_URL is required')
    process.env.CARACAL_AZURE_VAULT_URL = 'http://vault.azure.internal'
    expect(() => new AzureKeyVaultBackend()).toThrow('must be an https URL')
    process.env.CARACAL_AZURE_VAULT_URL = 'https://vault.example'
    process.env.CARACAL_AZURE_CLIENT_SECRET = 's3cret'
    expect(() => new AzureKeyVaultBackend()).toThrow('CARACAL_AZURE_TENANT_ID is required')
    process.env.CARACAL_AZURE_TENANT_ID = 'tenant-1'
    expect(() => new AzureKeyVaultBackend()).toThrow('CARACAL_AZURE_CLIENT_ID is required')
  })

  it('exchanges client credentials for a token once and reads dashed secret names', async () => {
    process.env.CARACAL_AZURE_VAULT_URL = 'https://vault.example'
    process.env.CARACAL_AZURE_CLIENT_SECRET = 's3cret'
    process.env.CARACAL_AZURE_TENANT_ID = 'tenant-1'
    process.env.CARACAL_AZURE_CLIENT_ID = 'client-1'
    const calls = stubFetch((url) => {
      if (url.startsWith('https://login.microsoftonline.com/')) return jsonResponse({ access_token: 'azure-token', expires_in: 3600 })
      return jsonResponse({ value: SECRET.toString('base64') })
    })
    const backend = new AzureKeyVaultBackend()
    const value = await backend.get('zones/z1/providers/p1/secretConfig')
    expect(value?.equals(SECRET)).toBe(true)
    expect(calls[0].url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token')
    const form = new URLSearchParams(calls[0].init.body as string)
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe('client-1')
    expect(form.get('client_secret')).toBe('s3cret')
    expect(form.get('scope')).toBe('https://vault.azure.net/.default')
    expect(calls[1].url).toBe('https://vault.example/secrets/zones-z1-providers-p1-secretConfig?api-version=7.4')
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer azure-token')
    await backend.get('zones/z1/providers/p1/secretConfig')
    expect(calls.filter((call) => call.url.startsWith('https://login.microsoftonline.com/')).length).toBe(1)
  })

  it('uses the IMDS managed-identity endpoint when no client secret is configured', async () => {
    process.env.CARACAL_AZURE_VAULT_URL = 'https://vault.example'
    const calls = stubFetch((url) => {
      if (url.startsWith('http://169.254.169.254/')) return jsonResponse({ access_token: 'imds-token', expires_in: '3600' })
      return jsonResponse({ value: SECRET.toString('base64') })
    })
    const value = await new AzureKeyVaultBackend().get('cfg')
    expect(value?.equals(SECRET)).toBe(true)
    expect(calls[0].url).toContain('http://169.254.169.254/metadata/identity/oauth2/token')
    expect((calls[0].init.headers as Record<string, string>).Metadata).toBe('true')
  })

  it('surfaces auth failures, missing tokens, and secret read failures', async () => {
    process.env.CARACAL_AZURE_VAULT_URL = 'https://vault.example'
    stubFetch(() => jsonResponse({}, 403))
    await expect(new AzureKeyVaultBackend().get('cfg')).rejects.toThrow('secret backend auth failed with status 403')
    stubFetch(() => jsonResponse({}))
    await expect(new AzureKeyVaultBackend().get('cfg')).rejects.toThrow('secret backend auth returned no token')
    const route = (status: number, body: unknown) =>
      stubFetch((url) =>
        url.startsWith('http://169.254.169.254/') ? jsonResponse({ access_token: 't', expires_in: 60 }) : jsonResponse(body, status),
      )
    route(404, {})
    expect(await new AzureKeyVaultBackend().get('cfg')).toBeNull()
    route(500, {})
    await expect(new AzureKeyVaultBackend().get('cfg')).rejects.toThrow('secret backend read failed with status 500')
    route(200, {})
    await expect(new AzureKeyVaultBackend().get('cfg')).rejects.toThrow('secret backend returned an unexpected payload')
    route(500, {})
    await expect(new AzureKeyVaultBackend().put('cfg', SECRET)).rejects.toThrow('secret backend write failed with status 500')
    route(404, {})
    await new AzureKeyVaultBackend().delete('cfg')
    route(500, {})
    await expect(new AzureKeyVaultBackend().delete('cfg')).rejects.toThrow('secret backend delete failed with status 500')
  })
})

describe('AwsSecretsManagerBackend', () => {
  it('requires a region and a credentials source', () => {
    expect(() => new AwsSecretsManagerBackend()).toThrow('CARACAL_AWS_REGION or AWS_REGION is required')
    process.env.AWS_REGION = 'us-east-1'
    expect(() => new AwsSecretsManagerBackend()).toThrow('AWS_ACCESS_KEY_ID or a container credentials endpoint is required')
  })

  it('signs GetSecretValue requests with a verifiable SigV4 signature', async () => {
    process.env.CARACAL_AWS_REGION = 'us-east-1'
    process.env.AWS_ACCESS_KEY_ID = 'AKID'
    process.env.AWS_SECRET_ACCESS_KEY = 'sk'
    process.env.AWS_SESSION_TOKEN = 'st'
    const calls = stubFetch(() => jsonResponse({ SecretString: SECRET.toString('base64') }))
    const value = await new AwsSecretsManagerBackend().get('zones/z1/providers/p1/secretConfig')
    expect(value?.equals(SECRET)).toBe(true)
    expect(calls[0].url).toBe('https://secretsmanager.us-east-1.amazonaws.com/')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-amz-target']).toBe('secretsmanager.GetSecretValue')
    expect(headers['x-amz-security-token']).toBe('st')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ SecretId: 'zones/z1/providers/p1/secretConfig' })
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(headers.authorization)![1]
    const names = signedHeaders.split(';')
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('')
    const payloadHash = createHash('sha256')
      .update(calls[0].init.body as string)
      .digest('hex')
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
    const dateStamp = headers['x-amz-date'].slice(0, 8)
    const scope = `${dateStamp}/us-east-1/secretsmanager/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      headers['x-amz-date'],
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')
    const kDate = createHmac('sha256', 'AWS4sk').update(dateStamp).digest()
    const kRegion = createHmac('sha256', kDate).update('us-east-1').digest()
    const kService = createHmac('sha256', kRegion).update('secretsmanager').digest()
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest()
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
    expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKID/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`)
  })

  it('maps ResourceNotFoundException to null reads and tolerated deletes', async () => {
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_ACCESS_KEY_ID = 'AKID'
    process.env.AWS_SECRET_ACCESS_KEY = 'sk'
    stubFetch(() => jsonResponse({ __type: 'com.amazonaws.secretsmanager#ResourceNotFoundException' }, 400))
    const backend = new AwsSecretsManagerBackend()
    expect(await backend.get('gone')).toBeNull()
    await backend.delete('gone')
    stubFetch(() => new Response('not json', { status: 500 }))
    await expect(new AwsSecretsManagerBackend().get('ref')).rejects.toThrow('secret backend read failed with status 500')
    stubFetch(() => jsonResponse({}, 200))
    await expect(new AwsSecretsManagerBackend().get('ref')).rejects.toThrow('secret backend returned an unexpected payload')
    stubFetch(() => jsonResponse({}, 500))
    await expect(new AwsSecretsManagerBackend().delete('ref')).rejects.toThrow('secret backend delete failed with status 500')
  })

  it('updates existing secrets and creates missing ones on write', async () => {
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_ACCESS_KEY_ID = 'AKID'
    process.env.AWS_SECRET_ACCESS_KEY = 'sk'
    let calls = stubFetch(() => jsonResponse({}))
    await new AwsSecretsManagerBackend().put('ref', SECRET)
    expect(calls).toHaveLength(1)
    expect((calls[0].init.headers as Record<string, string>)['x-amz-target']).toBe('secretsmanager.PutSecretValue')
    calls = stubFetch((_url, init) => {
      const target = (init.headers as Record<string, string>)['x-amz-target']
      if (target === 'secretsmanager.PutSecretValue') return jsonResponse({ __type: 'ResourceNotFoundException' }, 400)
      return jsonResponse({})
    })
    await new AwsSecretsManagerBackend().put('ref', SECRET)
    expect(calls).toHaveLength(2)
    expect((calls[1].init.headers as Record<string, string>)['x-amz-target']).toBe('secretsmanager.CreateSecret')
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ Name: 'ref', SecretString: SECRET.toString('base64') })
    stubFetch(() => jsonResponse({}, 500))
    await expect(new AwsSecretsManagerBackend().put('ref', SECRET)).rejects.toThrow('secret backend write failed with status 500')
  })

  it('fetches container credentials once, forwarding the platform authorization token', async () => {
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'http://169.254.170.23/v1/creds'
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = 'Bearer pod-token'
    const expiration = new Date(Date.now() + 3_600_000).toISOString()
    const calls = stubFetch((url) => {
      if (url === 'http://169.254.170.23/v1/creds')
        return jsonResponse({ AccessKeyId: 'AKID', SecretAccessKey: 'sk', Token: 'st', Expiration: expiration })
      return jsonResponse({ SecretString: SECRET.toString('base64') })
    })
    const backend = new AwsSecretsManagerBackend()
    expect((await backend.get('ref'))?.equals(SECRET)).toBe(true)
    expect((await backend.get('ref'))?.equals(SECRET)).toBe(true)
    const credentialCalls = calls.filter((call) => call.url === 'http://169.254.170.23/v1/creds')
    expect(credentialCalls).toHaveLength(1)
    expect((credentialCalls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer pod-token')
  })

  it('reads the container authorization token from a file and surfaces credential failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-aws-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'Bearer file-token\n')
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/creds'
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = tokenFile
    try {
      const calls = stubFetch((url) => {
        if (url === 'http://169.254.170.2/v2/creds') return jsonResponse({}, 403)
        return jsonResponse({})
      })
      await expect(new AwsSecretsManagerBackend().get('ref')).rejects.toThrow('secret backend auth failed with status 403')
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer file-token')
      stubFetch(() => jsonResponse({ AccessKeyId: '', SecretAccessKey: '' }))
      await expect(new AwsSecretsManagerBackend().get('ref')).rejects.toThrow('secret backend auth returned no credentials')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const GCP_KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

describe('GcpSecretManagerBackend', () => {
  let credentialsDir: string

  beforeAll(() => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'caracal-gcp-'))
  })

  afterAll(() => {
    rmSync(credentialsDir, { recursive: true, force: true })
  })

  function credentialsFile(name: string, account: Record<string, string>): string {
    const path = join(credentialsDir, name)
    writeFileSync(path, JSON.stringify(account))
    return path
  }

  it('requires a project and a complete service account file', () => {
    expect(() => new GcpSecretManagerBackend()).toThrow('CARACAL_GCP_PROJECT is required')
    process.env.CARACAL_GCP_PROJECT = 'proj-1'
    process.env.CARACAL_GCP_CREDENTIALS_FILE = credentialsFile('partial.json', { client_email: 'sa@example' })
    expect(() => new GcpSecretManagerBackend()).toThrow('missing client_email or private_key')
  })

  it('uses the metadata server flow when no credentials file is configured', async () => {
    process.env.CARACAL_GCP_PROJECT = 'proj-1'
    const calls = stubFetch((url) => {
      if (url.startsWith('http://metadata.google.internal/')) return jsonResponse({ access_token: 'metadata-token', expires_in: 300 })
      return jsonResponse({ payload: { data: SECRET.toString('base64') } })
    })
    const value = await new GcpSecretManagerBackend().get('zones/z1/providers/p1/secretConfig')
    expect(value?.equals(SECRET)).toBe(true)
    expect(calls[0].url).toBe('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token')
    expect((calls[0].init.headers as Record<string, string>)['Metadata-Flavor']).toBe('Google')
    expect(calls[1].url).toBe(
      'https://secretmanager.googleapis.com/v1/projects/proj-1/secrets/zones-z1-providers-p1-secretConfig/versions/latest:access',
    )
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer metadata-token')
  })

  it('signs a verifiable service-account JWT assertion and caches the token', async () => {
    process.env.CARACAL_GCP_PROJECT = 'proj-1'
    process.env.CARACAL_GCP_CREDENTIALS_FILE = credentialsFile('sa.json', {
      client_email: 'sa@proj.iam.gserviceaccount.example',
      private_key: GCP_KEYS.privateKey,
      token_uri: 'https://token.gcp.example/token',
    })
    const calls = stubFetch((url) => {
      if (url === 'https://token.gcp.example/token') return jsonResponse({ access_token: 'gcp-token', expires_in: 3600 })
      return jsonResponse({ payload: { data: SECRET.toString('base64') } })
    })
    const backend = new GcpSecretManagerBackend()
    expect((await backend.get('cfg'))?.equals(SECRET)).toBe(true)
    expect((await backend.get('cfg'))?.equals(SECRET)).toBe(true)
    const tokenCalls = calls.filter((call) => call.url === 'https://token.gcp.example/token')
    expect(tokenCalls).toHaveLength(1)
    const form = new URLSearchParams(tokenCalls[0].init.body as string)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [header, claims, signature] = form.get('assertion')!.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const parsedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString())
    expect(parsedClaims.iss).toBe('sa@proj.iam.gserviceaccount.example')
    expect(parsedClaims.aud).toBe('https://token.gcp.example/token')
    expect(parsedClaims.scope).toBe('https://www.googleapis.com/auth/cloud-platform')
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(GCP_KEYS.publicKey, Buffer.from(signature, 'base64url'))
    expect(verified).toBe(true)
  })

  it('surfaces auth failures and read failures, and maps 404 to null', async () => {
    process.env.CARACAL_GCP_PROJECT = 'proj-1'
    stubFetch(() => jsonResponse({}, 403))
    await expect(new GcpSecretManagerBackend().get('cfg')).rejects.toThrow('secret backend auth failed with status 403')
    stubFetch(() => jsonResponse({}))
    await expect(new GcpSecretManagerBackend().get('cfg')).rejects.toThrow('secret backend auth returned no token')
    const route = (status: number, body: unknown) =>
      stubFetch((url) =>
        url.startsWith('http://metadata.google.internal/')
          ? jsonResponse({ access_token: 't', expires_in: 60 })
          : jsonResponse(body, status),
      )
    route(404, {})
    expect(await new GcpSecretManagerBackend().get('cfg')).toBeNull()
    route(500, {})
    await expect(new GcpSecretManagerBackend().get('cfg')).rejects.toThrow('secret backend read failed with status 500')
    route(200, {})
    await expect(new GcpSecretManagerBackend().get('cfg')).rejects.toThrow('secret backend returned an unexpected payload')
    route(404, {})
    await new GcpSecretManagerBackend().delete('cfg')
    route(500, {})
    await expect(new GcpSecretManagerBackend().delete('cfg')).rejects.toThrow('secret backend delete failed with status 500')
  })

  it('writes a version, tolerates the existing secret, and destroys prior versions best effort', async () => {
    process.env.CARACAL_GCP_PROJECT = 'proj-1'
    const paths: string[] = []
    stubFetch((url) => {
      if (url.startsWith('http://metadata.google.internal/')) return jsonResponse({ access_token: 't', expires_in: 60 })
      const path = url.replace('https://secretmanager.googleapis.com/v1/', '')
      paths.push(path)
      if (path === 'projects/proj-1/secrets?secretId=cfg') return jsonResponse({}, 409)
      if (path === 'projects/proj-1/secrets/cfg:addVersion') return jsonResponse({ name: 'projects/proj-1/secrets/cfg/versions/3' })
      if (path === 'projects/proj-1/secrets/cfg/versions?filter=state:ENABLED')
        return jsonResponse({
          versions: [{ name: 'projects/proj-1/secrets/cfg/versions/2' }, { name: 'projects/proj-1/secrets/cfg/versions/3' }],
        })
      return jsonResponse({})
    })
    await new GcpSecretManagerBackend().put('cfg', SECRET)
    expect(paths).toEqual([
      'projects/proj-1/secrets?secretId=cfg',
      'projects/proj-1/secrets/cfg:addVersion',
      'projects/proj-1/secrets/cfg/versions?filter=state:ENABLED',
      'projects/proj-1/secrets/cfg/versions/2:destroy',
    ])
    stubFetch((url) =>
      url.startsWith('http://metadata.google.internal/') ? jsonResponse({ access_token: 't', expires_in: 60 }) : jsonResponse({}, 500),
    )
    await expect(new GcpSecretManagerBackend().put('cfg', SECRET)).rejects.toThrow('secret backend write failed with status 500')
    stubFetch((url) => {
      if (url.startsWith('http://metadata.google.internal/')) return jsonResponse({ access_token: 't', expires_in: 60 })
      if (url.endsWith(':addVersion')) return jsonResponse({}, 500)
      return jsonResponse({})
    })
    await expect(new GcpSecretManagerBackend().put('cfg', SECRET)).rejects.toThrow('secret backend write failed with status 500')
    stubFetch((url) => {
      if (url.startsWith('http://metadata.google.internal/')) return jsonResponse({ access_token: 't', expires_in: 60 })
      if (url.includes('versions?filter=')) return jsonResponse({}, 500)
      return jsonResponse({ name: 'projects/proj-1/secrets/cfg/versions/1' })
    })
    await new GcpSecretManagerBackend().put('cfg', SECRET)
  })
})
