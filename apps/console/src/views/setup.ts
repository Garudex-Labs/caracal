// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Guided first setup workflow for production-shaped Caracal onboarding.

import type { Application, PolicyVersion, Resource, Zone } from '@caracalai/admin'
import { generateClientSecret } from '@caracalai/engine'
import {
  DEFAULT_COORDINATOR_URL,
  DEFAULT_ZONE_URL,
  defaultRuntimeConfigPath,
} from '@caracalai/engine/runtime-config'
import { dirname, join } from 'node:path'
import { maskSecretField } from '../errors.ts'
import type { App, View } from '../screen.ts'
import { DetailView } from './detail.ts'
import { FormView } from './form.ts'
import type { Ctx } from './factory.ts'

const DEFAULT_GATEWAY_URL = 'http://localhost:8081'

interface SetupValues {
  zone_name?: string
  agent_app_name?: string
  resource_identifier?: string
  resource_name?: string
  resource_scopes?: string
  upstream_url?: string
  provider_id?: string
  activate_policy?: string
  generate_profile?: string
  profile_path?: string
  secret_file_path?: string
  credential_env?: string
}

interface SetupResult {
  zone: Zone | { id: string; name: string }
  application: Application
  clientSecret: string
  resource: Resource
  policy?: {
    id: string
    name: string
    version: PolicyVersion
    policy_set_id: string
    policy_set_version_id: string
  }
  profile?: {
    path: string
    secretPath: string
    credentialEnv: string
    content: string
  }
}

export function firstSetupView(ctx: Ctx): View {
  return new FormView({
    title: 'first setup',
    submitLabel: 'create',
    fields: [
      {
        key: 'zone_name',
        label: 'zone name',
        kind: 'text',
        hint: ctx.zoneId ? 'leave blank to use the selected zone' : 'required because no zone is selected',
      },
      { key: 'agent_app_name', label: 'agent app', kind: 'text', required: true },
      { key: 'resource_identifier', label: 'resource ID', kind: 'text', required: true },
      { key: 'resource_name', label: 'resource name', kind: 'text', hint: 'optional display name' },
      { key: 'resource_scopes', label: 'scopes', kind: 'list', required: true, hint: 'comma-separated scopes this resource accepts' },
      { key: 'upstream_url', label: 'upstream URL', kind: 'text', hint: 'optional; creates a Gateway route when set' },
      { key: 'provider_id', label: 'provider ID', kind: 'text', hint: 'optional existing provider credential source' },
      { key: 'activate_policy', label: 'activate policy', kind: 'bool', default: 'true' },
      { key: 'generate_profile', label: 'runtime profile', kind: 'bool', default: 'true' },
      { key: 'profile_path', label: 'profile path', kind: 'text', default: defaultRuntimeConfigPath() },
      { key: 'secret_file_path', label: 'secret file', kind: 'text', hint: 'optional; derived from profile path when blank' },
      { key: 'credential_env', label: 'token env', kind: 'text', hint: 'optional; derived from the resource ID when blank' },
    ],
    onSubmit: async (raw, app) => {
      const result = await runFirstSetup(ctx, raw, app)
      app.pop()
      app.push(new DetailView({
        title: 'first setup result',
        load: async () => setupSummary(result),
        mask: maskSecretField,
      }))
    },
  })
}

async function runFirstSetup(ctx: Ctx, values: SetupValues, app: App): Promise<SetupResult> {
  const zone = await ensureZone(ctx, values, app)
  const agentAppName = requiredText(values.agent_app_name, 'agent app is required')
  const resourceIdentifier = requiredText(values.resource_identifier, 'resource ID is required')
  const scopes = splitList(values.resource_scopes)
  if (scopes.length === 0) throw new Error('at least one resource scope is required')

  const clientSecret = generateClientSecret()
  const application = await ctx.client.applications.create(zone.id, {
    name: agentAppName,
    registration_method: 'managed',
    credential_type: 'token',
    client_secret: clientSecret,
    consent: false,
  })

  const upstreamUrl = trimmed(values.upstream_url)
  const resource = await ctx.client.resources.create(zone.id, {
    identifier: resourceIdentifier,
    name: trimmed(values.resource_name),
    scopes,
    upstream_url: upstreamUrl,
    gateway_application_id: upstreamUrl ? application.id : undefined,
    credential_provider_id: trimmed(values.provider_id),
    prefix: upstreamUrl ? true : undefined,
  })

  const policy = bool(values.activate_policy) ? await createFirstPolicy(ctx, zone.id, application.id, resource.identifier, scopes) : undefined
  const profile = bool(values.generate_profile) ? buildProfile(values, agentAppName, zone.id, application.id, resource.identifier, upstreamUrl) : undefined

  return { zone, application, clientSecret, resource, policy, profile }
}

async function ensureZone(ctx: Ctx, values: SetupValues, app: App): Promise<Zone | { id: string; name: string }> {
  const zoneName = trimmed(values.zone_name)
  if (!zoneName && ctx.zoneId) {
    return ctx.client.zones.get(ctx.zoneId)
  }
  if (!zoneName) throw new Error('zone name is required when no zone is selected')
  const zone = await ctx.client.zones.create({ name: zoneName })
  ctx.onZoneSelect?.(zone.id, zone.slug)
  app.setStatus(`zone set to ${zone.slug}`)
  return zone
}

async function createFirstPolicy(
  ctx: Ctx,
  zoneId: string,
  applicationId: string,
  resourceIdentifier: string,
  scopes: string[],
): Promise<SetupResult['policy']> {
  const policy = await ctx.client.policies.create(zoneId, {
    name: 'First access policy',
    description: 'Allows the configured agent app to request the configured protected resource.',
    content: firstAccessPolicy(applicationId, resourceIdentifier, scopes),
  })
  const policySet = await ctx.client.policySets.create(zoneId, 'First access policy set', 'Active policy set created by first setup.')
  const version = await ctx.client.policySets.addVersion(zoneId, policySet.id, [{ policy_version_id: policy.version.id }])
  await ctx.client.policySets.activate(zoneId, policySet.id, version.id)
  return {
    id: policy.id,
    name: policy.name,
    version: policy.version,
    policy_set_id: policySet.id,
    policy_set_version_id: version.id,
  }
}

function firstAccessPolicy(applicationId: string, resourceIdentifier: string, scopes: string[]): string {
  const allowedScopes = scopes.map((scope) => quoteRego(scope)).join(', ')
  return `package caracal.authz

import rego.v1

default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}

allowed_scopes := {${allowedScopes}}

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "first-access"}], "diagnostics": []} if {
  input.principal.id == ${quoteRego(applicationId)}
  input.resource.identifier == ${quoteRego(resourceIdentifier)}
  every scope in input.context.requested_scopes {
    scope in allowed_scopes
  }
}
`
}

function buildProfile(
  values: SetupValues,
  agentAppName: string,
  zoneId: string,
  applicationId: string,
  resourceIdentifier: string,
  upstreamUrl: string | undefined,
): SetupResult['profile'] {
  const path = trimmed(values.profile_path) ?? defaultRuntimeConfigPath()
  const secretPath = trimmed(values.secret_file_path) ?? join(dirname(path), `${safeName(agentAppName)}-client-secret`)
  const credentialEnv = trimmed(values.credential_env) ?? credentialEnvName(resourceIdentifier)
  const stsUrl = process.env.CARACAL_STS_URL ?? process.env.CARACAL_ZONE_URL ?? DEFAULT_ZONE_URL
  const coordinatorUrl = process.env.CARACAL_COORDINATOR_URL ?? DEFAULT_COORDINATOR_URL
  const gatewayUrl = process.env.CARACAL_GATEWAY_URL ?? DEFAULT_GATEWAY_URL
  const lines = [
    `zone_url = ${quoteToml(stsUrl)}`,
    `sts_url = ${quoteToml(stsUrl)}`,
    `coordinator_url = ${quoteToml(coordinatorUrl)}`,
    `gateway_url = ${quoteToml(gatewayUrl)}`,
    `zone_id = ${quoteToml(zoneId)}`,
    `application_id = ${quoteToml(applicationId)}`,
    `app_client_secret_file = ${quoteToml(secretPath)}`,
    'continue_on_failure = false',
    '',
    '[[credentials]]',
    `env = ${quoteToml(credentialEnv)}`,
    `resource = ${quoteToml(resourceIdentifier)}`,
  ]
  if (upstreamUrl) lines.push(`upstream_prefix = ${quoteToml(upstreamUrl)}`)
  return { path, secretPath, credentialEnv, content: lines.join('\n') + '\n' }
}

function setupSummary(result: SetupResult): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    outcome: result.policy ? 'ready for first protected run' : 'objects created; activate a policy before requesting access',
    zone: {
      id: result.zone.id,
      name: result.zone.name,
    },
    agent_app: {
      id: result.application.id,
      name: result.application.name,
      client_secret: result.clientSecret,
      note: 'Store client_secret now. It cannot be retrieved later.',
    },
    protected_resource: {
      id: result.resource.id,
      identifier: result.resource.identifier,
      scopes: result.resource.scopes,
      gateway_route: result.resource.gateway_application_id ? 'enabled' : 'not configured',
    },
  }
  if (result.policy) {
    summary.access_policy = {
      policy_id: result.policy.id,
      policy_version_id: result.policy.version.id,
      policy_set_id: result.policy.policy_set_id,
      active_policy_set_version_id: result.policy.policy_set_version_id,
    }
  }
  if (result.profile) {
    summary.runtime_profile = {
      path: result.profile.path,
      secret_file: result.profile.secretPath,
      token_env: result.profile.credentialEnv,
      content: result.profile.content,
      next_steps: [
        'Write the masked client_secret value to the secret_file path with owner-only permissions.',
        'Write the profile content to the profile path.',
        'Run your workload through caracal run with CARACAL_CONFIG set to the profile path.',
      ],
    }
  }
  summary.audit_explanation = {
    first_success: 'After the first protected call, open Audit, select the request, and use Explain to view the policy decision and Gateway result.',
    if_no_event: 'Re-check the active policy, resource identifier, Gateway route, and runtime profile before retrying.',
  }
  return summary
}

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function bool(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'true'
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

function requiredText(value: string | undefined, message: string): string {
  const text = trimmed(value)
  if (!text) throw new Error(message)
  return text
}

function quoteRego(value: string): string {
  return JSON.stringify(value)
}

function quoteToml(value: string): string {
  return JSON.stringify(value)
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || 'caracal-app'
}

function credentialEnvName(resourceIdentifier: string): string {
  const body = resourceIdentifier.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const normalized = body.length > 0 ? body : 'RESOURCE'
  return `CARACAL_${normalized}_TOKEN`
}
