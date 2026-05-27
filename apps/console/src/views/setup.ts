// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Guided first setup workflow for production-shaped Caracal onboarding.

import type { Application, PolicyVersion, Provider, ProviderKind, Resource, ResourceInput, Zone } from '@caracalai/admin'
import type { JsonObject } from '@caracalai/core'
import { DEFAULT_CONTROL_AUDIENCE, generateClientSecret } from '@caracalai/engine'
import {
  DEFAULT_COORDINATOR_URL,
  DEFAULT_ZONE_URL,
  defaultRuntimeConfigPath,
} from '@caracalai/engine/runtime-config'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { truncate, ui } from '../ansi.ts'
import type { Key } from '../keys.ts'
import { maskSecretField, scrubTokens } from '../errors.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { DetailView } from './detail.ts'
import { FormView, type Field } from './form.ts'
import { infoPage, openInfo } from './info.ts'
import { EntityPickerView } from './picker.ts'
import type { Ctx } from './factory.ts'

const DEFAULT_GATEWAY_URL = 'http://localhost:8081'
const PROVIDER_KINDS: ProviderKind[] = ['oauth2', 'oidc', 'apikey', 'workload']

interface SetupValues {
  zone_mode?: string
  selected_zone_id?: string
  zone_name?: string
  application_mode?: string
  selected_agent_app_id?: string
  agent_app_name?: string
  existing_app_client_secret?: string
  resource_mode?: string
  selected_resource_id?: string
  resource_identifier?: string
  resource_name?: string
  resource_scopes?: string
  upstream_url?: string
  request_path?: string
  advanced_options?: string
  provider_mode?: string
  selected_provider_id?: string
  provider_name?: string
  provider_identifier?: string
  provider_kind?: string
  provider_issuer?: string
  provider_authorization_endpoint?: string
  provider_token_endpoint?: string
  provider_upstream_oauth_scopes?: string
  provider_api_key_header?: string
  provider_workload_audience?: string
  provider_client_id?: string
  provider_allowed_token_hosts?: string
  provider_auth_scheme?: string
  provider_forward_caracal_identity?: string
  policy_mode?: string
  activate_policy?: string
  generate_profile?: string
  write_files?: string
  overwrite_files?: string
  profile_path?: string
  secret_file_path?: string
  credential_env?: string
}

interface ProfileTarget {
  path: string
  secretPath: string
  credentialEnv: string
}

interface SetupResult {
  zone: Zone | { id: string; name: string }
  zoneCreated: boolean
  application: Application
  applicationCreated: boolean
  clientSecret?: string
  resource: Resource
  resourceCreated: boolean
  resourceUpdated: boolean
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
    gatewayUrl: string
    content: string
  }
  fileWrite?: {
    status: 'written' | 'failed' | 'skipped'
    profile_path?: string
    secret_file?: string
    overwrite?: boolean
    error?: string
  }
  requestPath?: string
}

export function firstSetupView(ctx: Ctx): View {
  return new FirstSetupWizardView(ctx)
}

type SetupStepKey = 'zone' | 'application' | 'provider' | 'resource' | 'policy' | 'review'

interface SetupStep {
  key: SetupStepKey
  title: string
  explanation: string
}

class FirstSetupWizardView implements View {
  readonly title = 'guided setup'
  readonly isTextEntry = false
  private readonly ctx: Ctx
  private step: SetupStepKey = 'zone'
  private values: SetupValues = {
    zone_mode: 'create',
    application_mode: 'create',
    provider_mode: 'create',
    resource_mode: 'create',
    policy_mode: 'create',
    activate_policy: 'true',
    generate_profile: 'true',
    write_files: 'false',
    overwrite_files: 'false',
    profile_path: defaultRuntimeConfigPath(),
    provider_kind: 'oauth2',
    provider_forward_caracal_identity: 'false',
  }
  private selectedZone: Zone | undefined
  private selectedApplication: Application | undefined
  private selectedResource: Resource | undefined
  private selectedProvider: Provider | undefined
  private submitting = false

  constructor(ctx: Ctx) {
    this.ctx = ctx
  }

  async init(app: App): Promise<void> {
    if (!this.ctx.zoneId) return
    this.selectedZone = await this.ctx.client.zones.get(this.ctx.zoneId)
    this.values.selected_zone_id = this.selectedZone.id
    app.invalidate()
  }

  hints(): string[] {
    if (this.submitting) return []
    return this.step === 'review'
      ? ['enter:create', '↑/↓:steps', 'A:advanced', '?:guide', 'esc:cancel']
      : ['enter:open page', '↑/↓:steps', 'A:advanced', '?:guide', 'esc:cancel']
  }

  render(ctx: ViewContext): string[] {
    this.normalizeStep()
    const steps = this.steps()
    const step = this.currentStep()
    const lines: string[] = [
      '',
      ' ' + ui.title(`Step ${steps.indexOf(this.step) + 1} of ${steps.length}: ${step.title}`),
      ' ' + ui.muted(step.explanation),
      '',
      ' ' + ui.accent('+-- guided path -----------------------------------------------------------+'),
      ' ' + ui.muted('| Open each page, fill the guided fields, press ? for field help, then save. |'),
      ' ' + ui.accent('+------------------------------------------------------------------------+'),
      '',
    ]
    for (const item of steps) {
      const active = item === this.step
      const mark = active ? '> ' : '  '
      const label = this.stepTitle(item)
      lines.push(` ${active ? ui.accent(mark) : mark}${ui.muted(label.padEnd(18))}${this.stepStatus(item)}`)
    }
    lines.push('')
    if (this.step === 'review') lines.push(' ' + ui.key('enter') + ui.muted(':create setup  ') + ui.key('A') + ui.muted(':advanced'))
    else lines.push(' ' + ui.key('enter') + ui.muted(':open guided page  ') + ui.key('?') + ui.muted(':step guide'))
    if (this.submitting) lines.push('', ' ' + ui.muted('creating setup...'))
    return lines.map((line) => truncate(line, ctx.size.cols))
  }

  async onKey(key: Key, ctx: ViewContext): Promise<void> {
    if (this.submitting) return
    this.normalizeStep()
    if (key === 'esc') {
      ctx.app.pop()
      return
    }
    if (key === 'A') {
      this.openAdvanced(ctx.app)
      return
    }
    if (key === '?') {
      this.openStepInfo(ctx.app)
      return
    }
    if (key === 'left' || key === 'up') {
      this.previousStep()
      return
    }
    if (key === 'right' || key === 'down' || key === 'tab') {
      this.nextVisibleStep()
      return
    }
    if (this.step === 'review') {
      if (key === 'enter') await this.create(ctx.app)
      return
    }
    if (key === 'enter') this.openStepPage(ctx.app)
  }

  private currentStep(): SetupStep {
    const steps: Record<SetupStepKey, SetupStep> = {
      zone: {
        key: 'zone',
        title: 'Zone',
        explanation: 'Choose the boundary where this onboarding will create or select every object.',
      },
      application: {
        key: 'application',
        title: 'Agent app',
        explanation: 'Create or select the workload identity that will request access.',
      },
      provider: {
        key: 'provider',
        title: 'Provider',
        explanation: 'Create or select the external credential source before defining the resource that will use it.',
      },
      resource: {
        key: 'resource',
        title: 'Resource',
        explanation: 'Create or select the protected API, OAuth audience, gRPC service, MCP server, or SDK capability.',
      },
      policy: {
        key: 'policy',
        title: 'Access policy',
        explanation: 'Choose whether setup should create the starter least-privilege allow-list policy.',
      },
      review: {
        key: 'review',
        title: 'Review and create',
        explanation: 'Check the setup plan, then create the missing objects and first access policy.',
      },
    }
    return steps[this.step]
  }

  private steps(): SetupStepKey[] {
    const steps: SetupStepKey[] = []
    if (!this.selectedZone) steps.push('zone')
    steps.push('application', 'provider', 'resource', 'policy')
    steps.push('review')
    return steps
  }

  private normalizeStep(): void {
    const steps = this.steps()
    if (!steps.includes(this.step)) this.step = steps[0] ?? 'review'
  }

  private stepTitle(step: SetupStepKey): string {
    return this.stepDefinition(step).title
  }

  private stepDefinition(step: SetupStepKey): SetupStep {
    const current = this.step
    this.step = step
    const definition = this.currentStep()
    this.step = current
    return definition
  }

  private stepStatus(step: SetupStepKey): string {
    if (step === 'zone') return this.selectedZone ? `${zoneLabel(this.selectedZone)} selected` : trimmed(this.values.zone_name) ? `${this.values.zone_name} will be created` : ui.muted('open page')
    if (step === 'application') return this.selectedApplication ? `${this.selectedApplication.name} selected` : trimmed(this.values.agent_app_name) ? `${this.values.agent_app_name} will be created` : ui.muted('open page')
    if (step === 'provider') return this.providerReviewLabel()
    if (step === 'resource') return this.selectedResource ? `${resourceLabel(this.selectedResource)} selected` : trimmed(this.values.resource_name) ? `${this.values.resource_name} will be created` : ui.muted('open page')
    if (step === 'policy') return bool(this.values.activate_policy) ? 'create starter allow-list' : 'skip; no access allowed yet'
    return this.validateReady() ? ui.muted('complete required pages first') : 'ready'
  }

  private nextVisibleStep(): void {
    const steps = this.steps()
    const index = steps.indexOf(this.step)
    this.step = steps[Math.min(index + 1, steps.length - 1)] ?? 'review'
  }

  private previousStep(): void {
    const steps = this.steps()
    const index = steps.indexOf(this.step)
    this.step = steps[Math.max(0, index - 1)] ?? 'review'
  }

  private clearZoneDependents(): void {
    this.clearApplicationSelection()
    this.clearResourceSelection()
    this.clearProviderSelection()
  }

  private clearApplicationSelection(): void {
    this.selectedApplication = undefined
    this.values.selected_agent_app_id = ''
    this.values.existing_app_client_secret = ''
  }

  private clearResourceSelection(): void {
    this.selectedResource = undefined
    this.values.selected_resource_id = ''
    this.values.resource_scopes = ''
    this.values.upstream_url = ''
    this.clearProviderSelection()
  }

  private clearProviderSelection(): void {
    this.selectedProvider = undefined
    this.values.selected_provider_id = ''
    this.values.provider_name = ''
    this.clearProviderCreateValues()
  }

  private clearProviderCreateValues(): void {
    this.values.provider_identifier = ''
    this.values.provider_kind = 'oauth2'
    this.clearProviderTypeValues()
  }

  private clearProviderTypeValues(): void {
    this.values.provider_issuer = ''
    this.values.provider_token_endpoint = ''
    this.values.provider_api_key_header = ''
    this.values.provider_workload_audience = ''
    this.values.provider_client_id = ''
    this.values.provider_authorization_endpoint = ''
    this.values.provider_upstream_oauth_scopes = ''
    this.values.provider_allowed_token_hosts = ''
    this.values.provider_auth_scheme = ''
    this.values.provider_forward_caracal_identity = 'false'
  }

  private currentZoneId(): string | undefined {
    return this.selectedZone?.id ?? trimmed(this.values.selected_zone_id) ?? this.ctx.zoneId
  }

  private hasProviderSelection(): boolean {
    return this.values.provider_mode !== 'none' && Boolean(trimmed(this.values.selected_provider_id) ?? trimmed(this.values.provider_name))
  }

  private openStepPage(app: App): void {
    if (this.step === 'zone') this.openZonePage(app)
    else if (this.step === 'application') this.openApplicationPage(app)
    else if (this.step === 'provider') this.openProviderPage(app)
    else if (this.step === 'resource') this.openResourcePage(app)
    else if (this.step === 'policy') this.openPolicyPage(app)
  }

  private openZonePage(app: App): void {
    app.push(new FormView({
      title: 'guided setup / zone',
      submitLabel: 'save zone',
      info: guidedInfo('Zone setup', 'A zone is the workspace boundary for apps, providers, resources, policies, and grants.', 'Team Payments production', 'Create a named zone or pick an existing zone.', 'The selected zone is used by every later setup page.'),
      fields: [
        { key: 'zone_mode', label: 'zone action', kind: 'select', options: ['create', 'select'], default: this.values.zone_mode ?? 'create', info: guidedInfo('Zone action', 'Choose whether setup should create a zone or reuse one.', 'select when the production zone already exists', 'create or select', 'Setup either stores the typed zone name or resolves the picked zone ID.') },
        { key: 'zone_name', label: 'zone name', kind: 'text', required: true, default: this.values.zone_name ?? '', dependsOn: { zone_mode: 'create' }, info: guidedInfo('Zone name', 'Human-readable boundary name for this workload or team.', 'Payments Production', 'Short text, not an internal ID.', 'Console creates the zone before creating apps, providers, and resources.') },
        { key: 'selected_zone_id', label: 'existing zone', kind: 'text', required: true, default: this.values.selected_zone_id ?? '', dependsOn: { zone_mode: 'select' }, pick: zonePicker(this.ctx), resolve: zoneResolver(this.ctx), info: guidedInfo('Existing zone', 'Pick the zone that should own this setup.', 'Payments Production', 'Use the picker instead of typing an ID.', 'Console resolves the zone and skips zone creation.') },
      ],
      onSubmit: async (raw, formApp) => {
        Object.assign(this.values, raw)
        if (raw.zone_mode === 'select') {
          this.selectedZone = await this.ctx.client.zones.get(requiredText(raw.selected_zone_id, 'zone is required'))
          this.values.zone_name = ''
        } else {
          this.selectedZone = undefined
          this.values.selected_zone_id = ''
          this.clearZoneDependents()
        }
        formApp.pop()
        this.step = 'application'
      },
    }))
  }

  private openApplicationPage(app: App): void {
    const zoneId = this.currentZoneId()
    if (!zoneId && !trimmed(this.values.zone_name)) {
      app.setStatus('complete the zone page before the agent app page', 'error')
      return
    }
    app.push(new FormView({
      title: 'guided setup / agent app',
      submitLabel: 'save app',
      info: guidedInfo('Agent app setup', 'The app is the workload identity that receives Caracal tokens.', 'payments-worker', 'Create a managed token app or pick an existing app.', 'Setup creates or selects this app before policies and runtime profile output are generated.'),
      fields: [
        { key: 'application_mode', label: 'app action', kind: 'select', options: ['create', 'select'], default: this.values.application_mode ?? 'create', info: guidedInfo('App action', 'Choose whether setup should create the workload app or reuse one.', 'create for a first worker service', 'create or select', 'Console uses the app as the requesting principal in the generated policy.') },
        { key: 'agent_app_name', label: 'app name', kind: 'text', required: true, default: this.values.agent_app_name ?? '', dependsOn: { application_mode: 'create' }, info: guidedInfo('App name', 'Name of the workload that will request resource access.', 'payments-worker', 'Short text, not an internal ID.', 'Console creates a managed token app and reveals its one-time client secret in the result.') },
        { key: 'selected_agent_app_id', label: 'existing app', kind: 'text', required: true, default: this.values.selected_agent_app_id ?? '', dependsOn: { application_mode: 'select' }, pick: applicationPicker(this.ctx, () => this.currentZoneId()), resolve: applicationResolver(this.ctx, () => this.currentZoneId()), info: guidedInfo('Existing app', 'Pick an app that already represents this workload.', 'payments-worker', 'Use the picker instead of typing an ID.', 'Console uses the selected app in the generated policy and profile.') },
        { key: 'existing_app_client_secret', label: 'existing app secret', kind: 'text', default: this.values.existing_app_client_secret ?? '', dependsOn: { application_mode: 'select' }, advanced: true, info: guidedInfo('Existing app secret', 'Client secrets cannot be retrieved later, so file writing needs the existing secret.', 'cs_live_...', 'Secret text from your secure store.', 'If profile file writing is enabled, Console writes this secret to the generated secret file.') },
      ],
      onSubmit: async (raw, formApp) => {
        Object.assign(this.values, raw)
        if (raw.application_mode === 'select') {
          const id = requiredText(raw.selected_agent_app_id, 'agent app is required')
          this.selectedApplication = zoneId ? await this.ctx.client.applications.get(zoneId, id) : undefined
          this.values.agent_app_name = ''
        } else {
          this.clearApplicationSelection()
          this.values.agent_app_name = raw.agent_app_name
        }
        formApp.pop()
        this.step = 'provider'
      },
    }))
  }

  private openProviderPage(app: App): void {
    const zoneId = this.currentZoneId()
    if (!zoneId && !trimmed(this.values.zone_name)) {
      app.setStatus('complete the zone page before the provider page', 'error')
      return
    }
    app.push(new FormView({
      title: 'guided setup / provider',
      submitLabel: 'save provider',
      info: guidedInfo('Provider setup', 'A provider describes the upstream credential source Caracal will use for an external service.', 'Okta OAuth provider for the payments API', 'Create, select, or choose none for direct Caracal resources.', 'Setup creates or links the provider before the resource page so the resource can attach it cleanly.'),
      fields: [
        { key: 'provider_mode', label: 'provider action', kind: 'select', options: ['create', 'select', 'none'], default: this.values.provider_mode ?? 'create', info: guidedInfo('Provider action', 'Most external resources need a provider; direct resources can choose none.', 'create for a new OAuth provider', 'create, select, or none', 'Console either creates a provider, links an existing provider, or leaves the resource direct.') },
        { key: 'selected_provider_id', label: 'existing provider', kind: 'text', required: true, default: this.values.selected_provider_id ?? '', dependsOn: { provider_mode: 'select' }, pick: providerPicker(this.ctx, () => this.currentZoneId()), resolve: providerResolver(this.ctx, () => this.currentZoneId()), info: guidedInfo('Existing provider', 'Pick the provider that supplies upstream credentials.', 'Okta OAuth', 'Use the picker instead of typing an ID.', 'The resource page can attach this provider to the Gateway route.') },
        { key: 'provider_name', label: 'provider name', kind: 'text', required: true, default: this.values.provider_name ?? '', dependsOn: { provider_mode: 'create' }, info: guidedInfo('Provider name', 'Human-readable name for the upstream credential source.', 'Okta Payments OAuth', 'Short text, not an internal ID.', 'Console creates this provider before creating the resource.') },
        { key: 'provider_kind', label: 'provider type', kind: 'select', options: PROVIDER_KINDS, default: this.values.provider_kind ?? 'oauth2', dependsOn: { provider_mode: 'create' }, info: guidedInfo('Provider type', 'Type controls which credential fields are required.', 'oauth2 for a token endpoint; apikey for header injection', 'oauth2, oidc, apikey, or workload', 'The form hides irrelevant fields and validates only the selected provider type.') },
        { key: 'provider_issuer', label: 'issuer', kind: 'text', required: true, default: this.values.provider_issuer ?? '', dependsOn: { provider_mode: 'create', provider_kind: ['oidc', 'workload'] }, info: guidedInfo('Issuer', 'Authority URL for OIDC discovery or workload identity trust.', 'https://login.example.com', 'Absolute HTTPS issuer URL.', 'Console stores it in provider config for token validation or exchange.') },
        { key: 'provider_token_endpoint', label: 'token endpoint', kind: 'text', required: true, default: this.values.provider_token_endpoint ?? '', dependsOn: { provider_mode: 'create', provider_kind: ['oauth2', 'oidc', 'workload'] }, info: guidedInfo('Token endpoint', 'Endpoint where Gateway exchanges or refreshes upstream tokens.', 'https://login.example.com/oauth/token', 'Absolute HTTPS URL.', 'Console infers allowed token hosts from this URL unless Advanced overrides them.') },
        { key: 'provider_api_key_header', label: 'API key header', kind: 'text', required: true, default: this.values.provider_api_key_header ?? '', dependsOn: { provider_mode: 'create', provider_kind: 'apikey' }, info: guidedInfo('API key header', 'Header where the upstream API expects its key.', 'X-API-Key', 'HTTP header name.', 'Gateway uses this header when calling the upstream API.') },
        { key: 'provider_workload_audience', label: 'audience', kind: 'text', required: true, default: this.values.provider_workload_audience ?? '', dependsOn: { provider_mode: 'create', provider_kind: 'workload' }, info: guidedInfo('Audience', 'Audience value expected by the workload identity provider.', 'api://payments', 'Exact audience string from the provider.', 'Console stores it in provider config for token exchange.') },
        { key: 'provider_identifier', label: 'identifier', kind: 'text', default: this.values.provider_identifier ?? '', dependsOn: { provider_mode: 'create' }, advanced: true, info: guidedInfo('Provider identifier', 'Stable provider identifier used by APIs and audit output.', 'provider://okta-payments', 'Leave blank to generate from provider name.', 'Console sends this identifier when creating the provider.') },
        { key: 'provider_client_id', label: 'client ID', kind: 'text', default: this.values.provider_client_id ?? '', dependsOn: { provider_mode: 'create', provider_kind: ['oauth2', 'oidc'] }, advanced: true, info: guidedInfo('Client ID', 'OAuth client identifier when the provider requires one.', 'payments-client', 'Provider-issued client ID.', 'Console stores it on the provider for token exchange flows.') },
        { key: 'provider_authorization_endpoint', label: 'authorization endpoint', kind: 'text', default: this.values.provider_authorization_endpoint ?? '', dependsOn: { provider_mode: 'create', provider_kind: ['oauth2', 'oidc'] }, advanced: true, info: guidedInfo('Authorization endpoint', 'Browser authorization URL for providers with consent flows.', 'https://login.example.com/oauth/authorize', 'Absolute HTTPS URL.', 'Console stores it only for flows that need authorization redirects.') },
        { key: 'provider_upstream_oauth_scopes', label: 'upstream OAuth scopes', kind: 'list', default: this.values.provider_upstream_oauth_scopes ?? '', dependsOn: { provider_mode: 'create', provider_kind: ['oauth2', 'oidc'] }, advanced: true, info: guidedInfo('Upstream OAuth scopes', 'Provider-side scopes requested from the external OAuth server.', 'payments.read,payments.write', 'Comma-separated provider scopes.', 'These stay separate from Caracal resource scopes used by policy.') },
        { key: 'provider_allowed_token_hosts', label: 'allowed token hosts', kind: 'list', default: this.values.provider_allowed_token_hosts ?? '', dependsOn: { provider_mode: 'create', provider_kind: ['oauth2', 'oidc', 'workload'] }, advanced: true, info: guidedInfo('Allowed token hosts', 'Host allow-list for token exchange endpoints.', 'login.example.com', 'Comma-separated host names.', 'Blank uses the host inferred from token endpoint.') },
        { key: 'provider_auth_scheme', label: 'auth scheme', kind: 'text', default: this.values.provider_auth_scheme ?? '', dependsOn: { provider_mode: 'create', provider_kind: 'apikey' }, advanced: true, info: guidedInfo('Auth scheme', 'Optional prefix for API-key authorization values.', 'Bearer', 'Short scheme name, or blank for raw key.', 'Gateway formats provider credentials using this scheme when needed.') },
        { key: 'provider_forward_caracal_identity', label: 'forward Caracal identity', kind: 'bool', default: this.values.provider_forward_caracal_identity ?? 'false', dependsOn: { provider_mode: 'create' }, advanced: true, info: guidedInfo('Forward Caracal identity', 'Forward selected Caracal identity context to the upstream provider.', 'Enable for an internal broker that trusts Caracal identity.', 'Boolean toggle.', 'Provider config records the forwarding preference.') },
      ],
      onSubmit: async (raw, formApp) => {
        Object.assign(this.values, raw)
        if (raw.provider_mode === 'select') {
          const id = requiredText(raw.selected_provider_id, 'provider is required')
          this.selectedProvider = zoneId ? await this.ctx.client.providers.get(zoneId, id) : undefined
          this.values.provider_name = ''
        } else if (raw.provider_mode === 'none') {
          this.clearProviderSelection()
          this.values.provider_mode = 'none'
        } else {
          this.selectedProvider = undefined
          this.values.selected_provider_id = ''
        }
        formApp.pop()
        this.step = 'resource'
      },
    }))
  }

  private openResourcePage(app: App): void {
    const zoneId = this.currentZoneId()
    if (!zoneId && !trimmed(this.values.zone_name)) {
      app.setStatus('complete the zone page before the resource page', 'error')
      return
    }
    app.push(new FormView({
      title: 'guided setup / resource',
      submitLabel: 'save resource',
      info: guidedInfo('Resource setup', 'A resource is the protected target the app will request and policy will evaluate.', 'payments-api with read/write scopes', 'Create or select a protected resource and define Caracal scopes.', 'Setup creates or updates the resource, links the provider when selected, and uses it in the generated policy.'),
      fields: [
        { key: 'resource_mode', label: 'resource action', kind: 'select', options: ['create', 'select'], default: this.values.resource_mode ?? 'create', info: guidedInfo('Resource action', 'Choose whether setup should create a protected resource or reuse one.', 'create for a new API target', 'create or select', 'Console uses this resource as the policy target and runtime credential resource.') },
        { key: 'selected_resource_id', label: 'existing resource', kind: 'text', required: true, default: this.values.selected_resource_id ?? '', dependsOn: { resource_mode: 'select' }, pick: resourcePicker(this.ctx, () => this.currentZoneId()), resolve: resourceResolver(this.ctx, () => this.currentZoneId()), info: guidedInfo('Existing resource', 'Pick the protected target that already exists.', 'payments-api', 'Use the picker instead of typing an ID.', 'Console can update scopes, Gateway URL, and provider link when needed.') },
        { key: 'resource_name', label: 'resource name', kind: 'text', required: true, default: this.values.resource_name ?? '', dependsOn: { resource_mode: 'create' }, info: guidedInfo('Resource name', 'Human-readable target name for the API, service, MCP server, or SDK capability.', 'payments-api', 'Short text, not an internal ID.', 'Console creates a resource identifier from this name unless Advanced overrides it.') },
        { key: 'resource_scopes', label: 'Caracal scopes', kind: 'list', required: (current) => current.resource_mode === 'create', default: this.values.resource_scopes ?? '', info: guidedInfo('Caracal scopes', 'Permissions that Caracal policy evaluates for this resource.', 'payments.read,payments.refund', 'Comma-separated Caracal scope names.', 'Console writes these scopes to the resource and generated allow-list policy.') },
        { key: 'upstream_url', label: 'external upstream URL', kind: 'text', required: () => this.hasProviderSelection(), default: this.values.upstream_url ?? '', info: guidedInfo('External upstream URL', 'Gateway target for the protected external service.', 'https://api.payments.example.com', 'Absolute URL; leave blank only for direct Caracal resources.', 'Console enables Gateway routing and attaches the selected provider when present.') },
        { key: 'resource_identifier', label: 'resource identifier', kind: 'text', default: this.values.resource_identifier ?? '', dependsOn: { resource_mode: 'create' }, advanced: true, info: guidedInfo('Resource identifier', 'Stable identifier used in tokens, policy input, SDK config, and audit.', 'resource://payments-api', 'Leave blank to generate from resource name.', 'Console stores this as the policy resource target.') },
        { key: 'request_path', label: 'first request path', kind: 'text', default: this.values.request_path ?? '', dependsOn: 'upstream_url', advanced: true, info: guidedInfo('First request path', 'Optional path used only to show an exact first Gateway curl command.', '/v1/refunds', 'Path starting with /, or blank.', 'The result page includes a ready-to-copy request example.') },
      ],
      onSubmit: async (raw, formApp) => {
        Object.assign(this.values, raw)
        if (raw.resource_mode === 'select') {
          const id = requiredText(raw.selected_resource_id, 'resource is required')
          this.selectedResource = zoneId ? await this.ctx.client.resources.get(zoneId, id) : undefined
          this.values.resource_name = ''
          if (this.selectedResource) {
            this.values.resource_scopes = raw.resource_scopes || (this.selectedResource.scopes ?? []).join(',')
            this.values.upstream_url = raw.upstream_url || (this.selectedResource.upstream_url ?? '')
            this.values.selected_provider_id = this.values.selected_provider_id || (this.selectedResource.credential_provider_id ?? '')
          }
        } else {
          this.selectedResource = undefined
          this.values.selected_resource_id = ''
        }
        formApp.pop()
        this.step = 'policy'
      },
    }))
  }

  private openPolicyPage(app: App): void {
    app.push(new FormView({
      title: 'guided setup / access policy',
      submitLabel: 'save policy choice',
      info: guidedInfo('Access policy setup', 'The starter policy is a real deny-by-default allow-list for the selected app, resource, and Caracal scopes.', 'Allow payments-worker to request payments.read on payments-api.', 'Choose create for first success or skip when a security team will author policy separately.', 'Console creates the policy only after this page is saved with create selected.'),
      fields: [
        { key: 'policy_mode', label: 'policy action', kind: 'select', options: ['create', 'skip'], default: bool(this.values.activate_policy) ? 'create' : 'skip', info: guidedInfo('Policy action', 'Choose whether guided setup should create the first access rule.', 'create for a least-privilege starter allow-list', 'create or skip', 'Create activates a real policy set; skip leaves access denied until a policy is added later.') },
      ],
      onSubmit: async (raw, formApp) => {
        this.values.policy_mode = raw.policy_mode
        this.values.activate_policy = raw.policy_mode === 'skip' ? 'false' : 'true'
        formApp.pop()
        this.step = 'review'
      },
    }))
  }

  private openAdvanced(app: App): void {
    const values = this.values
    app.push(new FormView({
      title: 'guided setup advanced',
      submitLabel: 'save',
      info: guidedInfo('Guided setup advanced', 'Optional final setup controls stay separate from object-building pages.', 'Disable profile generation for CI-only setup.', 'Every field can keep its default unless you need a non-standard setup.', 'Saving updates the final create behavior without changing the object pages.'),
      fields: [
        { key: 'generate_profile', label: 'runtime profile', kind: 'bool', default: values.generate_profile ?? 'true', info: guidedInfo('Runtime profile', 'Generate a runnable local profile from the selected zone, app, and resource.', 'Enabled for local first run.', 'Boolean toggle.', 'The result page shows profile content and setup commands.') },
        { key: 'write_files', label: 'write profile files', kind: 'bool', default: values.write_files ?? 'false', dependsOn: { generate_profile: 'true' }, info: guidedInfo('Write profile files', 'Write the generated profile and secret file locally.', 'Enable on a trusted workstation.', 'Boolean toggle.', 'Console writes owner-only files instead of only showing copy commands.') },
        { key: 'existing_app_client_secret', label: 'existing app secret', kind: 'text', default: values.existing_app_client_secret ?? '', visible: () => Boolean(this.selectedApplication), required: (current) => current.write_files === 'true', dependsOn: { generate_profile: 'true', write_files: 'true' }, info: guidedInfo('Existing app secret', 'Required only when writing files for a selected existing app.', 'cs_live_...', 'Existing client secret from your secure store.', 'Console writes this value to the generated secret file.') },
        { key: 'overwrite_files', label: 'overwrite files', kind: 'bool', default: values.overwrite_files ?? 'false', dependsOn: { generate_profile: 'true', write_files: 'true' }, info: guidedInfo('Overwrite files', 'Allow Console to replace existing generated files.', 'Enable only when refreshing a local setup.', 'Boolean toggle.', 'When disabled, Console refuses to overwrite existing files.') },
        { key: 'profile_path', label: 'profile path', kind: 'text', default: values.profile_path ?? defaultRuntimeConfigPath(), dependsOn: { generate_profile: 'true' }, info: guidedInfo('Profile path', 'Local path for the generated runtime profile.', '~/.config/caracal/config.toml', 'Absolute or user-relative file path.', 'The profile path is used in generated CARACAL_CONFIG commands.') },
        { key: 'secret_file_path', label: 'secret file', kind: 'text', default: values.secret_file_path ?? '', dependsOn: { generate_profile: 'true' }, info: guidedInfo('Secret file', 'Local file that stores the app client secret.', '~/.config/caracal/payments-worker-client-secret', 'File path different from profile path; blank derives one.', 'SDKs and runtime read the app secret from this file.') },
        { key: 'credential_env', label: 'token env', kind: 'text', default: values.credential_env ?? '', dependsOn: { generate_profile: 'true' }, info: guidedInfo('Token env', 'Environment variable name that receives the protected resource token.', 'CARACAL_RESOURCE_PAYMENTS_API_TOKEN', 'Uppercase env var name; blank derives one.', 'Generated examples use this variable for Gateway and SDK calls.') },
      ],
      onSubmit: async (raw, advancedApp) => {
        Object.assign(this.values, raw)
        advancedApp.pop()
      },
    }))
  }

  private openStepInfo(app: App): void {
    const step = this.currentStep()
    openInfo(app, infoPage({
      title: step.title,
      meaning: step.explanation,
      when: step.key === 'review' ? 'Use this after completing the object pages and advanced settings.' : 'Open this page to fill the real fields for that object with picker and field-level help.',
      example: step.key === 'provider' ? 'Create an OAuth provider before creating the payments API resource.' : 'Use the page fields and press ? on any field for examples.',
      valid: 'Press enter to open the page. Use pickers for existing objects and normal field validation for new objects.',
      after: step.key === 'review' ? 'Console creates only missing objects, activates the selected policy path, and shows setup output.' : 'Saving the page returns here and moves to the next guided step.',
    }))
  }

  private async create(app: App): Promise<void> {
    const message = this.validateAll()
    if (message) {
      app.setStatus(message, 'error')
      return
    }
    this.submitting = true
    app.invalidate()
    try {
      const result = await runFirstSetup(this.ctx, this.buildValues(), app)
      app.pop()
      app.push(new DetailView({
        title: 'first setup result',
        load: async () => setupSummary(result),
        mask: maskSecretField,
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      app.setStatus(scrubTokens(msg), 'error')
      this.submitting = false
      app.invalidate()
    }
  }

  private validateAll(): string | undefined {
    return this.validateReady()
  }

  private buildValues(): SetupValues {
    return {
      ...this.values,
      selected_zone_id: this.selectedZone?.id,
      zone_name: this.selectedZone ? '' : this.values.zone_name,
      selected_agent_app_id: this.selectedApplication?.id,
      agent_app_name: this.selectedApplication ? '' : this.values.agent_app_name,
      selected_resource_id: this.selectedResource?.id,
      resource_name: this.selectedResource ? '' : this.values.resource_name,
      selected_provider_id: this.selectedProvider?.id ?? this.values.selected_provider_id,
      provider_name: this.selectedProvider ? '' : this.values.provider_name,
    }
  }

  private providerReviewLabel(): string {
    if (this.selectedResource?.credential_provider_id) return this.selectedResource.credential_provider_id
    if (this.selectedProvider) return `${providerLabel(this.selectedProvider)} (selected)`
    if (this.values.provider_mode === 'none') return 'none; direct resource'
    if (trimmed(this.values.provider_name)) return `${this.values.provider_name} (${providerKind(this.values.provider_kind)} create)`
    const selectedProviderId = trimmed(this.values.selected_provider_id)
    if (selectedProviderId) return selectedProviderId
    return ui.muted('open page')
  }

  private validateReady(): string | undefined {
    if (!this.selectedZone && !trimmed(this.values.selected_zone_id) && !trimmed(this.values.zone_name) && !this.ctx.zoneId) return 'zone is required'
    if (!this.selectedApplication && !trimmed(this.values.selected_agent_app_id) && !trimmed(this.values.agent_app_name)) return 'agent app is required'
    if (this.values.provider_mode === 'select' && !trimmed(this.values.selected_provider_id)) return 'provider is required'
    if (this.values.provider_mode === 'create') {
      if (!trimmed(this.values.provider_name)) return 'provider is required'
      try {
        providerConfigFromValues(this.values)
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    }
    if (!this.selectedResource && !trimmed(this.values.selected_resource_id) && !trimmed(this.values.resource_name)) return 'resource is required'
    if (splitList(this.values.resource_scopes).length === 0) return 'at least one Caracal scope is required'
    if (this.hasProviderSelection() && !trimmed(this.values.upstream_url)) return 'external upstream URL is required when a provider is selected'
    return undefined
  }
}

async function runFirstSetup(ctx: Ctx, values: SetupValues, app: App): Promise<SetupResult> {
  const scopes = splitList(values.resource_scopes)
  if (scopes.length === 0) throw new Error('at least one Caracal scope is required')
  const shouldGenerateProfile = boolDefault(values.generate_profile, true)
  const writeFiles = shouldGenerateProfile && boolDefault(values.write_files, false)
  const overwriteFiles = boolDefault(values.overwrite_files, false)
  if (writeFiles && values.selected_agent_app_id && !trimmed(values.existing_app_client_secret)) {
    throw new Error('client secret is required to write files for an existing agent app')
  }

  const existingZoneId = trimmed(values.selected_zone_id) ?? (!trimmed(values.zone_name) ? ctx.zoneId : undefined)
  const applicationName = await setupApplicationName(ctx, existingZoneId, values)
  const targetResourceIdentifier = await setupResourceIdentifier(ctx, existingZoneId, values)
  const target = shouldGenerateProfile
    ? profileTarget(values, applicationName, targetResourceIdentifier)
    : undefined
  if (writeFiles && target) await assertWritableTarget(target, overwriteFiles)

  const zoneResult = await ensureZone(ctx, values, app)
  const applicationResult = await ensureApplication(ctx, zoneResult.zone.id, values)
  const upstreamUrl = trimmed(values.upstream_url)
  const providerId = await ensureProvider(ctx, zoneResult.zone.id, values, upstreamUrl)
  const resourceResult = await ensureResource(ctx, zoneResult.zone.id, applicationResult.application.id, values, scopes, upstreamUrl, providerId)

  const policy = bool(values.activate_policy)
    ? await createFirstPolicy(ctx, zoneResult.zone.id, applicationResult.application.id, resourceResult.resource.identifier, scopes)
    : undefined
  const profile = target
    ? buildProfile(target, zoneResult.zone.id, applicationResult.application.id, resourceResult.resource.identifier, upstreamUrl)
    : undefined
  const requestPath = normalizeRequestPath(values.request_path)
  const fileWrite = profile
    ? await setupFileWrite(profile, applicationResult.clientSecret, writeFiles, overwriteFiles)
    : undefined

  return {
    zone: zoneResult.zone,
    zoneCreated: zoneResult.created,
    application: applicationResult.application,
    applicationCreated: applicationResult.created,
    clientSecret: applicationResult.created ? applicationResult.clientSecret : undefined,
    resource: resourceResult.resource,
    resourceCreated: resourceResult.created,
    resourceUpdated: resourceResult.updated,
    policy,
    profile,
    fileWrite,
    requestPath,
  }
}

async function ensureZone(
  ctx: Ctx,
  values: SetupValues,
  app: App,
): Promise<{ zone: Zone | { id: string; name: string }; created: boolean }> {
  const selectedZoneId = trimmed(values.selected_zone_id)
  if (selectedZoneId) return { zone: await ctx.client.zones.get(selectedZoneId), created: false }
  const zoneName = trimmed(values.zone_name)
  if (!zoneName && ctx.zoneId) {
    return { zone: await ctx.client.zones.get(ctx.zoneId), created: false }
  }
  if (!zoneName) throw new Error('zone name is required when no zone is selected')
  const zone = await ctx.client.zones.create({ name: zoneName })
  ctx.onZoneSelect?.(zone.id, zone.slug)
  app.setStatus(`zone set to ${zone.slug}`)
  return { zone, created: true }
}

async function ensureApplication(
  ctx: Ctx,
  zoneId: string,
  values: SetupValues,
): Promise<{ application: Application; created: boolean; clientSecret?: string }> {
  const selectedApplicationId = trimmed(values.selected_agent_app_id)
  if (selectedApplicationId) {
    return {
      application: await ctx.client.applications.get(zoneId, selectedApplicationId),
      created: false,
      clientSecret: trimmed(values.existing_app_client_secret),
    }
  }
  const clientSecret = generateClientSecret()
  const application = await ctx.client.applications.create(zoneId, {
    name: requiredText(values.agent_app_name, 'agent app is required'),
    registration_method: 'managed',
    credential_type: 'token',
    client_secret: clientSecret,
    consent: false,
  })
  return { application, created: true, clientSecret }
}

async function setupApplicationName(ctx: Ctx, zoneId: string | undefined, values: SetupValues): Promise<string> {
  const selectedApplicationId = trimmed(values.selected_agent_app_id)
  if (selectedApplicationId) {
    if (!zoneId) throw new Error('zone is required before selecting an existing agent app')
    return (await ctx.client.applications.get(zoneId, selectedApplicationId)).name
  }
  return requiredText(values.agent_app_name, 'agent app is required')
}

async function setupResourceIdentifier(ctx: Ctx, zoneId: string | undefined, values: SetupValues): Promise<string> {
  const selectedResourceId = trimmed(values.selected_resource_id)
  if (selectedResourceId) {
    if (!zoneId) throw new Error('zone is required before selecting an existing resource')
    return (await ctx.client.resources.get(zoneId, selectedResourceId)).identifier
  }
  return resourceIdentifierFor(values)
}

async function ensureProvider(
  ctx: Ctx,
  zoneId: string,
  values: SetupValues,
  upstreamUrl: string | undefined,
): Promise<string | undefined> {
  if (!upstreamUrl) return undefined
  if (values.provider_mode === 'none') return undefined
  const selectedProviderId = trimmed(values.selected_provider_id)
  if (selectedProviderId) return selectedProviderId
  if (!trimmed(values.provider_name)) return undefined
  const provider = await ctx.client.providers.create(zoneId, {
    identifier: providerIdentifierFor(values),
    name: trimmed(values.provider_name),
    kind: providerKind(values.provider_kind),
    client_id: trimmed(values.provider_client_id),
    config_json: providerConfigFromValues(values),
  })
  return provider.id
}

async function ensureResource(
  ctx: Ctx,
  zoneId: string,
  applicationId: string,
  values: SetupValues,
  scopes: string[],
  upstreamUrl: string | undefined,
  providerId: string | undefined,
): Promise<{ resource: Resource; created: boolean; updated: boolean }> {
  const selectedResourceId = trimmed(values.selected_resource_id)
  if (!selectedResourceId) {
    return {
      resource: await ctx.client.resources.create(zoneId, {
        identifier: resourceIdentifierFor(values),
        name: trimmed(values.resource_name),
        scopes,
        upstream_url: upstreamUrl,
        gateway_application_id: upstreamUrl ? applicationId : undefined,
        credential_provider_id: providerId,
        prefix: upstreamUrl ? true : undefined,
      }),
      created: true,
      updated: false,
    }
  }

  const current = await ctx.client.resources.get(zoneId, selectedResourceId)
  const patch: Partial<ResourceInput> = {}
  if (!sameList(current.scopes ?? [], scopes)) patch.scopes = scopes
  if (upstreamUrl && current.upstream_url !== upstreamUrl) patch.upstream_url = upstreamUrl
  if (upstreamUrl && current.gateway_application_id !== applicationId) patch.gateway_application_id = applicationId
  if (upstreamUrl && current.prefix !== true) patch.prefix = true
  if (providerId && current.credential_provider_id !== providerId) patch.credential_provider_id = providerId
  const updated = Object.keys(patch).length > 0
  return {
    resource: updated
      ? await ctx.client.resources.patch(zoneId, selectedResourceId, patch)
      : current,
    created: false,
    updated,
  }
}

function resourceIdentifierFor(values: SetupValues): string {
  return trimmed(values.resource_identifier) ?? `resource://${safeName(requiredText(values.resource_name, 'resource is required'))}`
}

function guidedInfo(title: string, meaning: string, example: string, valid: string, after: string) {
  return infoPage({
    title,
    meaning,
    when: 'Use this during guided setup when this value defines how Caracal creates or links the object.',
    example,
    valid,
    after,
  })
}

function zonePicker(ctx: Ctx): Field['pick'] {
  return (app, setValue) => {
    app.push(new EntityPickerView<Zone>({
      title: 'choose zone',
      load: () => ctx.client.zones.list(),
      value: (row) => row.id,
      label: zoneLabel,
      description: (row) => row.slug,
      onPick: setValue,
    }))
  }
}

function zoneResolver(ctx: Ctx): Field['resolve'] {
  return async (id) => zoneLabel(await ctx.client.zones.get(id))
}

function requireSetupZoneId(zoneId: () => string | undefined): string {
  return requiredText(zoneId(), 'zone is required before opening this picker')
}

function applicationPicker(ctx: Ctx, zoneId: () => string | undefined): Field['pick'] {
  return (app, setValue) => {
    app.push(new EntityPickerView<Application>({
      title: 'choose agent app',
      load: () => ctx.client.applications.list(requireSetupZoneId(zoneId)),
      value: (row) => row.id,
      label: (row) => row.name,
      description: (row) => row.credential_type,
      onPick: setValue,
    }))
  }
}

function applicationResolver(ctx: Ctx, zoneId: () => string | undefined): Field['resolve'] {
  return async (id) => (await ctx.client.applications.get(requireSetupZoneId(zoneId), id)).name
}

function providerPicker(ctx: Ctx, zoneId: () => string | undefined): Field['pick'] {
  return (app, setValue) => {
    app.push(new EntityPickerView<Provider>({
      title: 'choose provider',
      load: () => ctx.client.providers.list(requireSetupZoneId(zoneId)),
      value: (row) => row.id,
      label: providerLabel,
      description: (row) => [row.identifier, row.kind ?? undefined].filter(Boolean).join('  '),
      onPick: setValue,
    }))
  }
}

function providerResolver(ctx: Ctx, zoneId: () => string | undefined): Field['resolve'] {
  return async (id) => providerLabel(await ctx.client.providers.get(requireSetupZoneId(zoneId), id))
}

function resourcePicker(ctx: Ctx, zoneId: () => string | undefined): Field['pick'] {
  return (app, setValue) => {
    app.push(new EntityPickerView<Resource>({
      title: 'choose resource',
      load: async () => userResources(await ctx.client.resources.list(requireSetupZoneId(zoneId))),
      value: (row) => row.id,
      label: resourceLabel,
      description: (row) => [row.identifier, (row.scopes ?? []).join(',')].filter(Boolean).join('  '),
      onPick: setValue,
    }))
  }
}

function resourceResolver(ctx: Ctx, zoneId: () => string | undefined): Field['resolve'] {
  return async (id) => resourceLabel(await ctx.client.resources.get(requireSetupZoneId(zoneId), id))
}

function providerIdentifierFor(values: SetupValues): string {
  return trimmed(values.provider_identifier) ?? `provider://${safeName(requiredText(values.provider_name, 'provider is required'))}`
}

function providerKind(value: string | undefined): ProviderKind {
  return PROVIDER_KINDS.includes(value as ProviderKind) ? value as ProviderKind : 'oauth2'
}

function providerConfigFromValues(values: SetupValues): JsonObject {
  const kind = providerKind(values.provider_kind)
  const config: JsonObject = {}
  mergeConfigText(config, 'issuer', values.provider_issuer)
  mergeConfigText(config, 'authorization_endpoint', values.provider_authorization_endpoint)
  mergeConfigText(config, 'token_endpoint', values.provider_token_endpoint)
  mergeConfigList(config, 'allowed_token_hosts', values.provider_allowed_token_hosts || inferredTokenHosts(values.provider_token_endpoint))
  mergeConfigList(config, 'upstream_oauth_scopes', values.provider_upstream_oauth_scopes)
  mergeConfigText(config, 'header_name', values.provider_api_key_header)
  mergeConfigText(config, 'auth_scheme', values.provider_auth_scheme)
  mergeConfigText(config, 'audience', values.provider_workload_audience)
  if (values.provider_forward_caracal_identity === 'true') config.forward_caracal_identity = true
  validateProviderConfig(kind, config)
  return config
}

function mergeConfigText(config: JsonObject, key: string, value: string | undefined): void {
  const text = value?.trim()
  if (text) config[key] = text
}

function mergeConfigList(config: JsonObject, key: string, value: string | undefined): void {
  const items = splitList(value)
  if (items.length > 0) config[key] = items
}

function inferredTokenHosts(endpoint: string | undefined): string {
  const value = trimmed(endpoint)
  if (!value) return ''
  try {
    return new URL(value).host
  } catch {
    return ''
  }
}

function validateProviderConfig(kind: ProviderKind, config: JsonObject): void {
  if (kind === 'apikey') {
    requireString(config, 'header_name', 'apikey provider config requires header_name')
    return
  }
  if (kind === 'workload') {
    requireString(config, 'issuer', 'workload provider config requires issuer')
    requireString(config, 'audience', 'workload provider config requires audience')
  }
  if (kind === 'oidc') requireString(config, 'issuer', 'oidc provider config requires issuer')
  requireString(config, 'token_endpoint', `${kind} provider config requires token_endpoint`)
  requireStringList(config, 'allowed_token_hosts', `${kind} provider config requires allowed_token_hosts`)
}

function requireString(config: JsonObject, key: string, message: string): void {
  if (typeof config[key] !== 'string' || config[key].trim().length === 0) throw new Error(message)
}

function requireStringList(config: JsonObject, key: string, message: string): void {
  const value = config[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(message)
  }
}

function userResources(resources: Resource[]): Resource[] {
  const audience = process.env.CONTROL_AUDIENCE ?? DEFAULT_CONTROL_AUDIENCE
  return resources.filter((resource) => resource.identifier !== audience)
}

function zoneLabel(zone: Zone | { name?: string; slug?: string; id: string }): string {
  return zone.name || zone.slug || zone.id
}

function resourceLabel(resource: Resource): string {
  return resource.name || resource.identifier || resource.id
}

function providerLabel(provider: Provider): string {
  return provider.name || provider.identifier || provider.id
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

async function createFirstPolicy(
  ctx: Ctx,
  zoneId: string,
  applicationId: string,
  resourceIdentifier: string,
  scopes: string[],
): Promise<SetupResult['policy']> {
  const policy = await ctx.client.policies.create(zoneId, {
    name: 'Guided setup access policy',
    description: 'Starter Rego allow-list explicitly approved during guided setup. Allows only the configured agent app to request the configured protected resource with the configured Caracal scopes.',
    content: firstAccessPolicy(applicationId, resourceIdentifier, scopes),
  })
  const policySet = await ctx.client.policySets.create(zoneId, 'Guided setup access policy set', 'Active policy set approved during guided setup.')
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
  target: ProfileTarget,
  zoneId: string,
  applicationId: string,
  resourceIdentifier: string,
  upstreamUrl: string | undefined,
): SetupResult['profile'] {
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
    `app_client_secret_file = ${quoteToml(target.secretPath)}`,
    'continue_on_failure = false',
    '',
    '[[credentials]]',
    `env = ${quoteToml(target.credentialEnv)}`,
    `resource = ${quoteToml(resourceIdentifier)}`,
  ]
  if (upstreamUrl) lines.push(`upstream_prefix = ${quoteToml(upstreamUrl)}`)
  return { ...target, gatewayUrl, content: lines.join('\n') + '\n' }
}

function setupSummary(result: SetupResult): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    outcome: result.policy ? 'ready for first protected run' : 'objects created; activate a policy before requesting access',
    zone: {
      name: result.zone.name,
      status: result.zoneCreated ? 'created' : 'selected',
    },
    agent_app: {
      name: result.application.name,
      status: result.applicationCreated ? 'created' : 'selected',
      ...(result.clientSecret
        ? {
            client_secret: result.clientSecret,
            note: 'Store client_secret now. It cannot be retrieved later.',
          }
        : {
            note: 'Existing app selected. Use its existing client secret in the generated secret file.',
          }),
    },
    protected_resource: {
      name: result.resource.name || result.resource.identifier,
      status: result.resourceCreated ? 'created' : result.resourceUpdated ? 'selected and updated' : 'selected',
      scopes: result.resource.scopes,
      gateway_route: result.resource.gateway_application_id ? 'enabled' : 'not configured',
      ...(result.resource.upstream_url ? { upstream: result.resource.upstream_url } : {}),
    },
  }
  if (result.policy) {
    summary.access_policy = {
      status: 'created and activated',
      kind: 'starter least-privilege allow-list',
      summary: 'Denies by default and allows only the selected app to request the selected resource scopes.',
    }
  } else {
    summary.access_policy = {
      status: 'skipped',
      next_step: 'Create and activate a policy before requesting access.',
    }
  }
  if (result.profile) {
    const profile = result.profile
    const runtimeProfile: Record<string, unknown> = {
      profile_path: profile.path,
      secret_file: profile.secretPath,
      token_env: profile.credentialEnv,
      first_success: {
        run: `CARACAL_CONFIG=${profile.path} caracal run -- <your workload command>`,
        sdk: `Set CARACAL_CONFIG=${profile.path} before connecting from a Caracal SDK.`,
        gateway: result.resource.gateway_application_id
          ? `Use ${profile.credentialEnv} as the bearer token for Gateway requests.`
          : 'Gateway routing was not configured.',
      },
      next_steps: [
        result.fileWrite?.status === 'written'
          ? 'Use the written runtime profile and secret file for local runs.'
          : 'Enable write profile files in Advanced next time when you want Console to write local files.',
        'Run the real workload with CARACAL_CONFIG set to the profile path.',
      ],
    }
    if (result.fileWrite) {
      runtimeProfile.file_write = {
        status: result.fileWrite.status,
        ...(result.fileWrite.status === 'written'
          ? {
              profile_path: result.fileWrite.profile_path,
              secret_file: result.fileWrite.secret_file,
              note: 'Console wrote the profile and one-time client secret with owner-only file permissions.',
            }
          : {}),
        ...(result.fileWrite.status === 'failed' ? { error: result.fileWrite.error } : {}),
      }
    }
    summary.runtime_profile = runtimeProfile
  }
  summary.audit_explanation = {
    first_success: 'After the first protected call, open Audit, select the request, and use Explain to view the policy decision and Gateway result.',
    if_no_event: 'Re-check the active policy, resource identifier, Gateway route, and runtime profile before retrying.',
  }
  return summary
}

function profileTarget(values: SetupValues, agentAppName: string, resourceIdentifier: string): ProfileTarget {
  const path = trimmed(values.profile_path) ?? defaultRuntimeConfigPath()
  const secretPath = trimmed(values.secret_file_path) ?? join(dirname(path), `${safeName(agentAppName)}-client-secret`)
  if (path === secretPath) throw new Error('profile path and secret file must be different files')
  return {
    path,
    secretPath,
    credentialEnv: trimmed(values.credential_env) ?? credentialEnvName(resourceIdentifier),
  }
}

async function assertWritableTarget(target: ProfileTarget, overwrite: boolean): Promise<void> {
  if (overwrite) return
  const existing = await Promise.all([
    existingPath(target.path),
    existingPath(target.secretPath),
  ])
  const conflicts = existing.filter((path): path is string => Boolean(path))
  if (conflicts.length > 0) {
    throw new Error(`refusing to overwrite existing setup file: ${conflicts.join(', ')}`)
  }
}

async function existingPath(path: string): Promise<string | undefined> {
  try {
    await access(path)
    return path
  } catch (err) {
    if (isMissingPath(err)) return undefined
    throw err
  }
}

async function setupFileWrite(
  profile: NonNullable<SetupResult['profile']>,
  clientSecret: string | undefined,
  writeFiles: boolean,
  overwrite: boolean,
): Promise<SetupResult['fileWrite']> {
  if (!writeFiles) return { status: 'skipped' }
  if (!clientSecret) throw new Error('client secret is required to write setup files')
  try {
    await writeSetupFile(profile.path, profile.content, overwrite)
    await writeSetupFile(profile.secretPath, `${clientSecret}\n`, overwrite)
    return {
      status: 'written',
      profile_path: profile.path,
      secret_file: profile.secretPath,
      overwrite,
    }
  } catch (err) {
    return {
      status: 'failed',
      profile_path: profile.path,
      secret_file: profile.secretPath,
      overwrite,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function writeSetupFile(path: string, content: string, overwrite: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o600, flag: overwrite ? 'w' : 'wx' })
  await chmod(path, 0o600)
}

function isMissingPath(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

function normalizeRequestPath(value: string | undefined): string | undefined {
  const path = trimmed(value)
  if (!path) return undefined
  return path.startsWith('/') ? path : `/${path}`
}

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function bool(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'true'
}

function boolDefault(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue
  return value === 'true'
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
