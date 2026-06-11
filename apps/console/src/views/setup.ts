// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Guided first setup workflow for production-shaped Caracal onboarding.

import { isProviderIdentifier } from '@caracalai/admin'
import type {
  APIKeyProviderConfig,
  Application,
  BearerTokenProviderConfig,
  EmptyProviderConfig,
  OAuth2AuthorizationCodeProviderConfig,
  OAuth2ClientCredentialsProviderConfig,
  PolicyPreview,
  PolicyVersion,
  Provider,
  ProviderConfig,
  ProviderIdentifier,
  ProviderInput,
  ProviderKind,
  Resource,
  ResourceInput,
  Zone,
} from '@caracalai/admin'
import type { JsonObject } from '@caracalai/core'
import { DEFAULT_CONTROL_AUDIENCE } from '@caracalai/engine'
import {
  DEFAULT_COORDINATOR_URL,
  DEFAULT_GATEWAY_URL,
  defaultAppClientSecretFilePath,
  defaultRuntimeConfigPath,
} from '@caracalai/engine/runtime-config'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { truncate, ui } from '../ansi.ts'
import type { Key } from '../keys.ts'
import { maskSecretField, scrubTokens } from '../errors.ts'
import type { App, View, ViewContext } from '../screen.ts'
import { DraftPipeline, type DraftResolver } from '../draft.ts'
import { DetailView } from './detail.ts'
import { FormView, type Field } from './form.ts'
import { infoPage, openInfo, presetInfo, providerTypeInfo } from './info.ts'
import { EntityPickerView } from './picker.ts'
import type { Ctx } from './factory.ts'

const PROVIDER_KINDS: ProviderKind[] = [
  'none',
  'caracal_mandate',
  'oauth2_authorization_code',
  'oauth2_client_credentials',
  'api_key',
  'bearer_token',
]
const PROVIDER_CREDENTIAL_KINDS: ProviderKind[] = ['oauth2_authorization_code', 'oauth2_client_credentials', 'api_key', 'bearer_token']
const API_KEY_AUTH_LOCATIONS = ['header', 'query']
const OAUTH_CLIENT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none']
const OAUTH_AUTH_CODE_CLIENT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none']
const OAUTH_CLIENT_CREDENTIALS_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none']
const PROVIDER_IDENTIFIER_PATTERN = /^provider:\/\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const AUTH_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/
const OAUTH_PARAM_PATTERN = /^[A-Za-z0-9._~-]+$/
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const RESERVED_OAUTH_AUTHORIZATION_PARAMS = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
])
const RESERVED_OAUTH_TOKEN_PARAMS = new Set([
  'client_assertion',
  'client_assertion_type',
  'client_id',
  'client_secret',
  'code',
  'code_verifier',
  'grant_type',
  'redirect_uri',
  'refresh_token',
  'scope',
])
const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  none: 'None',
  caracal_mandate: 'Caracal mandate',
  oauth2_authorization_code: 'OAuth 2.0 authorization code',
  oauth2_client_credentials: 'OAuth 2.0 client credentials',
  api_key: 'API key',
  bearer_token: 'Bearer token',
}

function providerKindLabel(value: string | undefined): string {
  return PROVIDER_KIND_LABELS[providerKind(value)] ?? providerKind(value)
}

type SetupPresetKey = 'internal_http' | 'mandate_service' | 'api_key' | 'oauth_client' | 'oauth_user' | 'custom'

interface SetupPreset {
  key: SetupPresetKey
  label: string
  summary: string
  providerKind: ProviderKind | 'choose'
  hidesProvider: boolean
}

const SETUP_PRESETS: readonly SetupPreset[] = [
  {
    key: 'internal_http',
    label: 'Internal HTTP API (no upstream secret)',
    summary:
      'Gateway enforces Caracal access and forwards no upstream credential. Best first run for a protected internal service like Not Hotdog.',
    providerKind: 'none',
    hidesProvider: true,
  },
  {
    key: 'mandate_service',
    label: 'Caracal-aware service (mandate)',
    summary:
      'Gateway forwards a Caracal mandate the upstream verifies directly. Use for a PiperNet service or SDK that accepts Caracal mandates.',
    providerKind: 'caracal_mandate',
    hidesProvider: true,
  },
  {
    key: 'api_key',
    label: 'Upstream API key',
    summary: 'Broker a static upstream API key that the Gateway injects into a header or query parameter.',
    providerKind: 'api_key',
    hidesProvider: false,
  },
  {
    key: 'oauth_client',
    label: 'Upstream OAuth (client credentials)',
    summary: 'Server-to-server OAuth where the provider issues tokens to the application itself.',
    providerKind: 'oauth2_client_credentials',
    hidesProvider: false,
  },
  {
    key: 'oauth_user',
    label: 'Upstream OAuth (user consent)',
    summary: 'User-approved OAuth with a consent screen, callback URI, and refreshable delegated access.',
    providerKind: 'oauth2_authorization_code',
    hidesProvider: false,
  },
  {
    key: 'custom',
    label: 'Custom provider',
    summary: 'Choose any provider type and configure every upstream authentication field yourself.',
    providerKind: 'choose',
    hidesProvider: false,
  },
]

const SETUP_PRESET_KEYS: SetupPresetKey[] = SETUP_PRESETS.map((preset) => preset.key)
const SETUP_PRESET_LABELS: Record<string, string> = Object.fromEntries(SETUP_PRESETS.map((preset) => [preset.key, preset.label]))

function setupPreset(value: string | undefined): SetupPreset {
  return SETUP_PRESETS.find((preset) => preset.key === value) ?? SETUP_PRESETS[0]
}

interface SetupValues {
  preset?: string
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
  provider_authorization_endpoint?: string
  provider_token_endpoint?: string
  provider_redirect_uri?: string
  provider_client_id?: string
  provider_client_secret?: string
  provider_private_key?: string
  provider_api_key?: string
  provider_api_key_auth_location?: string
  provider_bearer_token?: string
  provider_auth_code_client_auth_method?: string
  provider_client_credentials_auth_method?: string
  provider_key_id?: string
  provider_scopes?: string
  provider_authorization_params?: string
  provider_token_params?: string
  provider_token_audience?: string
  provider_token_resource?: string
  provider_api_key_header?: string
  provider_api_key_query_param?: string
  provider_oauth_token_hosts?: string
  provider_allowed_upstream_hosts?: string
  provider_auth_header?: string
  provider_auth_scheme?: string
  provider_forward_caracal_identity?: string
  provider_allow_runtime_injection?: string
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
    preview: PolicyPreview | null
    warnings: string[]
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

type SetupStepKey = 'preset' | 'zone' | 'application' | 'provider' | 'resource' | 'policy' | 'review'

interface SetupStep {
  key: SetupStepKey
  title: string
  explanation: string
}

class FirstSetupWizardView implements View {
  readonly title = 'guided setup'
  readonly isTextEntry = false
  private readonly ctx: Ctx
  private step: SetupStepKey = 'preset'
  private values: SetupValues = {
    preset: 'internal_http',
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
    provider_kind: 'caracal_mandate',
    provider_api_key_auth_location: 'header',
    provider_forward_caracal_identity: 'false',
    provider_allow_runtime_injection: 'false',
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
      preset: {
        key: 'preset',
        title: 'Scenario',
        explanation:
          'Pick what you are protecting and how the upstream is authenticated. The wizard then shows only the fields that scenario needs.',
      },
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
        explanation: 'Choose how the Gateway authenticates to the upstream for the resource you just defined.',
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
    const steps: SetupStepKey[] = ['preset']
    if (!this.selectedZone) steps.push('zone')
    steps.push('application', 'resource')
    if (this.providerStepVisible()) steps.push('provider')
    steps.push('policy')
    steps.push('review')
    return steps
  }

  private providerStepVisible(): boolean {
    return !setupPreset(this.values.preset).hidesProvider
  }

  private stepAfter(step: SetupStepKey): SetupStepKey {
    const steps = this.steps()
    const index = steps.indexOf(step)
    return steps[index + 1] ?? 'review'
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
    if (step === 'preset') return setupPreset(this.values.preset).label
    if (step === 'zone')
      return this.selectedZone
        ? `${zoneLabel(this.selectedZone)} selected`
        : trimmed(this.values.zone_name)
          ? `${this.values.zone_name} will be created`
          : ui.muted('open page')
    if (step === 'application')
      return this.selectedApplication
        ? `${this.selectedApplication.name} selected`
        : trimmed(this.values.agent_app_name)
          ? `${this.values.agent_app_name} will be created`
          : ui.muted('open page')
    if (step === 'provider') return this.providerReviewLabel()
    if (step === 'resource')
      return this.selectedResource
        ? `${resourceLabel(this.selectedResource)} selected`
        : trimmed(this.values.resource_name)
          ? `${this.values.resource_name} will be created`
          : ui.muted('open page')
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
    this.values.provider_kind = 'caracal_mandate'
    this.clearProviderTypeValues()
  }

  private clearProviderTypeValues(): void {
    this.values.provider_token_endpoint = ''
    this.values.provider_authorization_endpoint = ''
    this.values.provider_redirect_uri = ''
    this.values.provider_client_id = ''
    this.values.provider_client_secret = ''
    this.values.provider_private_key = ''
    this.values.provider_api_key = ''
    this.values.provider_api_key_auth_location = 'header'
    this.values.provider_bearer_token = ''
    this.values.provider_auth_code_client_auth_method = 'client_secret_basic'
    this.values.provider_client_credentials_auth_method = 'client_secret_basic'
    this.values.provider_key_id = ''
    this.values.provider_scopes = ''
    this.values.provider_authorization_params = ''
    this.values.provider_token_params = ''
    this.values.provider_api_key_header = ''
    this.values.provider_api_key_query_param = ''
    this.values.provider_oauth_token_hosts = ''
    this.values.provider_allowed_upstream_hosts = ''
    this.values.provider_auth_header = ''
    this.values.provider_auth_scheme = ''
    this.values.provider_forward_caracal_identity = 'false'
  }

  private currentZoneId(): string | undefined {
    return this.selectedZone?.id ?? trimmed(this.values.selected_zone_id) ?? this.ctx.zoneId
  }

  private openStepPage(app: App): void {
    if (this.step === 'preset') this.openPresetPage(app)
    else if (this.step === 'zone') this.openZonePage(app)
    else if (this.step === 'application') this.openApplicationPage(app)
    else if (this.step === 'provider') this.openProviderPage(app)
    else if (this.step === 'resource') this.openResourcePage(app)
    else if (this.step === 'policy') this.openPolicyPage(app)
  }

  private openPresetPage(app: App): void {
    app.push(
      new FormView({
        title: 'guided setup / scenario',
        submitLabel: 'save scenario',
        info: presetInfo(),
        fields: [
          {
            key: 'preset',
            label: 'scenario',
            kind: 'select',
            options: SETUP_PRESET_KEYS,
            optionLabels: SETUP_PRESET_LABELS,
            default: this.values.preset ?? 'internal_http',
            info: presetInfo(),
          },
        ],
        onSubmit: async (raw, formApp) => {
          this.applyPreset(raw.preset)
          formApp.pop()
          this.step = this.stepAfter('preset')
        },
      }),
    )
  }

  private applyPreset(value: string | undefined): void {
    const preset = setupPreset(value)
    this.values.preset = preset.key
    if (preset.providerKind !== 'choose') {
      this.clearProviderSelection()
      this.values.provider_mode = 'create'
      this.values.provider_kind = preset.providerKind
    }
  }

  private applyHiddenProvider(): void {
    const preset = setupPreset(this.values.preset)
    if (!preset.hidesProvider) return
    if (this.selectedProvider || trimmed(this.values.selected_provider_id)) return
    this.values.provider_mode = 'create'
    this.values.provider_kind = preset.providerKind
    if (!trimmed(this.values.provider_name)) {
      const resourceName = this.selectedResource?.name || trimmed(this.values.resource_name) || 'gateway'
      this.values.provider_name = `${resourceName} upstream`
    }
  }

  private openZonePage(app: App): void {
    app.push(
      new FormView({
        title: 'guided setup / zone',
        submitLabel: 'save zone',
        info: guidedInfo(
          'Zone setup',
          'A zone is the workspace boundary for apps, providers, resources, and policies.',
          'Pied Piper Production',
          'Create a named zone or pick an existing zone.',
          'The selected zone is used by every later setup page.',
        ),
        fields: [
          {
            key: 'zone_mode',
            label: 'zone action',
            kind: 'select',
            options: ['create', 'select'],
            default: this.values.zone_mode ?? 'create',
            info: guidedInfo(
              'Zone action',
              'Choose whether setup should create a zone or reuse one.',
              'select when the production zone already exists',
              'create or select',
              'Setup either stores the typed zone name or resolves the picked zone ID.',
            ),
          },
          {
            key: 'zone_name',
            label: 'zone name',
            kind: 'text',
            required: true,
            default: this.values.zone_name ?? '',
            dependsOn: { zone_mode: 'create' },
            info: guidedInfo(
              'Zone name',
              'Human-readable boundary name for this workload or team.',
              'Pied Piper Production',
              'Short text, not an internal ID.',
              'Console creates the zone before creating apps, providers, and resources.',
            ),
          },
          {
            key: 'selected_zone_id',
            label: 'existing zone',
            kind: 'text',
            required: true,
            default: this.values.selected_zone_id ?? '',
            dependsOn: { zone_mode: 'select' },
            pick: zonePicker(this.ctx),
            resolve: zoneResolver(this.ctx),
            info: guidedInfo(
              'Existing zone',
              'Pick the zone that should own this setup.',
              'Pied Piper Production',
              'Use the picker instead of typing an ID.',
              'Console resolves the zone and skips zone creation.',
            ),
          },
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
      }),
    )
  }

  private openApplicationPage(app: App): void {
    const zoneId = this.currentZoneId()
    if (!zoneId && !trimmed(this.values.zone_name)) {
      app.setStatus('complete the zone page before the agent app page', 'error')
      return
    }
    app.push(
      new FormView({
        title: 'guided setup / agent app',
        submitLabel: 'save app',
        info: guidedInfo(
          'Agent app setup',
          'The app is the workload identity that receives Caracal tokens.',
          'Son of Anton',
          'Create a managed token app or pick an existing app.',
          'Setup creates or selects this app before policies and runtime profile output are generated.',
        ),
        fields: [
          {
            key: 'application_mode',
            label: 'app action',
            kind: 'select',
            options: ['create', 'select'],
            default: this.values.application_mode ?? 'create',
            info: guidedInfo(
              'App action',
              'Choose whether setup should create the workload app or reuse one.',
              'create for Son of Anton',
              'create or select',
              'Console uses the app as the requesting principal in the generated policy.',
            ),
          },
          {
            key: 'agent_app_name',
            label: 'app name',
            kind: 'text',
            required: true,
            default: this.values.agent_app_name ?? '',
            dependsOn: { application_mode: 'create' },
            info: guidedInfo(
              'App name',
              'Name of the workload that will request resource access.',
              'Son of Anton',
              'Short text, not an internal ID.',
              'Console creates a managed token app and reveals its one-time client secret in the result.',
            ),
          },
          {
            key: 'selected_agent_app_id',
            label: 'existing app',
            kind: 'text',
            required: true,
            default: this.values.selected_agent_app_id ?? '',
            dependsOn: { application_mode: 'select' },
            pick: applicationPicker(this.ctx, () => this.currentZoneId()),
            resolve: applicationResolver(this.ctx, () => this.currentZoneId()),
            info: guidedInfo(
              'Existing app',
              'Pick an app that already represents this workload.',
              'Son of Anton',
              'Use the picker instead of typing an ID.',
              'Console uses the selected app in the generated policy and profile.',
            ),
          },
          {
            key: 'existing_app_client_secret',
            label: 'existing app secret',
            kind: 'text',
            default: this.values.existing_app_client_secret ?? '',
            dependsOn: { application_mode: 'select' },
            advanced: true,
            info: guidedInfo(
              'Existing app secret',
              'Client secrets cannot be retrieved later, so file writing needs the existing secret.',
              'cs_live_...',
              'Secret text from your secure store.',
              'If profile file writing is enabled, Console writes this secret to the generated secret file.',
            ),
          },
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
          this.step = this.stepAfter('application')
        },
      }),
    )
  }

  private openProviderPage(app: App): void {
    const zoneId = this.currentZoneId()
    if (!zoneId && !trimmed(this.values.zone_name)) {
      app.setStatus('complete the zone page before the provider page', 'error')
      return
    }
    const preset = setupPreset(this.values.preset)
    const lockKind = preset.providerKind !== 'choose'
    const seededKind = lockKind ? preset.providerKind : (this.values.provider_kind ?? 'caracal_mandate')
    app.push(
      new FormView({
        title: 'guided setup / provider',
        submitLabel: 'save provider',
        initialValues: { provider_kind: seededKind },
        info: guidedInfo(
          'Provider setup',
          'A provider describes how Gateway authenticates to the upstream service for the resource you defined.',
          'None for Gateway-only enforcement, Caracal mandate for PiperNet, or Hooli OAuth for external APIs',
          'Create or select a provider for the resource. The chosen scenario fixes the provider type unless you picked the custom scenario.',
          'Setup creates or links the provider and attaches it to the resource.',
        ),
        fields: [
          {
            key: 'provider_mode',
            label: 'provider action',
            kind: 'select',
            options: ['create', 'select'],
            default: this.values.provider_mode === 'none' ? 'create' : (this.values.provider_mode ?? 'create'),
            info: guidedInfo(
              'Provider action',
              'Choose whether this route should create a provider record or reuse one.',
              'create for None, Caracal mandate, or Hooli OAuth',
              'create or select',
              'Console creates or links a provider so the resource always records its upstream auth mode.',
            ),
          },
          {
            key: 'selected_provider_id',
            label: 'existing provider',
            kind: 'text',
            required: true,
            default: this.values.selected_provider_id ?? '',
            dependsOn: { provider_mode: 'select' },
            pick: providerPicker(this.ctx, () => this.currentZoneId()),
            resolve: providerResolver(this.ctx, () => this.currentZoneId()),
            info: guidedInfo(
              'Existing provider',
              'Pick the provider that supplies upstream credentials.',
              'Hooli OAuth',
              'Use the picker instead of typing an ID.',
              'The resource page can attach this provider to the Gateway route.',
            ),
          },
          {
            key: 'provider_name',
            label: 'provider name',
            kind: 'text',
            required: true,
            default: this.values.provider_name ?? '',
            dependsOn: { provider_mode: 'create' },
            info: guidedInfo(
              'Provider name',
              'Human-readable name for the upstream credential source.',
              'Hooli PiperNet OAuth',
              'Short text, not an internal ID.',
              'Console creates this provider before creating the resource.',
            ),
          },
          ...(lockKind
            ? []
            : [
                {
                  key: 'provider_kind',
                  label: 'provider type',
                  kind: 'select' as const,
                  options: PROVIDER_KINDS,
                  optionLabels: PROVIDER_KIND_LABELS,
                  default: seededKind,
                  dependsOn: { provider_mode: 'create' },
                  info: providerTypeInfo(),
                },
              ]),
          {
            key: 'provider_authorization_endpoint',
            label: 'authorization endpoint',
            kind: 'text',
            required: true,
            default: this.values.provider_authorization_endpoint ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'oauth2_authorization_code' },
            info: guidedInfo(
              'Authorization endpoint',
              'Endpoint where users approve delegated provider access.',
              'https://login.hooli.example/oauth/authorize',
              'Absolute HTTPS URL.',
              'Authorization-code providers use this with a callback URI.',
            ),
          },
          {
            key: 'provider_token_endpoint',
            label: 'token endpoint',
            kind: 'text',
            required: true,
            default: this.values.provider_token_endpoint ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials'] },
            info: guidedInfo(
              'Token endpoint',
              'Endpoint where Gateway obtains or refreshes upstream OAuth tokens.',
              'https://login.hooli.example/oauth/token',
              'Absolute HTTPS URL.',
              'Console infers OAuth token endpoint hosts from this URL unless Advanced overrides them.',
            ),
          },
          {
            key: 'provider_redirect_uri',
            label: 'redirect URI',
            kind: 'text',
            required: true,
            default: this.values.provider_redirect_uri ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'oauth2_authorization_code' },
            info: guidedInfo(
              'Redirect URI',
              'Callback URI registered with the provider.',
              'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback',
              'Absolute callback URI.',
              'The provider sends authorization results to this URI.',
            ),
          },
          {
            key: 'provider_client_id',
            label: 'client ID',
            kind: 'text',
            required: true,
            default: this.values.provider_client_id ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials'] },
            info: guidedInfo(
              'Client ID',
              'OAuth client identifier issued by the provider.',
              'hooli-pipernet-client',
              'Provider-issued client ID.',
              'STS uses this when exchanging or refreshing provider tokens.',
            ),
          },
          {
            key: 'provider_client_secret',
            label: 'client secret',
            kind: 'secret',
            required: (current) => !['none', 'private_key_jwt'].includes(submittedOAuthClientAuthMethod(current)),
            default: this.values.provider_client_secret ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials'] },
            info: guidedInfo(
              'Client secret',
              'OAuth client secret issued by the provider.',
              'Paste the provider secret',
              'Secret text, or blank only when OAuth client authentication is none or private_key_jwt.',
              'STS requires this secret for client_secret_basic and client_secret_post token endpoint authentication.',
            ),
          },
          {
            key: 'provider_scopes',
            label: 'upstream OAuth scopes',
            kind: 'list',
            default: this.values.provider_scopes ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials'] },
            info: guidedInfo(
              'Upstream OAuth scopes',
              'Optional OAuth scopes requested from the upstream provider.',
              'pipernet.read,pipernet.write',
              'Comma-separated upstream OAuth scope names.',
              'Authorization-code providers use these scopes for consent; client-credentials providers send them to the token endpoint.',
            ),
          },
          {
            key: 'provider_api_key_auth_location',
            label: 'API key location',
            kind: 'select',
            options: API_KEY_AUTH_LOCATIONS,
            default: this.values.provider_api_key_auth_location ?? 'header',
            dependsOn: { provider_mode: 'create', provider_kind: 'api_key' },
            info: guidedInfo(
              'API key location',
              'Where the upstream API expects the API key credential.',
              'header for Hooli APIs, query for PiperNet endpoints',
              'header or query.',
              'Gateway sends the sealed API key in that request location.',
            ),
          },
          {
            key: 'provider_api_key_header',
            label: 'API key header name',
            kind: 'text',
            required: true,
            default: this.values.provider_api_key_header ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'api_key', provider_api_key_auth_location: 'header' },
            info: guidedInfo(
              'API key header name',
              'Header where the upstream API expects its key, such as X-API-Key, Authorization, or a vendor-specific key header.',
              'X-API-Key',
              'HTTP header name.',
              'Gateway replaces any caller-supplied value for this header before forwarding upstream.',
            ),
          },
          {
            key: 'provider_api_key_query_param',
            label: 'API key query parameter',
            kind: 'text',
            required: true,
            default: this.values.provider_api_key_query_param ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'api_key', provider_api_key_auth_location: 'query' },
            info: guidedInfo(
              'API key query parameter',
              'Query parameter where the upstream API expects its key.',
              'key',
              'Parameter name such as key, appid, api_key, or token.',
              'Gateway replaces caller-supplied values for this parameter before forwarding upstream.',
            ),
          },
          {
            key: 'provider_api_key',
            label: 'API key',
            kind: 'secret',
            required: true,
            default: this.values.provider_api_key ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'api_key' },
            info: guidedInfo(
              'API key',
              'Provider-native API key for the upstream service.',
              'Paste the Hooli API key',
              'Secret text.',
              'Console seals this value before storing it.',
            ),
          },
          {
            key: 'provider_bearer_token',
            label: 'bearer token',
            kind: 'secret',
            required: true,
            default: this.values.provider_bearer_token ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'bearer_token' },
            info: guidedInfo(
              'Bearer token',
              'Pre-issued provider-native token for the upstream service.',
              'Paste the Hooli bearer token',
              'Secret text.',
              'Console seals this value and Gateway sends it as Authorization: Bearer unless Advanced routing changes the header or scheme.',
            ),
          },
          {
            key: 'provider_identifier',
            label: 'provider identifier',
            kind: 'text',
            default: this.values.provider_identifier ?? '',
            dependsOn: { provider_mode: 'create' },
            advanced: true,
            validate: validateProviderIdentifier,
            info: guidedInfo(
              'Provider identifier',
              'Stable provider identifier used by APIs and audit output.',
              'provider://hooli-pipernet',
              'Leave blank to let the API generate a collision-safe identifier from provider name.',
              'Console sends this identifier only when Advanced provides one.',
            ),
          },
          {
            key: 'provider_authorization_params',
            label: 'OAuth authorization parameters',
            kind: 'list',
            default: this.values.provider_authorization_params ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'oauth2_authorization_code' },
            advanced: true,
            info: guidedInfo(
              'OAuth authorization parameters',
              'Optional provider-specific parameters sent on the browser authorization request.',
              'access_type=offline,prompt=consent',
              'Comma-separated key=value pairs; reserved OAuth parameters are managed by Caracal.',
              'Use this when the provider requires extra consent parameters for refresh tokens.',
            ),
          },
          {
            key: 'provider_token_params',
            label: 'OAuth token parameters',
            kind: 'list',
            default: this.values.provider_token_params ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials'] },
            advanced: true,
            info: guidedInfo(
              'OAuth token parameters',
              'Optional provider-specific parameters sent to the token endpoint.',
              'tenant=hooli',
              'Comma-separated key=value pairs; token credentials are managed by Caracal.',
              'Use this only when the provider documents extra token endpoint parameters.',
            ),
          },
          {
            key: 'provider_token_audience',
            label: 'OAuth token audience',
            kind: 'text',
            default: this.values.provider_token_audience ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'oauth2_client_credentials' },
            advanced: true,
            info: guidedInfo(
              'OAuth token audience',
              'Optional OAuth audience parameter sent during client-credentials token acquisition.',
              'https://api.hooli.example',
              'Provider-documented audience value.',
              'Use this only when the provider token endpoint requires an audience parameter.',
            ),
          },
          {
            key: 'provider_token_resource',
            label: 'OAuth resource indicator',
            kind: 'text',
            default: this.values.provider_token_resource ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'oauth2_client_credentials' },
            advanced: true,
            info: guidedInfo(
              'OAuth resource indicator',
              'Optional OAuth resource parameter sent during client-credentials token acquisition.',
              'https://api.hooli.example/pipernet',
              'Provider-documented resource value.',
              'Use this only when the provider token endpoint requires a resource parameter.',
            ),
          },
          {
            key: 'provider_oauth_token_hosts',
            label: 'OAuth token endpoint hosts',
            kind: 'list',
            default: this.values.provider_oauth_token_hosts ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials'] },
            advanced: true,
            info: guidedInfo(
              'OAuth token endpoint hosts',
              'Host allow-list for OAuth token exchange and refresh endpoints.',
              'login.hooli.example',
              'Comma-separated host names.',
              'Blank uses the host inferred from the token endpoint.',
            ),
          },
          {
            key: 'provider_allowed_upstream_hosts',
            label: 'allowed upstream hosts',
            kind: 'list',
            default: this.values.provider_allowed_upstream_hosts ?? '',
            dependsOn: { provider_mode: 'create', provider_kind: 'bearer_token' },
            advanced: true,
            info: guidedInfo(
              'Allowed upstream hosts',
              'Host allow-list for static bearer-token forwarding.',
              'api.pipernet.example',
              'Comma-separated host names.',
              'Blank uses the host inferred from the guided setup upstream URL.',
            ),
          },
          {
            key: 'provider_auth_code_client_auth_method',
            label: 'OAuth client authentication',
            kind: 'select',
            options: OAUTH_AUTH_CODE_CLIENT_AUTH_METHODS,
            default: this.values.provider_auth_code_client_auth_method ?? 'client_secret_basic',
            dependsOn: { provider_mode: 'create', provider_kind: 'oauth2_authorization_code' },
            advanced: true,
            info: guidedInfo(
              'OAuth client authentication',
              'How STS authenticates an authorization-code OAuth client to the token endpoint.',
              'client_secret_basic',
              'OAuth client authentication method.',
              'Use the method registered with the provider. Authorization-code providers do not support private_key_jwt in Caracal.',
            ),
          },
          {
            key: 'provider_client_credentials_auth_method',
            label: 'OAuth client authentication',
            kind: 'select',
            options: OAUTH_CLIENT_CREDENTIALS_AUTH_METHODS,
            default: this.values.provider_client_credentials_auth_method ?? 'client_secret_basic',
            dependsOn: { provider_mode: 'create', provider_kind: 'oauth2_client_credentials' },
            advanced: true,
            info: guidedInfo(
              'OAuth client authentication',
              'How STS authenticates a client-credentials OAuth client to the token endpoint.',
              'client_secret_basic',
              'OAuth client authentication method.',
              'Use the method registered with the provider.',
            ),
          },
          {
            key: 'provider_key_id',
            label: 'key ID',
            kind: 'text',
            default: this.values.provider_key_id ?? '',
            dependsOn: {
              provider_mode: 'create',
              provider_kind: 'oauth2_client_credentials',
              provider_client_credentials_auth_method: 'private_key_jwt',
            },
            advanced: true,
            info: guidedInfo(
              'Key ID',
              'Optional key identifier sent as the JWT kid header.',
              'provider-key-2026-01',
              'Provider-registered key identifier.',
              'STS includes this only for private_key_jwt token endpoint authentication.',
            ),
          },
          {
            key: 'provider_private_key',
            label: 'private key',
            kind: 'secret-multiline',
            default: this.values.provider_private_key ?? '',
            dependsOn: {
              provider_mode: 'create',
              provider_kind: 'oauth2_client_credentials',
              provider_client_credentials_auth_method: 'private_key_jwt',
            },
            advanced: true,
            info: guidedInfo(
              'Private key',
              'PEM private key used to sign OAuth client assertions.',
              '-----BEGIN PRIVATE KEY-----',
              'PEM PKCS#8, RSA, or EC private key.',
              'STS seals this key and uses it only for private_key_jwt token endpoint authentication.',
            ),
          },
          {
            key: 'provider_auth_header',
            label: 'upstream authorization header',
            kind: 'text',
            default: this.values.provider_auth_header ?? '',
            dependsOn: {
              provider_mode: 'create',
              provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials', 'bearer_token'],
            },
            advanced: true,
            info: guidedInfo(
              'Upstream authorization header',
              'Header where Gateway forwards provider tokens.',
              'Authorization',
              'HTTP header name, or blank for the default.',
              'Gateway uses this header when calling the upstream API.',
            ),
          },
          {
            key: 'provider_auth_scheme',
            label: 'upstream authorization scheme',
            kind: 'text',
            default: this.values.provider_auth_scheme ?? '',
            dependsOn: {
              provider_mode: 'create',
              provider_kind: ['oauth2_authorization_code', 'oauth2_client_credentials', 'api_key', 'bearer_token'],
            },
            visible: (current) => current.provider_kind !== 'api_key' || current.provider_api_key_auth_location === 'header',
            advanced: true,
            info: guidedInfo(
              'Upstream authorization scheme',
              'Optional prefix for upstream credential values.',
              'Bearer',
              'Short scheme name such as Bearer, Token, or ApiKey; API-key query auth does not use a scheme.',
              'Gateway formats provider credentials using this scheme when the upstream API expects one.',
            ),
          },
          {
            key: 'provider_forward_caracal_identity',
            label: 'forward Caracal identity',
            kind: 'bool',
            default: this.values.provider_forward_caracal_identity ?? 'false',
            dependsOn: { provider_mode: 'create', provider_kind: PROVIDER_CREDENTIAL_KINDS },
            advanced: true,
            info: guidedInfo(
              'Forward Caracal identity',
              'Forward selected Caracal identity context to the upstream provider.',
              'Enable for a Hooli broker that trusts Caracal identity.',
              'Boolean toggle.',
              'Gateway sends X-Caracal-Identity only for provider-native credential routes that opt in.',
            ),
          },
          {
            key: 'provider_allow_runtime_injection',
            label: 'allow runtime injection',
            kind: 'bool',
            default: this.values.provider_allow_runtime_injection ?? 'false',
            dependsOn: { provider_mode: 'create', provider_kind: PROVIDER_CREDENTIAL_KINDS },
            advanced: true,
            info: guidedInfo(
              'Allow runtime injection',
              'Allow caracal run to inject this provider credential directly into a child process environment.',
              'Enable for PiperNet AI runs that need a provider API key at process start.',
              'Boolean toggle.',
              'STS returns provider-native credentials to caracal run only when policy allows the resource and the provider opts in.',
            ),
          },
        ],
        onSubmit: async (raw, formApp) => {
          Object.assign(this.values, raw)
          if (lockKind) this.values.provider_kind = preset.providerKind
          if (raw.provider_mode === 'select') {
            const id = requiredText(raw.selected_provider_id, 'provider is required')
            this.selectedProvider = zoneId ? await this.ctx.client.providers.get(zoneId, id) : undefined
            this.values.provider_name = ''
          } else {
            this.selectedProvider = undefined
            this.values.selected_provider_id = ''
          }
          formApp.pop()
          this.step = this.stepAfter('provider')
        },
      }),
    )
  }

  private openResourcePage(app: App): void {
    const zoneId = this.currentZoneId()
    if (!zoneId && !trimmed(this.values.zone_name)) {
      app.setStatus('complete the zone page before the resource page', 'error')
      return
    }
    app.push(
      new FormView({
        title: 'guided setup / resource',
        submitLabel: 'save resource',
        info: guidedInfo(
          'Resource setup',
          'A resource is the protected target the app will request and policy will evaluate.',
          'PiperNet with read/write scopes',
          'Create or select a protected resource and define Caracal resource scopes.',
          'Setup creates or updates the resource, links the provider when selected, and uses it in the generated policy.',
        ),
        fields: [
          {
            key: 'resource_mode',
            label: 'resource action',
            kind: 'select',
            options: ['create', 'select'],
            default: this.values.resource_mode ?? 'create',
            info: guidedInfo(
              'Resource action',
              'Choose whether setup should create a protected resource or reuse one.',
              'create for PiperNet',
              'create or select',
              'Console uses this resource as the policy target and runtime credential resource.',
            ),
          },
          {
            key: 'selected_resource_id',
            label: 'existing resource',
            kind: 'text',
            required: true,
            default: this.values.selected_resource_id ?? '',
            dependsOn: { resource_mode: 'select' },
            pick: resourcePicker(this.ctx, () => this.currentZoneId()),
            resolve: resourceResolver(this.ctx, () => this.currentZoneId()),
            info: guidedInfo(
              'Existing resource',
              'Pick the protected target that already exists.',
              'PiperNet',
              'Use the picker instead of typing an ID.',
              'Console can update scopes, Gateway URL, and provider link when needed.',
            ),
          },
          {
            key: 'resource_name',
            label: 'resource name',
            kind: 'text',
            required: true,
            default: this.values.resource_name ?? '',
            dependsOn: { resource_mode: 'create' },
            info: guidedInfo(
              'Resource name',
              'Human-readable target name for the API, service, MCP server, or SDK capability.',
              'PiperNet',
              'Short text, not an internal ID.',
              'Console creates a resource identifier from this name unless Advanced overrides it.',
            ),
          },
          {
            key: 'resource_scopes',
            label: 'Caracal resource scopes',
            kind: 'list',
            required: (current) => current.resource_mode === 'create',
            default: this.values.resource_scopes ?? '',
            info: guidedInfo(
              'Caracal resource scopes',
              'Permissions that Caracal policy evaluates for this resource.',
              'pipernet.read,pipernet.write',
              'Comma-separated Caracal scope names.',
              'Console writes these scopes to the resource and generated allow-list policy.',
            ),
          },
          {
            key: 'upstream_url',
            label: 'upstream URL',
            kind: 'text',
            required: (current) => current.resource_mode === 'create',
            default: this.values.upstream_url ?? '',
            dependsOn: { resource_mode: 'create' },
            info: guidedInfo(
              'Upstream URL',
              'Gateway target for the protected internal or external service.',
              'https://api.pipernet.example',
              'Absolute HTTP or HTTPS URL.',
              'Console enables Gateway routing and Gateway forwards either a Caracal mandate or the selected provider credential.',
            ),
          },
          {
            key: 'resource_identifier',
            label: 'resource identifier',
            kind: 'text',
            default: this.values.resource_identifier ?? '',
            dependsOn: { resource_mode: 'create' },
            advanced: true,
            validate: validateResourceIdentifier,
            info: guidedInfo(
              'Resource identifier',
              'Stable identifier used in tokens, policy input, SDK config, and audit.',
              'resource://pipernet',
              'Leave blank to let the API generate a collision-safe identifier from resource name.',
              'Use an absolute resource audience URI and keep it distinct from upstream URLs and provider identifiers.',
            ),
          },
          {
            key: 'request_path',
            label: 'first request path',
            kind: 'text',
            default: this.values.request_path ?? '',
            dependsOn: 'upstream_url',
            advanced: true,
            info: guidedInfo(
              'First request path',
              'Optional path used only to show an exact first Gateway curl command.',
              '/v1/not-hotdog',
              'Path starting with /, or blank.',
              'The result page includes a ready-to-copy request example.',
            ),
          },
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
          this.applyHiddenProvider()
          formApp.pop()
          this.step = this.stepAfter('resource')
        },
      }),
    )
  }

  private openPolicyPage(app: App): void {
    app.push(
      new FormView({
        title: 'guided setup / access policy',
        submitLabel: 'save policy choice',
        info: guidedInfo(
          'Access policy setup',
          'The starter policy is a real deny-by-default allow-list for the selected app, resource, and Caracal resource scopes.',
          'Allow Son of Anton to request pipernet.read on PiperNet.',
          'Choose create for first success or skip when a security team will author policy separately.',
          'Console creates the policy only after this page is saved with create selected.',
        ),
        fields: [
          {
            key: 'policy_mode',
            label: 'policy action',
            kind: 'select',
            options: ['create', 'skip'],
            default: bool(this.values.activate_policy) ? 'create' : 'skip',
            info: guidedInfo(
              'Policy action',
              'Choose whether guided setup should create the first access rule.',
              'create for a least-privilege starter allow-list',
              'create or skip',
              'Create activates a real policy set; skip leaves access denied until a policy is added later.',
            ),
          },
        ],
        onSubmit: async (raw, formApp) => {
          this.values.policy_mode = raw.policy_mode
          this.values.activate_policy = raw.policy_mode === 'skip' ? 'false' : 'true'
          formApp.pop()
          this.step = 'review'
        },
      }),
    )
  }

  private openAdvanced(app: App): void {
    const values = this.values
    app.push(
      new FormView({
        title: 'guided setup advanced',
        submitLabel: 'save',
        info: guidedInfo(
          'Guided setup advanced',
          'Optional final setup controls stay separate from object-building pages.',
          'Disable profile generation for a HooliBox-only setup.',
          'Every field can keep its default unless you need a non-standard setup.',
          'Saving updates the final create behavior without changing the object pages.',
        ),
        fields: [
          {
            key: 'generate_profile',
            label: 'runtime profile',
            kind: 'bool',
            default: values.generate_profile ?? 'true',
            info: guidedInfo(
              'Runtime profile',
              'Generate a runnable local profile from the selected zone, app, and resource.',
              'Enabled for PiperNet local runs.',
              'Boolean toggle.',
              'The result page shows profile content and setup commands.',
            ),
          },
          {
            key: 'write_files',
            label: 'write profile files',
            kind: 'bool',
            default: values.write_files ?? 'false',
            dependsOn: { generate_profile: 'true' },
            info: guidedInfo(
              'Write profile files',
              'Write the generated profile and secret file locally.',
              'Enable on Richard Hendricks workstation.',
              'Boolean toggle.',
              'Console writes owner-only files instead of only showing copy commands.',
            ),
          },
          {
            key: 'existing_app_client_secret',
            label: 'existing app secret',
            kind: 'text',
            default: values.existing_app_client_secret ?? '',
            visible: () => Boolean(this.selectedApplication),
            required: (current) => current.write_files === 'true',
            dependsOn: { generate_profile: 'true', write_files: 'true' },
            info: guidedInfo(
              'Existing app secret',
              'Required only when writing files for a selected existing app.',
              'cs_live_...',
              'Existing client secret from your secure store.',
              'Console writes this value to the generated secret file.',
            ),
          },
          {
            key: 'overwrite_files',
            label: 'overwrite files',
            kind: 'bool',
            default: values.overwrite_files ?? 'false',
            dependsOn: { generate_profile: 'true', write_files: 'true' },
            info: guidedInfo(
              'Overwrite files',
              'Allow Console to replace existing generated files.',
              'Enable only when refreshing a local setup.',
              'Boolean toggle.',
              'When disabled, Console refuses to overwrite existing files.',
            ),
          },
          {
            key: 'profile_path',
            label: 'profile path',
            kind: 'text',
            default: values.profile_path ?? defaultRuntimeConfigPath(),
            dependsOn: { generate_profile: 'true' },
            info: guidedInfo(
              'Profile path',
              'Local path for the generated runtime profile.',
              '~/.config/caracal/config.toml',
              'Absolute or user-relative file path.',
              'The profile path is used in generated CARACAL_CONFIG commands.',
            ),
          },
          {
            key: 'secret_file_path',
            label: 'secret file',
            kind: 'text',
            default: values.secret_file_path ?? '',
            dependsOn: { generate_profile: 'true' },
            info: guidedInfo(
              'Secret file',
              'Local file that stores the app client secret.',
              '~/.config/caracal/son-of-anton-client-secret',
              'File path different from profile path; blank derives one.',
              'SDKs and runtime read the app secret from this file.',
            ),
          },
          {
            key: 'credential_env',
            label: 'token env',
            kind: 'text',
            default: values.credential_env ?? '',
            dependsOn: { generate_profile: 'true' },
            info: guidedInfo(
              'Token env',
              'Environment variable name that receives the protected resource token.',
              'CARACAL_RESOURCE_PIPERNET_TOKEN',
              'Uppercase env var name; blank derives one.',
              'Generated examples use this variable for Gateway and SDK calls.',
            ),
          },
        ],
        onSubmit: async (raw, advancedApp) => {
          Object.assign(this.values, raw)
          advancedApp.pop()
        },
      }),
    )
  }

  private openStepInfo(app: App): void {
    const step = this.currentStep()
    openInfo(
      app,
      infoPage({
        title: step.title,
        meaning: step.explanation,
        when:
          step.key === 'review'
            ? 'Use this after completing the object pages and advanced settings.'
            : 'Open this page to fill the real fields for that object with picker and field-level help.',
        example:
          step.key === 'provider'
            ? 'Pick the upstream credential type that matches the resource you just defined.'
            : 'Use the page fields and press ? on any field for examples.',
        valid: 'Press enter to open the page. Use pickers for existing objects and normal field validation for new objects.',
        after:
          step.key === 'review'
            ? 'Console creates only missing objects, activates the selected policy path, and shows setup output.'
            : 'Saving the page returns here and moves to the next guided step.',
      }),
    )
  }

  private async create(app: App): Promise<void> {
    this.applyHiddenProvider()
    const message = this.validateAll()
    if (message) {
      app.setStatus(message, 'error')
      return
    }
    this.submitting = true
    app.invalidate()
    try {
      const result = await runFirstSetup(this.ctx, this.buildValues(), app)
      this.ctx.state?.markSetupCompleted()
      app.pop()
      app.push(
        new DetailView({
          title: 'first setup result',
          load: async () => setupSummary(result),
          mask: maskSecretField,
        }),
      )
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
    if (trimmed(this.values.provider_name)) return `${this.values.provider_name} (${providerKindLabel(this.values.provider_kind)} create)`
    const selectedProviderId = trimmed(this.values.selected_provider_id)
    if (selectedProviderId) return selectedProviderId
    return ui.muted('open page')
  }

  private validateReady(): string | undefined {
    if (!this.selectedZone && !trimmed(this.values.selected_zone_id) && !trimmed(this.values.zone_name) && !this.ctx.zoneId)
      return 'zone is required'
    if (!this.selectedApplication && !trimmed(this.values.selected_agent_app_id) && !trimmed(this.values.agent_app_name))
      return 'agent app is required'
    if (!this.selectedResource && !trimmed(this.values.selected_resource_id) && !trimmed(this.values.resource_name))
      return 'resource is required'
    if (splitList(this.values.resource_scopes).length === 0) return 'at least one Caracal scope is required'
    if (!trimmed(this.values.upstream_url)) return 'upstream URL is required'
    if (!setupPreset(this.values.preset).hidesProvider) {
      if (this.values.provider_mode === 'select' && !trimmed(this.values.selected_provider_id)) return 'provider is required'
      if (this.values.provider_mode === 'create') {
        if (!trimmed(this.values.provider_name)) return 'provider is required'
        try {
          providerConfigFromValues(this.values)
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
      }
    }
    return undefined
  }
}

type ZoneResult = Awaited<ReturnType<typeof ensureZone>>
type ApplicationResult = Awaited<ReturnType<typeof ensureApplication>>
type ProviderResult = Awaited<ReturnType<typeof ensureProvider>>
type ResourceResult = Awaited<ReturnType<typeof ensureResource>>
type PolicyResult = Awaited<ReturnType<typeof createFirstPolicy>>

function zoneIdOf(resolved: DraftResolver): string {
  return resolved.get<ZoneResult>('zone').zone.id
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
    ? profileTarget(
        values,
        existingZoneId ?? trimmed(values.zone_name) ?? 'default-zone',
        trimmed(values.selected_agent_app_id) ?? applicationName,
        targetResourceIdentifier,
      )
    : undefined
  if (writeFiles && target) await assertWritableTarget(target, overwriteFiles)

  const upstreamUrl = trimmed(values.upstream_url)
  const pipeline = new DraftPipeline()
  pipeline.stage('zone', { commit: () => ensureZone(ctx, values, app) })
  pipeline.stage('application', {
    dependsOn: ['zone'],
    commit: (r) => ensureApplication(ctx, zoneIdOf(r), values),
  })
  pipeline.stage('provider', {
    dependsOn: ['zone'],
    commit: (r) => ensureProvider(ctx, zoneIdOf(r), values, upstreamUrl),
  })
  pipeline.stage('resource', {
    dependsOn: ['zone', 'application', 'provider'],
    commit: (r) =>
      ensureResource(
        ctx,
        zoneIdOf(r),
        r.get<ApplicationResult>('application').application.id,
        values,
        scopes,
        upstreamUrl,
        r.get<ProviderResult>('provider').provider.id,
      ),
  })
  pipeline.stage('policy', {
    dependsOn: ['zone', 'application', 'resource'],
    skip: () => !bool(values.activate_policy),
    commit: (r) =>
      createFirstPolicy(
        ctx,
        zoneIdOf(r),
        r.get<ApplicationResult>('application').application.id,
        r.get<ResourceResult>('resource').resource.identifier,
        scopes,
      ),
  })

  const committed = await pipeline.commit()
  const zoneResult = committed.get<ZoneResult>('zone')
  const applicationResult = committed.get<ApplicationResult>('application')
  const providerResult = committed.get<ProviderResult>('provider')
  const resourceResult = committed.get<ResourceResult>('resource')
  const policy = committed.has('policy') ? committed.get<PolicyResult>('policy') : undefined

  const finalTarget = shouldGenerateProfile
    ? profileTarget(values, zoneResult.zone.id, applicationResult.application.id, resourceResult.resource.identifier)
    : undefined
  const profile = finalTarget
    ? buildProfile(
        finalTarget,
        zoneResult.zone.id,
        applicationResult.application.id,
        resourceResult.resource.identifier,
        upstreamUrl,
        profileCredentialType(providerResult.provider),
      )
    : undefined
  const requestPath = normalizeRequestPath(values.request_path)
  const fileWrite = profile ? await setupFileWrite(profile, applicationResult.clientSecret, writeFiles, overwriteFiles) : undefined

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
  const application = await ctx.client.applications.create(zoneId, {
    name: requiredText(values.agent_app_name, 'agent app is required'),
    registration_method: 'managed',
  })
  const clientSecret = requireClientSecret(application.client_secret)
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
  return trimmed(values.resource_identifier) ?? `resource://${safeName(requiredText(values.resource_name, 'resource is required'))}`
}

async function ensureProvider(
  ctx: Ctx,
  zoneId: string,
  values: SetupValues,
  upstreamUrl: string | undefined,
): Promise<{ provider: Provider; created: boolean }> {
  const selectedProviderId = trimmed(values.selected_provider_id)
  if (selectedProviderId) return { provider: await ctx.client.providers.get(zoneId, selectedProviderId), created: false }
  if (!trimmed(values.provider_name)) throw new Error('provider is required')
  const provider = await ctx.client.providers.create(zoneId, providerInputFromValues(values))
  return { provider, created: true }
}

async function ensureResource(
  ctx: Ctx,
  zoneId: string,
  applicationId: string,
  values: SetupValues,
  scopes: string[],
  upstreamUrl: string | undefined,
  providerId: string,
): Promise<{ resource: Resource; created: boolean; updated: boolean }> {
  const selectedResourceId = trimmed(values.selected_resource_id)
  if (!selectedResourceId) {
    return {
      resource: await ctx.client.resources.create(zoneId, {
        ...(trimmed(values.resource_identifier) ? { identifier: trimmed(values.resource_identifier) } : {}),
        name: trimmed(values.resource_name),
        scopes,
        upstream_url: upstreamUrl,
        gateway_application_id: applicationId,
        credential_provider_id: providerId,
      }),
      created: true,
      updated: false,
    }
  }

  const current = await ctx.client.resources.get(zoneId, selectedResourceId)
  const patch: Partial<ResourceInput> = {}
  if (!sameList(current.scopes ?? [], scopes)) patch.scopes = scopes
  if (current.upstream_url !== upstreamUrl) patch.upstream_url = upstreamUrl
  if (current.gateway_application_id !== applicationId) patch.gateway_application_id = applicationId
  if (current.credential_provider_id !== providerId) patch.credential_provider_id = providerId
  const updated = Object.keys(patch).length > 0
  return {
    resource: updated ? await ctx.client.resources.patch(zoneId, selectedResourceId, patch) : current,
    created: false,
    updated,
  }
}

function guidedInfo(title: string, meaning: string, example: string, valid: string, after: string) {
  return infoPage({
    title,
    meaning,
    when: 'Use this during guided setup when this value defines how Caracal creates or links the object.',
    impact: 'Guided setup stores this value in the setup plan and uses it to create or reuse real Control API objects.',
    example,
    valid,
    after,
    notes: ['Values entered here are not placeholders; they flow into the final app, resource, policy, or profile output.'],
  })
}

function zonePicker(ctx: Ctx): Field['pick'] {
  return (app, setValue) => {
    app.push(
      new EntityPickerView<Zone>({
        title: 'choose zone',
        load: () => ctx.client.zones.list(),
        value: (row) => row.id,
        label: zoneLabel,
        description: (row) => row.slug,
        onPick: setValue,
      }),
    )
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
    app.push(
      new EntityPickerView<Application>({
        title: 'choose agent app',
        load: async () =>
          (await ctx.client.applications.list(requireSetupZoneId(zoneId))).filter((row) => row.registration_method === 'managed'),
        value: (row) => row.id,
        label: (row) => row.name,
        onPick: setValue,
      }),
    )
  }
}

function applicationResolver(ctx: Ctx, zoneId: () => string | undefined): Field['resolve'] {
  return async (id) => (await ctx.client.applications.get(requireSetupZoneId(zoneId), id)).name
}

function providerPicker(ctx: Ctx, zoneId: () => string | undefined): Field['pick'] {
  return (app, setValue) => {
    app.push(
      new EntityPickerView<Provider>({
        title: 'choose provider',
        load: () => ctx.client.providers.list(requireSetupZoneId(zoneId)),
        value: (row) => row.id,
        label: providerLabel,
        description: (row) => [row.identifier, row.kind ?? undefined].filter(Boolean).join('  '),
        onPick: setValue,
      }),
    )
  }
}

function providerResolver(ctx: Ctx, zoneId: () => string | undefined): Field['resolve'] {
  return async (id) => providerLabel(await ctx.client.providers.get(requireSetupZoneId(zoneId), id))
}

function resourcePicker(ctx: Ctx, zoneId: () => string | undefined): Field['pick'] {
  return (app, setValue) => {
    app.push(
      new EntityPickerView<Resource>({
        title: 'choose resource',
        load: async () => userResources(await ctx.client.resources.list(requireSetupZoneId(zoneId))),
        value: (row) => row.id,
        label: resourceLabel,
        description: (row) => [row.identifier, (row.scopes ?? []).join(',')].filter(Boolean).join('  '),
        onPick: setValue,
      }),
    )
  }
}

function resourceResolver(ctx: Ctx, zoneId: () => string | undefined): Field['resolve'] {
  return async (id) => resourceLabel(await ctx.client.resources.get(requireSetupZoneId(zoneId), id))
}

function validateProviderIdentifier(value: string): string | undefined {
  const text = value.trim()
  if (!text || PROVIDER_IDENTIFIER_PATTERN.test(text)) return undefined
  return 'provider identifier must stay in provider://lowercase-slug format'
}

function validateResourceIdentifier(value: string): string | undefined {
  const text = value.trim()
  if (!text) return undefined
  try {
    const url = new URL(text)
    if (url.protocol === 'provider:' || url.username || url.password) throw new Error()
    return undefined
  } catch {
    return 'resource identifier must be an absolute resource audience URI and must not use provider://'
  }
}

function providerKind(value: string | undefined): ProviderKind {
  return PROVIDER_KINDS.includes(value as ProviderKind) ? (value as ProviderKind) : 'caracal_mandate'
}

function submittedOAuthClientAuthMethod(values: SetupValues): string {
  if (providerKind(values.provider_kind) === 'oauth2_authorization_code')
    return values.provider_auth_code_client_auth_method || 'client_secret_basic'
  return values.provider_client_credentials_auth_method || 'client_secret_basic'
}

function providerInputFromValues(values: SetupValues): ProviderInput {
  const identifier = providerIdentifierValue(values.provider_identifier)
  const base = {
    ...(identifier ? { identifier } : {}),
    name: trimmed(values.provider_name),
  }
  const kind = providerKind(values.provider_kind)
  const config = providerConfigFromValues(values)
  switch (kind) {
    case 'none':
      return { ...base, kind, config_json: config as EmptyProviderConfig }
    case 'caracal_mandate':
      return { ...base, kind, config_json: config as EmptyProviderConfig }
    case 'oauth2_authorization_code':
      return { ...base, kind, config_json: config as OAuth2AuthorizationCodeProviderConfig }
    case 'oauth2_client_credentials':
      return { ...base, kind, config_json: config as OAuth2ClientCredentialsProviderConfig }
    case 'api_key':
      return { ...base, kind, config_json: config as APIKeyProviderConfig }
    case 'bearer_token':
      return { ...base, kind, config_json: config as BearerTokenProviderConfig }
  }
}

function providerIdentifierValue(value: string | undefined): ProviderIdentifier | undefined {
  const text = trimmed(value)
  if (!text) return undefined
  if (!isProviderIdentifier(text)) throw new Error('provider identifier must stay in provider://lowercase-slug format')
  return text
}

function providerConfigFromValues(values: SetupValues): ProviderConfig {
  const kind = providerKind(values.provider_kind)
  const config: JsonObject = {}
  mergeConfigText(config, 'authorization_endpoint', values.provider_authorization_endpoint)
  mergeConfigText(config, 'token_endpoint', values.provider_token_endpoint)
  mergeConfigText(config, 'redirect_uri', values.provider_redirect_uri)
  mergeConfigText(config, 'client_id', values.provider_client_id)
  mergeConfigText(config, 'client_secret', values.provider_client_secret)
  mergeConfigText(config, 'private_key', values.provider_private_key)
  mergeConfigText(config, 'api_key', values.provider_api_key)
  mergeConfigText(config, 'bearer_token', values.provider_bearer_token)
  if (kind === 'oauth2_authorization_code' || kind === 'oauth2_client_credentials') {
    mergeConfigText(config, 'client_auth_method', submittedOAuthClientAuthMethod(values))
  }
  mergeConfigText(config, 'key_id', values.provider_key_id)
  mergeConfigList(config, 'scopes', values.provider_scopes)
  mergeConfigMap(config, 'authorization_params', values.provider_authorization_params)
  mergeConfigMap(config, 'token_params', values.provider_token_params)
  mergeConfigText(config, 'audience', values.provider_token_audience)
  mergeConfigText(config, 'resource', values.provider_token_resource)
  mergeConfigList(
    config,
    'allowed_token_hosts',
    kind === 'bearer_token'
      ? values.provider_allowed_upstream_hosts || inferredTokenHosts(values.upstream_url)
      : values.provider_oauth_token_hosts || inferredTokenHosts(values.provider_token_endpoint),
  )
  mergeConfigText(config, 'auth_location', values.provider_api_key_auth_location)
  mergeConfigText(config, 'header_name', values.provider_api_key_header)
  mergeConfigText(config, 'query_param_name', values.provider_api_key_query_param)
  mergeConfigText(config, 'auth_header', values.provider_auth_header)
  mergeConfigText(config, 'auth_scheme', values.provider_auth_scheme)
  if (values.provider_forward_caracal_identity === 'true') config.forward_caracal_identity = true
  if (values.provider_allow_runtime_injection === 'true') config.allow_runtime_injection = true
  const allowed = providerConfigKeys(kind)
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) delete config[key]
  }
  validateProviderConfig(kind, config)
  return config as ProviderConfig
}

function mergeConfigText(config: JsonObject, key: string, value: string | undefined): void {
  const text = value?.trim()
  if (text) config[key] = text
}

function mergeConfigList(config: JsonObject, key: string, value: string | undefined): void {
  const items = splitList(value)
  if (items.length > 0) config[key] = items
}

function mergeConfigMap(config: JsonObject, key: string, value: string | undefined): void {
  const text = trimmed(value)
  if (!text) return
  const params: JsonObject = {}
  for (const item of splitList(text)) {
    const index = item.indexOf('=')
    if (index <= 0) throw new Error(`${key} entries must use key=value`)
    const name = item.slice(0, index).trim()
    const paramValue = item.slice(index + 1).trim()
    if (!name || !paramValue) throw new Error(`${key} entries must use key=value`)
    params[name] = paramValue
  }
  config[key] = params
}

function inferredTokenHosts(endpoint: string | undefined): string {
  const value = trimmed(endpoint)
  if (!value) return ''
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

function validateProviderConfig(kind: ProviderKind, config: JsonObject): void {
  if (kind === 'none' || kind === 'caracal_mandate') return
  if (kind === 'api_key') {
    const location = apiKeyAuthLocation(config)
    if (location === 'header') {
      requireString(config, 'header_name', 'api_key provider config requires header_name')
      requireOptionalHeaderName(config, 'header_name', 'api_key provider config header_name must be an HTTP header name')
      requireOptionalAuthScheme(config, 'auth_scheme', 'api_key provider config auth_scheme must be an auth scheme token')
    } else {
      requireString(config, 'query_param_name', 'api_key provider config requires query_param_name')
      requireOptionalQueryParamName(config, 'query_param_name', 'api_key provider config query_param_name must be a query parameter name')
      if (config.auth_scheme !== undefined) throw new Error('api_key provider config auth_scheme applies only to header auth')
    }
    requireString(config, 'api_key', 'api_key provider config requires api_key')
    return
  }
  if (kind === 'bearer_token') {
    requireString(config, 'bearer_token', 'bearer_token provider config requires bearer_token')
    requireOptionalHostList(config, 'allowed_token_hosts', 'bearer_token provider config allowed_token_hosts must be DNS hostnames')
    requireOptionalHeaderName(config, 'auth_header', 'bearer_token provider config auth_header must be an HTTP header name')
    requireOptionalAuthScheme(config, 'auth_scheme', 'bearer_token provider config auth_scheme must be an auth scheme token')
    return
  }
  requireHttpsUrl(config, 'token_endpoint', `${kind} provider config token_endpoint must be an HTTPS URL`)
  requireString(config, 'client_id', `${kind} provider config requires client_id`)
  if (typeof config.client_auth_method === 'string' && !OAUTH_CLIENT_AUTH_METHODS.includes(config.client_auth_method)) {
    throw new Error(`${kind} provider config client_auth_method is invalid`)
  }
  if (kind === 'oauth2_authorization_code' && config.client_auth_method === 'private_key_jwt') {
    throw new Error('oauth2_authorization_code provider config client_auth_method is not supported')
  }
  if (config.client_auth_method === 'private_key_jwt') {
    requireString(config, 'private_key', `${kind} provider config requires private_key`)
    if (config.client_secret !== undefined) throw new Error(`${kind} provider config client_secret is not used with private_key_jwt`)
  } else if (config.client_auth_method !== 'none') {
    requireString(config, 'client_secret', `${kind} provider config requires client_secret`)
  }
  requireStringList(config, 'allowed_token_hosts', `${kind} provider config requires allowed_token_hosts`)
  requireOptionalStringRecord(
    config,
    'token_params',
    RESERVED_OAUTH_TOKEN_PARAMS,
    `${kind} provider config token_params must use non-reserved key=value entries`,
  )
  requireOptionalHeaderName(config, 'auth_header', `${kind} provider config auth_header must be an HTTP header name`)
  requireOptionalAuthScheme(config, 'auth_scheme', `${kind} provider config auth_scheme must be an auth scheme token`)
  if (kind === 'oauth2_client_credentials') {
    requireOptionalText(config, 'audience', 'oauth2_client_credentials provider config audience must be a non-empty string')
    requireOptionalText(config, 'resource', 'oauth2_client_credentials provider config resource must be a non-empty string')
    requireOptionalText(config, 'key_id', 'oauth2_client_credentials provider config key_id must be a non-empty string')
  } else if (config.key_id !== undefined || config.private_key !== undefined) {
    throw new Error(`${kind} provider config private_key_jwt fields are not supported`)
  }
  if (config.client_auth_method !== 'private_key_jwt') {
    if (config.private_key !== undefined) throw new Error(`${kind} provider config private_key requires private_key_jwt`)
    if (config.key_id !== undefined) throw new Error(`${kind} provider config key_id requires private_key_jwt`)
  }
  if (kind === 'oauth2_authorization_code') {
    requireHttpsUrl(
      config,
      'authorization_endpoint',
      'oauth2_authorization_code provider config authorization_endpoint must be an HTTPS URL',
    )
    requireAbsoluteUri(config, 'redirect_uri', 'oauth2_authorization_code provider config redirect_uri must be an absolute URI')
    requireOptionalStringRecord(
      config,
      'authorization_params',
      RESERVED_OAUTH_AUTHORIZATION_PARAMS,
      'oauth2_authorization_code provider config authorization_params must use non-reserved key=value entries',
    )
  }
}

function requireHttpsUrl(config: JsonObject, key: string, message: string): void {
  requireString(config, key, message)
  const value = config[key] as string
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw new Error()
  } catch {
    throw new Error(message)
  }
}

function requireAbsoluteUri(config: JsonObject, key: string, message: string): void {
  requireString(config, key, message)
  const value = config[key] as string
  try {
    const url = new URL(value)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) throw new Error()
  } catch {
    throw new Error(message)
  }
}

function requireOptionalHeaderName(config: JsonObject, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'string' || !HEADER_TOKEN_PATTERN.test(value.trim())) throw new Error(message)
  config[key] = value.trim()
}

function requireOptionalAuthScheme(config: JsonObject, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'string' || !AUTH_SCHEME_PATTERN.test(value.trim())) throw new Error(message)
  config[key] = value.trim()
}

function requireOptionalQueryParamName(config: JsonObject, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'string' || !OAUTH_PARAM_PATTERN.test(value.trim())) throw new Error(message)
  config[key] = value.trim()
}

function apiKeyAuthLocation(config: JsonObject): 'header' | 'query' {
  const value = config.auth_location
  if (value === undefined) {
    config.auth_location = 'header'
    return 'header'
  }
  if (value === 'header' || value === 'query') return value
  throw new Error('api_key provider config auth_location must be header or query')
}

function requireOptionalStringRecord(config: JsonObject, key: string, reserved: ReadonlySet<string>, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  for (const [name, item] of Object.entries(value)) {
    if (reserved.has(name) || !OAUTH_PARAM_PATTERN.test(name) || typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(message)
    }
  }
}

function providerConfigKeys(kind: ProviderKind): Set<string> {
  if (kind === 'none' || kind === 'caracal_mandate') return new Set()
  if (kind === 'api_key')
    return new Set([
      'auth_location',
      'header_name',
      'query_param_name',
      'api_key',
      'auth_scheme',
      'forward_caracal_identity',
      'allow_runtime_injection',
    ])
  if (kind === 'bearer_token')
    return new Set([
      'bearer_token',
      'allowed_token_hosts',
      'auth_header',
      'auth_scheme',
      'forward_caracal_identity',
      'allow_runtime_injection',
    ])
  const keys = [
    'token_endpoint',
    'client_id',
    'client_secret',
    'client_auth_method',
    'scopes',
    'allowed_token_hosts',
    'token_params',
    'auth_header',
    'auth_scheme',
    'forward_caracal_identity',
    'allow_runtime_injection',
  ]
  if (kind === 'oauth2_client_credentials') keys.push('audience', 'resource', 'key_id', 'private_key')
  if (kind === 'oauth2_authorization_code') keys.push('authorization_endpoint', 'redirect_uri', 'authorization_params')
  return new Set(keys)
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

function requireOptionalHostList(config: JsonObject, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  requireStringList(config, key, message)
  config[key] = (value as string[]).map((item) => {
    const host = item.trim().toLowerCase()
    if (!HOST_PATTERN.test(host) || host.includes('..')) throw new Error(message)
    return host
  })
}

function requireOptionalText(config: JsonObject, key: string, message: string): void {
  const value = config[key]
  if (value === undefined) return
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message)
  config[key] = value.trim()
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
  const content = firstAccessPolicy(applicationId, resourceIdentifier, scopes)
  const validation = await ctx.client.policies.validate(content)
  const policy = await ctx.client.policies.create(zoneId, {
    name: 'Guided setup access policy',
    description:
      'Starter Rego allow-list explicitly approved during guided setup. Allows only the configured agent app to request the configured protected resource with the configured Caracal resource scopes.',
    content,
  })
  const policySet = await ctx.client.policySets.create(
    zoneId,
    'Guided setup access policy set',
    'Active policy set approved during guided setup.',
  )
  const version = await ctx.client.policySets.addVersion(zoneId, policySet.id, [{ policy_version_id: policy.version.id }])
  await ctx.client.policySets.activate(zoneId, policySet.id, version.id)
  return {
    id: policy.id,
    name: policy.name,
    version: policy.version,
    policy_set_id: policySet.id,
    policy_set_version_id: version.id,
    preview: validation.preview,
    warnings: validation.warnings,
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
  credentialType: 'provider_token' | 'caracal_mandate',
): SetupResult['profile'] {
  const stsUrl = process.env.CARACAL_STS_URL ?? process.env.CARACAL_ZONE_URL
  const coordinatorUrl = process.env.CARACAL_COORDINATOR_URL
  const gatewayUrl = process.env.CARACAL_GATEWAY_URL
  const lines = [
    ...(stsUrl ? [`sts_url = ${quoteToml(stsUrl)}`] : []),
    ...(coordinatorUrl && coordinatorUrl !== DEFAULT_COORDINATOR_URL ? [`coordinator_url = ${quoteToml(coordinatorUrl)}`] : []),
    ...(gatewayUrl && gatewayUrl !== DEFAULT_GATEWAY_URL ? [`gateway_url = ${quoteToml(gatewayUrl)}`] : []),
    `zone_id = ${quoteToml(zoneId)}`,
    `application_id = ${quoteToml(applicationId)}`,
    ...(target.secretPath === defaultAppClientSecretFilePath(zoneId, applicationId)
      ? []
      : [`app_client_secret_file = ${quoteToml(target.secretPath)}`]),
    'continue_on_failure = false',
    'ttl_seconds = 900',
    '',
    '[[credentials]]',
    `env = ${quoteToml(target.credentialEnv)}`,
    `resource = ${quoteToml(resourceIdentifier)}`,
    `credential_type = ${quoteToml(credentialType)}`,
  ]
  if (upstreamUrl) lines.push(`upstream_prefix = ${quoteToml(upstreamUrl)}`)
  return { ...target, gatewayUrl: gatewayUrl ?? DEFAULT_GATEWAY_URL, content: lines.join('\n') + '\n' }
}

function profileCredentialType(provider: Provider): 'provider_token' | 'caracal_mandate' {
  if (PROVIDER_CREDENTIAL_KINDS.includes(provider.kind) && provider.config_json?.allow_runtime_injection === true) {
    return 'provider_token'
  }
  return 'caracal_mandate'
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
    const evaluates = result.policy.preview?.inputs_referenced ?? []
    const decisions = result.policy.preview?.decisions ?? []
    summary.access_policy = {
      status: 'created and activated',
      kind: 'starter least-privilege allow-list',
      summary: 'Denies by default and allows only the selected app to request the selected resource scopes.',
      ...(decisions.length > 0 ? { decisions } : {}),
      ...(evaluates.length > 0 ? { evaluates } : {}),
      ...(result.policy.warnings.length > 0 ? { warnings: result.policy.warnings } : {}),
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
          : 'Gateway forwards the Caracal mandate to the configured upstream.',
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
  summary.what_just_happened = {
    authority:
      'The agent exchanges its app client secret for a short-lived, resource-scoped Caracal token (15 minute TTL) instead of holding the upstream credential.',
    enforcement: result.resource.gateway_application_id
      ? 'The Gateway authorizes every call against the active policy before any upstream credential is applied.'
      : 'Attach a Gateway route to this resource so the Gateway can enforce policy and broker the upstream credential.',
    audit_and_revoke:
      'Every decision is recorded in the audit ledger. Trace the first call in Audit, and revoke the app session to cut access immediately.',
  }
  summary.audit_explanation = {
    first_success:
      'After the first protected call, open Audit, select the request, and trace it to view the policy decision and Gateway result.',
    if_no_event: 'Re-check the active policy, resource identifier, Gateway route, and runtime profile before retrying.',
  }
  return summary
}

function profileTarget(values: SetupValues, zoneId: string, applicationId: string, resourceIdentifier: string): ProfileTarget {
  const path = trimmed(values.profile_path) ?? defaultRuntimeConfigPath()
  const secretPath = trimmed(values.secret_file_path) ?? defaultAppClientSecretFilePath(zoneId, applicationId)
  if (path === secretPath) throw new Error('profile path and secret file must be different files')
  return {
    path,
    secretPath,
    credentialEnv: trimmed(values.credential_env) ?? credentialEnvName(resourceIdentifier),
  }
}

async function assertWritableTarget(target: ProfileTarget, overwrite: boolean): Promise<void> {
  if (overwrite) return
  const existing = await Promise.all([existingPath(target.path), existingPath(target.secretPath)])
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
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
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

function requireClientSecret(value: string | undefined): string {
  if (!value) throw new Error('application response did not include the one-time client secret')
  return value
}

function quoteRego(value: string): string {
  return JSON.stringify(value)
}

function quoteToml(value: string): string {
  return JSON.stringify(value)
}

function safeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'caracal-app'
}

function credentialEnvName(resourceIdentifier: string): string {
  const body = resourceIdentifier
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const normalized = body.length > 0 ? body : 'RESOURCE'
  return `CARACAL_${normalized}_TOKEN`
}
