// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Focused contextual info pages for Console controls and fields.

import { pad, sanitizeAnsi, ui } from '../ansi.ts'
import type { Key } from '../keys.ts'
import type { App, View, ViewContext } from '../screen.ts'

export interface InfoPage {
  title: string
  meaning: string
  when: string
  impact?: string
  example?: string
  valid: string
  after: string
  context?: readonly InfoPair[]
  terms?: readonly InfoPair[]
  notes?: readonly string[]
}

export interface InfoPair {
  label: string
  value: string
}

export interface FieldInfoOpts {
  key?: string
  required?: boolean
  picker?: boolean
  advanced?: boolean
  options?: readonly string[]
  dependency?: string
}

export function infoPage(page: InfoPage): InfoPage {
  return page
}

export function fieldInfo(label: string, kind: string, hint?: string, opts: FieldInfoOpts = {}): InfoPage {
  const title = label || 'Field'
  const required = opts.required ? 'Required for this path.' : 'Optional for this path.'
  return {
    title,
    meaning: hint ? sentence(hint) : meaningFor(kind, title, opts),
    when: whenFor(kind, title, opts),
    impact: impactFor(kind, title, opts),
    example: exampleFor(kind, title, opts.options, opts),
    valid: `${required} ${validFor(kind, title, opts.options, opts)}`,
    after: afterFor(kind, title, opts),
    context: opts.dependency ? [{ label: 'Visibility', value: opts.dependency }] : undefined,
    terms: termsFor(title),
  }
}

export function actionInfo(label: string, after = 'After confirmation, Console sends the request and refreshes the current view.'): InfoPage {
  const normalized = label.toLowerCase()
  return {
    title: label,
    meaning: actionMeaning(normalized, label),
    when: actionWhen(normalized),
    impact: actionImpact(normalized),
    example: label.toLowerCase().includes('create') ? 'Create PiperNet resource' : label,
    valid: 'The action is valid when required fields are complete and selected objects still exist.',
    after,
    notes: actionNotes(normalized),
  }
}

export function providerTypeInfo(): InfoPage {
  return infoPage({
    title: 'Provider type',
    meaning: 'The provider type tells Caracal what credential shape the Gateway should send to the upstream service.',
    when: 'Choose none only when Gateway should enforce Caracal access but the upstream needs no credential. Choose Caracal mandate for any Caracal-aware upstream that verifies mandates directly; choose a provider-native credential only when the upstream requires its own auth.',
    impact: 'Console shows only the fields needed for the selected type, and STS/Gateway either send no upstream credential, forward the mandate as the credential, or obtain the upstream provider credential.',
    context: [
      { label: 'None', value: 'Use only for Gateway-enforced routes where the upstream expects no auth credential from Caracal.' },
      { label: 'Caracal mandate', value: 'Use for internal, partner, external, or network-level resources that accept Caracal mandates and verify issuer, audience, scopes, targets, expiry, and revocation.' },
      { label: 'OAuth 2.0 authorization code', value: 'Use for user-approved integrations with a consent screen, callback URI, and refreshable delegated access.' },
      { label: 'OAuth 2.0 client credentials', value: 'Use for server-to-server OAuth where no end user signs in and the provider issues tokens to the application itself.' },
      { label: 'API key', value: 'Use when the provider gives a long-lived key that must be sent in a specific request header or query parameter.' },
      { label: 'Bearer token', value: 'Use when a provider access token is already issued outside Caracal and should be forwarded as-is.' },
    ],
    terms: [
      { label: 'Delegated', value: 'A user or account has approved access through the provider, and Caracal refreshes that provider grant when needed.' },
      { label: 'Service token', value: 'The provider issues tokens to a backend application instead of a signed-in user.' },
      { label: 'Static secret', value: 'The provider credential is provisioned out-of-band and stored sealed for Gateway use.' },
    ],
    example: 'Use Caracal mandate for a PiperNet service with a verifier; use none for a Gateway-only enforcement route; use OAuth 2.0 authorization code for a user-connected Hooli workspace.',
    valid: 'Pick exactly one supported provider type. Use none only when the upstream expects no credential. Use Caracal mandate when the upstream accepts Caracal mandates as its auth credential. If the upstream docs mention an authorization URL and redirect URI, use OAuth 2.0 authorization code. If they mention client credentials, use OAuth 2.0 client credentials. If they give a header key or query parameter key, use API key. If they give a ready bearer token, use Bearer token.',
    after: 'After choosing a type, Console shows the required fields for that upstream auth mode and hides fields that do not apply.',
    notes: [
      'Caracal app secrets are not provider credentials; they only authenticate the agent to Caracal.',
      'Provider credentials stay behind STS/Gateway and should not be copied into agent code.',
      'Prefer OAuth 2.0 flows over static tokens when the upstream provider supports rotation and revocation.',
    ],
  })
}

export function presetInfo(): InfoPage {
  return infoPage({
    title: 'Scenario',
    meaning: 'The scenario sets what you are protecting and how the Gateway authenticates to the upstream, then limits the wizard to the fields that scenario needs.',
    when: 'Pick the scenario that matches your upstream. The simple scenarios skip the provider page entirely; the credential scenarios fix the provider type so you only fill its fields.',
    impact: 'A no-secret or mandate scenario auto-creates the matching provider and hides the credential matrix. A credential scenario locks the provider type. The custom scenario exposes every provider type and field.',
    context: [
      { label: 'Internal HTTP API (no upstream secret)', value: 'Gateway enforces Caracal access and forwards no upstream credential. Best first run.' },
      { label: 'Caracal-aware service (mandate)', value: 'Gateway forwards a Caracal mandate the upstream verifies directly.' },
      { label: 'Upstream API key', value: 'Broker a static upstream API key injected into a header or query parameter.' },
      { label: 'Upstream OAuth (client credentials)', value: 'Server-to-server OAuth where the provider issues tokens to the application itself.' },
      { label: 'Upstream OAuth (user consent)', value: 'User-approved OAuth with a consent screen, callback URI, and refreshable access.' },
      { label: 'Custom provider', value: 'Choose any provider type and configure every upstream authentication field yourself.' },
    ],
    example: 'Protect Not Hotdog with no upstream secret, or broker a Hooli API key for PiperNet.',
    valid: 'Pick exactly one scenario. Change it any time before review to reshape the remaining pages.',
    after: 'Saving applies the scenario and continues to the agent app and resource pages.',
    notes: ['The scenario only changes which fields appear; every object is still created through the real Control API.'],
  })
}

export function openInfo(app: App, page: InfoPage | undefined): void {  if (!page) {
    app.setStatus('no contextual help is available for this item', 'error')
    return
  }
  app.push(new InfoView(page))
}

export class InfoView implements View {
  readonly title: string
  readonly isTextEntry = true
  private readonly page: InfoPage
  private offset = 0

  constructor(page: InfoPage) {
    this.page = page
    this.title = `info / ${page.title}`
  }

  hints(): string[] { return ['↑/↓:scroll', 'esc:back'] }

  render(ctx: ViewContext): string[] {
    const body = this.bodyLines(ctx.size.cols)
    return body.slice(this.offset, this.offset + ctx.size.rows)
  }

  onKey(key: Key, ctx: ViewContext): void {
    const max = Math.max(0, this.bodyLines(ctx.size.cols).length - ctx.size.rows)
    if (key === 'up' || key === 'k') { this.offset = Math.max(0, this.offset - 1); return }
    if (key === 'down' || key === 'j') { this.offset = Math.min(max, this.offset + 1); return }
    if (key === 'esc' || key === 'left') ctx.app.pop()
  }

  private bodyLines(width: number): string[] {
    const lines = [
      '',
      ' ' + ui.title(this.page.title),
      '',
      ...infoLine('Means', this.page.meaning, width),
      ...infoLine('Use when', this.page.when, width),
    ]
    if (this.page.impact) lines.push(...infoLine('Impact', this.page.impact, width))
    if (this.page.context?.length) {
      lines.push('', ' ' + ui.accent('Context'))
      for (const item of this.page.context) lines.push(...infoLine(item.label, item.value, width))
    }
    if (this.page.terms?.length) {
      lines.push('', ' ' + ui.accent('Terms'))
      for (const item of this.page.terms) lines.push(...infoLine(item.label, item.value, width))
    }
    if (this.page.example) lines.push(...infoLine('Example', this.page.example, width))
    lines.push(
      ...infoLine('Valid input', this.page.valid, width),
      ...infoLine('After submit', this.page.after, width),
      '',
    )
    if (this.page.notes?.length) {
      lines.push(' ' + ui.accent('Operational notes'))
      for (const note of this.page.notes) lines.push(...wrapped(` - ${sanitizeAnsi(note)}`, width, 3))
      lines.push('')
    }
    return lines
  }
}

function infoLine(label: string, value: string, width: number): string[] {
  const prefix = ' ' + ui.muted(pad(label, 14)) + ' '
  const bodyWidth = Math.max(24, width - 17)
  return wrapText(sanitizeAnsi(value), bodyWidth).map((line, index) => index === 0
    ? prefix + line
    : ' ' + ui.muted(pad('', 14)) + ' ' + line)
}

function wrapped(value: string, width: number, indent: number): string[] {
  return wrapText(value, Math.max(24, width - indent)).map((line, index) => ' '.repeat(index === 0 ? indent : indent + 2) + line)
}

function wrapText(value: string, width: number): string[] {
  const words = value.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line.length === 0) {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line += ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  return lines
}

function sentence(value: string): string {
  const text = value.trim()
  if (!text) return text
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function meaningFor(kind: string, title: string, opts: FieldInfoOpts): string {
  const label = title.toLowerCase()
  const key = opts.key ?? ''
  if (isNumericLabel(label)) return `${title} is a numeric value that controls a count, limit, lifetime, or time window.`
  if (key === 'api_key_auth_location' || key === 'provider_api_key_auth_location') return `${title} selects whether Gateway sends the upstream API key in a header or query parameter.`
  if (key === 'api_key_header' || label.includes('api key header')) return `${title} is the exact HTTP request header where Gateway sends the upstream API key.`
  if (key === 'api_key_query_param' || key === 'provider_api_key_query_param') return `${title} is the exact query parameter where Gateway sends the upstream API key.`
  if (key === 'auth_header' || label.includes('upstream authorization header')) return `${title} is the HTTP request header where Gateway sends the provider credential to the upstream.`
  if (key === 'auth_scheme' || label.includes('upstream authorization scheme')) return `${title} is the credential prefix Gateway writes before the provider token or key value.`
  if (key === 'api_key') return `${title} is the static upstream API key sealed by Caracal and injected by Gateway.`
  if (key === 'bearer_token') return `${title} is the static upstream bearer token sealed by Caracal and injected by Gateway.`
  if (key === 'client_id' || label.includes('client id')) return `${title} is the OAuth client identifier issued by the upstream provider.`
  if (key === 'client_secret' || label.includes('client secret')) return `${title} is the OAuth client secret issued by the upstream provider and sealed by Caracal.`
  if (key === 'auth_code_client_auth_method' || key === 'client_credentials_auth_method' || key === 'provider_auth_code_client_auth_method' || key === 'provider_client_credentials_auth_method' || label.includes('oauth client authentication')) return `${title} tells STS how the OAuth client authenticates to the token endpoint.`
  if (key === 'authorization_params' || label.includes('authorization parameters')) return `${title} are extra OAuth authorization request parameters sent when Console starts browser consent.`
  if (key === 'token_params' || label.includes('token parameters')) return `${title} are extra OAuth token endpoint parameters sent during exchange or refresh.`
  if (key === 'oauth_token_hosts' || key === 'provider_oauth_token_hosts' || label.includes('oauth token endpoint hosts')) return `${title} limits which OAuth token endpoint hosts STS may contact during token exchange and refresh.`
  if (key === 'bearer_upstream_hosts' || key === 'provider_allowed_upstream_hosts' || label.includes('allowed upstream hosts')) return `${title} limits which upstream hosts Gateway may receive a static bearer token.`
  if (key === 'token_audience' || label.includes('token audience')) return `${title} is the OAuth audience parameter requested for client-credentials tokens.`
  if (key === 'token_resource' || label.includes('resource indicator')) return `${title} is the OAuth resource parameter requested for providers that require resource indicators.`
  if (key === 'credential_provider_id') return `${title} is the provider whose credential Gateway should use for this resource.`
  if (key === 'gateway_application_id') return `${title} is the managed application the Gateway exchanges as to obtain this resource's upstream credential; it does not restrict which agents may call through the Gateway.`
  if (key === 'selected_agent_app_id') return `${title} identifies the existing application to reuse in guided setup.`
  if (key === 'selected_provider_id') return `${title} identifies the existing provider to reuse in guided setup.`
  if (key === 'selected_resource_id') return `${title} identifies the existing resource to reuse in guided setup.`
  if (key === 'selected_zone_id' || key === 'zone_id') return `${title} identifies the Caracal zone for this operation.`
  if (key === 'existing_app_client_secret') return `${title} is the existing application secret used by generated client examples.`
  if (key === 'request_path') return `${title} is the first Gateway route path shown in generated runtime examples.`
  if (key === 'profile_path') return `${title} is the local shell profile path where setup can write exported environment values.`
  if (key === 'secret_file_path') return `${title} is the local path where setup can write generated secret values.`
  if (key === 'credential_env') return `${title} names the environment variable that will hold the minted Caracal token.`
  if (key === 'dcr_enabled') return `${title} controls whether the zone allows dynamic client registration.`
  if (key === 'policy_versions') return `${title} selects policy versions to include in a policy set.`
  if (key === 'version_id' || key === 'shadow_version_id') return `${title} identifies a policy-set version used for activation or simulation.`
  if (key === 'request_id') return `${title} filters or explains one audited request.`
  if (key === 'event_type') return `${title} filters audit events by their recorded event name.`
  if (key === 'decision') return `${title} filters authorization results by allow, deny, or partial outcome.`
  if (key === 'status') return `${title} filters records by lifecycle state.`
  if (key === 'source') return `${title} chooses whether Console reads content from pasted input or a local file.`
  if (key === 'content') return `${title} is the policy source text saved as a policy version.`
  if (key === 'input') return `${title} is the JSON request input used for a policy simulation.`
  if (label.includes('forward') && label.includes('caracal identity')) return `${title} tells Gateway to send the Caracal resource mandate to the upstream service in addition to the provider credential.`
  if (label.includes('name')) return `${title} is the operator-facing label shown in lists, pickers, details, and setup output.`
  if (label.includes('provider') && label.includes('identifier')) return `${title} is the stable API-facing name for a configured upstream credential or mandate source.`
  if (label.includes('resource') && label.includes('identifier')) return `${title} is the stable audience value that policies, tokens, and Gateway bindings use.`
  if (label.includes('identifier')) return `${title} is a stable API-facing value used by clients, policy input, tokens, and audit records.`
  if (label.includes('upstream oauth scope')) return `${title} defines provider-native OAuth scopes requested during authorization-code consent or client-credentials token acquisition.`
  if (label.includes('scope')) return `${title} defines named permissions that requests and policies evaluate.`
  if (label.includes('subject')) return `${title} identifies the user, workload, or actor receiving authority.`
  if (label.includes('secret') || kind === 'secret') return `${title} is sensitive credential material used to authenticate an application or upstream integration.`
  if (label.includes('token endpoint')) return `${title} is the upstream endpoint used for OAuth token exchange or refresh.`
  if (label.includes('authorization endpoint')) return `${title} is the browser-facing OAuth URL used when an upstream provider needs authorization redirects.`
  if (label.includes('issuer')) return `${title} is the authority URL that signs or describes identity tokens.`
  if (label.includes('upstream') || label.includes('url')) return `${title} points Console or Gateway at the external service endpoint for this workflow.`
  if (label.includes('audience')) return `${title} is the audience value expected by the provider or protected service.`
  if (label.includes('path')) return `${title} is a local file path or request path used by the generated workflow output.`
  if (label.includes('env')) return `${title} names the environment variable shown in generated runtime commands.`
  if (label.includes('mode') || label.includes('action') || kind === 'select') return `${title} chooses the workflow branch and determines which fields or API path apply.`
  if (kind === 'bool') return `${title} toggles a specific behavior in the request being built.`
  if (kind === 'list') return `${title} is a comma-separated set of values sent as a structured list.`
  if (kind === 'file') return `${title} is read once and sent as content when the form is submitted.`
  if (kind === 'multiline') return `${title} is multi-line content saved or validated for the selected object.`
  return `${title} is the value Console sends for this field in the current API request.`
}

function whenFor(kind: string, title: string, opts: FieldInfoOpts): string {
  const label = title.toLowerCase()
  const key = opts.key ?? ''
  if (opts.picker) return `Pick an existing ${entityName(label)} when reusing configured state; type only when the flow accepts a new value.`
  if (isNumericLabel(label)) return 'Use this when you need to bound a lifetime, result count, retry budget, or other numeric operational limit.'
  if (key === 'api_key_auth_location' || key === 'provider_api_key_auth_location') return 'Choose query only when the provider documentation requires API keys in the URL query string.'
  if (key === 'api_key_header' || label.includes('api key header')) return 'Use the header named in the provider documentation for API-key authentication.'
  if (key === 'api_key_query_param' || key === 'provider_api_key_query_param') return 'Use the query parameter name documented by the upstream provider.'
  if (key === 'auth_header' || label.includes('upstream authorization header')) return 'Set this only when the upstream expects credentials outside the standard Authorization header.'
  if (key === 'auth_scheme' || label.includes('upstream authorization scheme')) return 'Set this only when the upstream expects a non-default credential prefix such as Token, ApiKey, or Key.'
  if (key === 'auth_code_client_auth_method' || key === 'client_credentials_auth_method' || key === 'provider_auth_code_client_auth_method' || key === 'provider_client_credentials_auth_method' || label.includes('oauth client authentication')) return 'Use the method required by the OAuth provider token endpoint; basic is the common default for confidential clients.'
  if (key === 'authorization_params' || label.includes('authorization parameters')) return 'Use this for provider-specific consent options such as offline access, prompt behavior, tenant, or organization.'
  if (key === 'token_params' || label.includes('token parameters')) return 'Use this only for provider-specific token endpoint parameters that Caracal does not manage itself.'
  if (key === 'oauth_token_hosts' || key === 'provider_oauth_token_hosts' || label.includes('oauth token endpoint hosts')) return 'Use this to pin OAuth exchange and refresh to documented token endpoint hosts when inference from the token endpoint is not enough.'
  if (key === 'bearer_upstream_hosts' || key === 'provider_allowed_upstream_hosts' || label.includes('allowed upstream hosts')) return 'Use this to pin static bearer-token forwarding to the upstream hosts that are allowed to receive the token.'
  if (key === 'token_audience' || label.includes('token audience')) return 'Use this when the OAuth provider requires an audience value for client-credentials tokens.'
  if (key === 'token_resource' || label.includes('resource indicator')) return 'Use this when the OAuth provider requires an RFC 8707 resource indicator or equivalent resource value.'
  if (key === 'credential_provider_id') return 'Use this to bind a Gateway resource to exactly one provider credential source.'
  if (key === 'gateway_application_id') return 'Set the managed application identity the Gateway exchanges as for this resource\'s upstream calls.'
  if (key === 'selected_agent_app_id' || key === 'selected_provider_id' || key === 'selected_resource_id' || key === 'selected_zone_id') return 'Use this when setup should reuse an existing object instead of creating another one.'
  if (key === 'zone_id') return 'Use this when a diagnostic or workflow should run against one zone instead of all visible zones.'
  if (key === 'existing_app_client_secret') return 'Use this when reusing an existing application whose one-time secret is already stored outside Console.'
  if (key === 'request_path') return 'Use this to make generated examples call a realistic first upstream route.'
  if (key === 'profile_path' || key === 'secret_file_path') return 'Use this when generated local files should be written somewhere other than the default path.'
  if (key === 'credential_env') return 'Use this when generated commands should expose the token under a predictable environment variable.'
  if (key === 'request_id') return 'Use this when investigating one Gateway, STS, policy, or audit request.'
  if (key === 'source' || key === 'input_source') return 'Choose file when the content already lives on disk; choose paste when entering it directly in Console.'
  if (label.includes('forward') && label.includes('caracal identity')) return 'Turn this on only for a trusted upstream that authenticates with provider-native credentials but also needs Caracal subject, scopes, target, zone, or audit context.'
  if (label.includes('name')) return 'Enter the name operators should recognize later in lists, pickers, audit views, and setup output.'
  if (label.includes('provider') && label.includes('identifier')) return 'Leave blank to let Console generate one from the provider name; set it only when automation needs a specific stable name.'
  if (label.includes('resource') && label.includes('identifier')) return 'Set this only when clients, policies, or automation need a stable resource audience that differs from the generated default.'
  if (label.includes('identifier')) return 'Set this only when clients, policies, or automation need a stable identifier that differs from the generated default.'
  if (label.includes('upstream authorization header')) return 'Use this only when the upstream API expects provider credentials in a non-standard HTTP header.'
  if (label.includes('upstream authorization scheme')) return 'Use this only when the upstream API expects a provider credential prefix such as Bearer or ApiKey.'
  if (opts.advanced) return 'Use this only when the inferred default or standard picker does not match an enterprise or non-standard setup.'
  if (label.includes('scope')) return 'Use the scopes that the application will request and that policies should be able to authorize.'
  if (label.includes('subject')) return 'Use the subject identity that should receive or be inspected for authority in this zone.'
  if (label.includes('secret') || kind === 'secret') return 'Paste this only while registering, rotating, or writing a credential that Console cannot retrieve later.'
  if (label.includes('token endpoint')) return 'Use the exact HTTPS endpoint exposed by the upstream provider for token exchange.'
  if (label.includes('authorization endpoint')) return 'Use this only for provider flows that require browser authorization redirects.'
  if (label.includes('issuer')) return 'Use the issuer URL from the upstream identity provider or workload trust configuration.'
  if (label.includes('upstream') || label.includes('url')) return 'Use this when Gateway or provider integration must call a concrete external endpoint.'
  if (label.includes('audience')) return 'Use the audience expected by the target service or identity provider.'
  if (label.includes('path')) return 'Use this when generated output should point to a specific file location or first request route.'
  if (label.includes('env')) return 'Use this when generated commands should expose the token under a predictable environment variable.'
  if (label.includes('mode') || label.includes('action') || kind === 'select') return 'Choose the branch that matches the operational path; dependent fields below may change.'
  if (kind === 'bool') return 'Toggle this only when you want the corresponding request behavior to change.'
  if (kind === 'file') return 'Use this when the source is maintained as a local file instead of pasted into Console.'
  if (kind === 'multiline') return 'Use this when policy, JSON, or other structured content is easier to paste or author directly.'
  if (kind === 'list') return 'Use this when the API field expects multiple values rather than one string.'
  return `Set ${title} only when the current workflow requires an explicit value; keep the default or leave it blank when the field is optional.`
}

function entityName(label: string): string {
  if (label.includes('zone')) return 'zone'
  if (label.includes('app')) return 'application'
  if (label.includes('resource')) return 'resource'
  if (label.includes('provider')) return 'provider'
  if (label.includes('policy set')) return 'policy set'
  if (label.includes('policy')) return 'policy'
  if (label.includes('grant')) return 'session'
  if (label.includes('session')) return 'session'
  return 'object'
}

function impactFor(kind: string, title: string, opts: FieldInfoOpts): string {
  const label = title.toLowerCase()
  const key = opts.key ?? ''
  if (isNumericLabel(label)) return 'Changing this value changes how long something remains valid, how much data is returned, or which numeric limit the API applies.'
  if (key === 'api_key_auth_location' || key === 'provider_api_key_auth_location') return 'Gateway changes where the sealed API key is injected and removes caller-supplied credentials at that location.'
  if (key === 'api_key_header' || label.includes('api key header')) return 'Gateway writes the sealed API key into this header and strips caller-supplied values for protected credential headers.'
  if (key === 'api_key_query_param' || key === 'provider_api_key_query_param') return 'Gateway writes the sealed API key into this query parameter and replaces caller-supplied values for that parameter.'
  if (key === 'auth_header' || label.includes('upstream authorization header')) return 'Gateway writes OAuth or bearer credentials into this header after removing caller-supplied credential headers.'
  if (key === 'auth_scheme' || label.includes('upstream authorization scheme')) return 'Gateway formats the upstream auth value as "<scheme> <credential>" when a scheme is configured.'
  if (key === 'api_key' || key === 'bearer_token' || key === 'client_secret') return 'The value is sealed for storage and is never shown back in Console after submit.'
  if (key === 'client_id' || label.includes('client id')) return 'STS sends this identifier to the OAuth token endpoint during authorization-code, refresh, or client-credentials flows.'
  if (key === 'auth_code_client_auth_method' || key === 'client_credentials_auth_method' || key === 'provider_auth_code_client_auth_method' || key === 'provider_client_credentials_auth_method' || label.includes('oauth client authentication')) return 'A wrong method can make provider token exchange or refresh fail even when the endpoint and secret are correct.'
  if (key === 'authorization_params' || label.includes('authorization parameters')) return 'These parameters are appended to the OAuth authorization URL after Caracal-managed safety parameters.'
  if (key === 'token_params' || label.includes('token parameters')) return 'These parameters are included in token exchange or refresh after Caracal-managed OAuth parameters.'
  if (key === 'oauth_token_hosts' || key === 'provider_oauth_token_hosts' || label.includes('oauth token endpoint hosts')) return 'STS rejects OAuth token endpoints outside this allowlist during exchange, client-credentials acquisition, and refresh.'
  if (key === 'bearer_upstream_hosts' || key === 'provider_allowed_upstream_hosts' || label.includes('allowed upstream hosts')) return 'Gateway rejects static bearer-token forwarding when the resource upstream host is not in this allowlist.'
  if (key === 'credential_provider_id') return 'STS/Gateway use the bound provider to build the upstream credential directive for this resource.'
  if (key === 'gateway_application_id') return 'Tokens and audit records can tie Gateway-originated upstream access to this application.'
  if (key === 'selected_agent_app_id' || key === 'selected_provider_id' || key === 'selected_resource_id' || key === 'selected_zone_id') return 'Setup links the generated output to the selected existing object instead of creating a replacement.'
  if (key === 'zone_id') return 'Console scopes the operation to this zone when the field is filled.'
  if (key === 'existing_app_client_secret') return 'Generated files and commands can authenticate the existing application without rotating it.'
  if (key === 'request_path') return 'The generated quickstart command uses this path for the first Gateway request.'
  if (key === 'profile_path' || key === 'secret_file_path') return 'Setup writes generated local output to this path when file writing is enabled.'
  if (key === 'credential_env') return 'Generated runtime commands read the minted token from this environment variable.'
  if (label.includes('scope')) return 'Scopes bound here constrain what tokens or policies may authorize later.'
  if (label.includes('forward') && label.includes('caracal identity')) return 'Gateway keeps the provider credential in the upstream authorization header and sends the Caracal mandate separately as X-Caracal-Identity.'
  if (label.includes('provider') && label.includes('identifier')) return 'Resources, setup output, and automation can reference the provider by this stable name.'
  if (label.includes('resource') && label.includes('identifier')) return 'Changing a resource audience can break clients that request the old value.'
  if (label.includes('identifier')) return 'Identifiers are stable API-facing names; changing them can affect clients and automation.'
  if (label.includes('upstream authorization header')) return 'Gateway writes the provider credential to this header after removing caller-supplied credential headers.'
  if (label.includes('upstream authorization scheme')) return 'Gateway prefixes the provider credential with this scheme when building the upstream request.'
  if (label.includes('secret') || kind === 'secret') return 'Secrets are copied into requests exactly as pasted and are hidden in the terminal by default.'
  if (label.includes('token endpoint')) return 'Token endpoints are contacted when Caracal exchanges or refreshes upstream credentials.'
  if (label.includes('authorization endpoint')) return 'Authorization endpoints are stored on the provider and used to start OAuth browser authorization redirects.'
  if (label.includes('redirect uri')) return 'The provider redirects users back to this URI after authorization approval or denial.'
  if (label.includes('upstream')) return 'Upstream values affect where Gateway sends protected traffic.'
  if (kind === 'bool') return 'This toggles behavior in the API request; leave unchanged unless you intend that behavior change.'
  if (kind === 'file') return 'Console reads the file once at submit time; later file edits do not change the saved object.'
  return 'Console sends this value in the API request for the selected object.'
}

function afterFor(kind: string, title: string, opts: FieldInfoOpts): string {
  const label = title.toLowerCase()
  const key = opts.key ?? ''
  if (label.includes('authorization endpoint')) return 'After submit, Console saves this in provider config so OAuth authorization-code flows can redirect users to the provider consent page.'
  if (label.includes('token endpoint')) return 'After submit, Console saves this in provider config so STS can exchange or refresh provider tokens.'
  if (label.includes('redirect uri')) return 'After submit, Console saves this in provider config and the OAuth provider must have the same callback URI registered.'
  if (key === 'api_key' || key === 'bearer_token' || key === 'client_secret') return 'After submit, Console sends the secret once for sealed storage; future detail views show only metadata.'
  if (key === 'api_key_auth_location' || key === 'provider_api_key_auth_location' || key === 'api_key_query_param' || key === 'provider_api_key_query_param' || key === 'api_key_header' || key === 'auth_header' || key === 'auth_scheme' || label.includes('api key header') || label.includes('upstream authorization header') || label.includes('upstream authorization scheme')) return 'After submit, Gateway uses this formatting when injecting provider credentials into upstream requests.'
  if (key === 'authorization_params' || label.includes('authorization parameters')) return 'After submit, Console includes these parameters when creating the OAuth authorization URL.'
  if (key === 'token_params' || label.includes('token parameters')) return 'After submit, STS includes these parameters in OAuth token exchange or refresh requests.'
  if (key === 'oauth_token_hosts' || key === 'provider_oauth_token_hosts' || label.includes('oauth token endpoint hosts')) return 'After submit, STS enforces this allowlist for OAuth token exchange and refresh endpoints.'
  if (key === 'bearer_upstream_hosts' || key === 'provider_allowed_upstream_hosts' || label.includes('allowed upstream hosts')) return 'After submit, Gateway enforces this allowlist before forwarding static bearer tokens to upstream hosts.'
  if (key === 'credential_provider_id') return 'After submit, the resource cannot issue upstream Gateway credentials unless this upstream credential provider binding is valid.'
  return opts.advanced
    ? 'After saving advanced options, Console keeps this value on the parent form and sends it only when you submit.'
    : 'After submit, Console sends this value to the Admin API and shows the result or validation error.'
}

function termsFor(title: string): InfoPair[] | undefined {
  const label = title.toLowerCase()
  const terms: InfoPair[] = []
  if (label.includes('dcr') || label.includes('dynamic client')) terms.push({ label: 'DCR', value: 'Dynamic Client Registration; lets an app be registered through the API when the zone enables it.' })
  if (label.includes('forward') && label.includes('caracal identity')) terms.push({ label: 'X-Caracal-Identity', value: 'Gateway header containing the Caracal mandate when an upstream also needs Caracal authorization context.' })
  if (label.includes('scope')) terms.push({ label: 'Scope', value: 'A named permission string requested in a token and evaluated by policies.' })
  if (label.includes('resource')) terms.push({ label: 'Resource', value: 'The protected API, service, audience, or Gateway target being accessed.' })
  if (label.includes('provider')) terms.push({ label: 'Provider', value: 'An upstream credential source Caracal can use for protected calls.' })
  if (label.includes('policy')) terms.push({ label: 'Policy', value: 'Authorization logic that evaluates requests and returns allow, deny, or partial decisions.' })
  if (label.includes('agent session')) terms.push({ label: 'Agent session', value: 'A Coordinator record for one agent execution and child activity.' })
  else if (label.includes('session')) terms.push({ label: 'Authority session', value: 'A tracked authority context used for token exchange, delegation, or agent activity.' })
  return terms.length > 0 ? terms : undefined
}

function actionMeaning(normalized: string, label: string): string {
  if (normalized.includes('create') || normalized.includes('new')) return 'Creates a new Control API object using the values in the current form.'
  if (normalized.includes('edit') || normalized.includes('patch')) return 'Changes the selected object by sending only the submitted fields.'
  if (normalized.includes('delete')) return 'Archives or removes the selected object through the Control API.'
  if (normalized.includes('validate')) return 'Checks policy or configuration input without making it active.'
  if (normalized.includes('simulate')) return 'Runs a dry evaluation so you can inspect the decision before changing live behavior.'
  if (normalized.includes('activate')) return 'Makes a selected version the effective policy set used for authorization decisions.'
  if (normalized.includes('revoke')) return 'Stops a delegation, token, or key from being used again.'
  if (normalized.includes('rotate')) return 'Issues replacement credentials while keeping the managed object identity.'
  if (normalized.includes('control')) return 'Opens a Control service workflow for automation keys, tokens, or lifecycle state.'
  return `${label} opens the focused Console workflow for the current page.`
}

function actionWhen(normalized: string): string {
  if (normalized.includes('delete') || normalized.includes('revoke')) return 'Use it only after confirming the selected object is no longer needed or should lose authority.'
  if (normalized.includes('rotate')) return 'Use it when a secret may be exposed, is expiring, or needs scheduled replacement.'
  if (normalized.includes('validate') || normalized.includes('simulate')) return 'Use it before activating or saving changes that could affect authorization.'
  if (normalized.includes('create') || normalized.includes('new')) return 'Use it when the object does not already exist in the selected zone.'
  return 'Use it after reviewing the visible values and any advanced settings that apply.'
}

function actionImpact(normalized: string): string {
  if (normalized.includes('delete')) return 'The object disappears from normal Console lists and dependent workflows may fail if they still reference it.'
  if (normalized.includes('revoke')) return 'Existing authority is terminated or made unusable for future requests.'
  if (normalized.includes('activate')) return 'New authorization decisions use the activated policy-set version.'
  if (normalized.includes('simulate') || normalized.includes('validate')) return 'No production state changes; the result is informational.'
  if (normalized.includes('rotate')) return 'The new secret must be stored by the operator because it may not be retrievable later.'
  return 'Console sends an API request and reports the result or validation error.'
}

function actionNotes(normalized: string): string[] | undefined {
  if (normalized.includes('delete') || normalized.includes('revoke')) return ['Prefer copy-page on the detail view first if you need a record of the exact object.', 'If the API rejects the action, Console leaves the current view unchanged.']
  if (normalized.includes('rotate')) return ['Copy the one-time secret immediately and update dependent clients before discarding the result page.']
  return undefined
}

function exampleFor(kind: string, label: string, options?: readonly string[], opts: FieldInfoOpts = {}): string {
  const normalized = label.toLowerCase()
  const key = opts.key ?? ''
  if (normalized.includes('forward') && normalized.includes('caracal identity')) return 'no'
  if (kind === 'bool') return 'yes'
  if (key === 'api_key_auth_location' || key === 'provider_api_key_auth_location') return 'query'
  if (key === 'api_key_header' || normalized.includes('api key header')) return 'X-API-Key'
  if (key === 'api_key_query_param' || key === 'provider_api_key_query_param') return 'key'
  if (key === 'auth_header' || normalized.includes('upstream authorization header')) return 'Authorization'
  if (key === 'auth_scheme' || normalized.includes('upstream authorization scheme')) return 'Bearer'
  if (key === 'api_key') return '••••'
  if (key === 'bearer_token') return '••••'
  if (key === 'client_id' || normalized.includes('client id')) return 'hooli-pipernet-client'
  if (key === 'client_secret' || normalized.includes('client secret')) return '••••'
  if (key === 'auth_code_client_auth_method' || key === 'client_credentials_auth_method' || key === 'provider_auth_code_client_auth_method' || key === 'provider_client_credentials_auth_method' || normalized.includes('oauth client authentication')) return 'client_secret_basic'
  if (key === 'oauth_token_hosts' || key === 'provider_oauth_token_hosts' || normalized.includes('oauth token endpoint hosts')) return 'login.hooli.example'
  if (key === 'bearer_upstream_hosts' || key === 'provider_allowed_upstream_hosts' || normalized.includes('allowed upstream hosts')) return 'api.pipernet.example'
  if (key === 'token_audience' || normalized.includes('token audience')) return 'https://api.hooli.example'
  if (key === 'token_resource' || normalized.includes('resource indicator')) return 'https://api.hooli.example/pipernet'
  if (key === 'credential_provider_id') return 'provider://hooli-pipernet'
  if (key === 'gateway_application_id') return 'app://pipernet-agent'
  if (key === 'selected_agent_app_id') return 'app://pipernet-agent'
  if (key === 'selected_provider_id') return 'provider://hooli-pipernet'
  if (key === 'selected_resource_id') return 'resource://pipernet'
  if (key === 'selected_zone_id' || key === 'zone_id') return 'zone://pied-piper-prod'
  if (key === 'existing_app_client_secret') return '••••'
  if (key === 'request_path') return '/v1/files'
  if (key === 'profile_path') return '/home/richard/.caracal/pipernet-profile.sh'
  if (key === 'secret_file_path') return '/home/richard/.caracal/pipernet.env'
  if (key === 'credential_env') return 'CARACAL_TOKEN'
  if (key === 'description') return 'PiperNet production access policy.'
  if (key === 'request_id') return 'req_01jz8piper9hooli7n4'
  if (key === 'event_type') return 'gateway.request.completed'
  if (key === 'since') return '28 May 2026, 04:48:55 UTC'
  if (key === 'until') return '29 May 2026, 04:48:55 UTC'
  if (key === 'status') return options?.find((option) => option.length > 0) ?? 'active'
  if (key === 'decision') return options?.find((option) => option.length > 0) ?? 'allow'
  if (key === 'resource_id' || normalized === 'resource') return 'resource://pipernet'
  if (key === 'application_id' || normalized === 'application') return 'app://pipernet-agent'
  if (key === 'user_id' || normalized === 'user id' || normalized === 'subject id' || normalized === 'subject') return 'user:richard.hendricks@piedpiper.example'
  if (key === 'session_id' || normalized === 'session') return 'ses_01jz8piper9hooli7n4'
  if (key === 'edge_id' || normalized === 'delegation') return 'del_01jz8piper9hooli7n4'
  if (key === 'policy_versions') return 'polv_01jz8piper9hooli7n4'
  if (key === 'version_id' || key === 'shadow_version_id' || normalized === 'version' || normalized === 'shadow version') return 'psv_01jz8piper9hooli7n4'
  if (key === 'content') return 'package pipernet.authz'
  if (key === 'input') return '{"method":"GET","path":"/v1/files"}'
  if (key === 'input_file') return '/home/richard/pied-piper/simulations/request.json'
  if (key === 'file') return normalized.includes('policy') ? '/home/richard/pied-piper/policies/pipernet.rego' : '/home/richard/pied-piper/credential.json'
  if (key === 'source' || key === 'input_source') return options?.find((option) => option.length > 0) ?? 'paste'
  if (key === 'slug') return 'pipernet'
  if (key === 'id') return 'control-key-pipernet-prod'
  if (key === 'token') return '••••'
  if (kind === 'list' && normalized.includes('authorization parameters')) return 'access_type=offline,prompt=consent'
  if (kind === 'list' && normalized.includes('token parameters')) return 'tenant=hooli'
  if (kind === 'list' && normalized.includes('oauth token endpoint hosts')) return 'login.hooli.example'
  if (kind === 'list' && normalized.includes('allowed upstream hosts')) return 'api.pipernet.example'
  if (kind === 'list' && normalized.includes('permission')) return 'keys:read,tokens:mint'
  if (kind === 'list' && normalized.includes('policy versions')) return 'polv_01jz8piper9hooli7n4'
  if (kind === 'list') return 'read,write'
  if (kind === 'secret') return '••••'
  if (kind === 'file') return '/home/richard/pied-piper/policies/pipernet.rego'
  if (kind === 'select') return options?.find((option) => option.length > 0) ?? 'Choose one of the listed options.'
  if (isNumericLabel(normalized)) return numericExampleFor(normalized)
  if (normalized.includes('authorization endpoint')) return 'https://login.hooli.example/oauth/authorize'
  if (normalized.includes('token endpoint')) return 'https://login.hooli.example/oauth/token'
  if (normalized.includes('redirect uri')) return 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback'
  if (normalized.includes('url')) return 'https://api.pipernet.example'
  if (normalized.includes('provider') && normalized.includes('identifier')) return 'provider://hooli-pipernet'
  if (normalized.includes('resource') && normalized.includes('identifier')) return 'resource://pipernet'
  if (normalized.includes('identifier')) return 'resource://pipernet'
  if (normalized.includes('provider') && normalized.includes('name')) return 'Hooli OAuth'
  if (normalized.includes('resource') && normalized.includes('name')) return 'PiperNet'
  if (normalized.includes('zone') && normalized.includes('name')) return 'Pied Piper Production'
  if (normalized.includes('app') && normalized.includes('name')) return 'Son of Anton'
  if (normalized.includes('subject')) return 'user:richard.hendricks@piedpiper.example'
  return 'Son of Anton'
}

function validFor(kind: string, title: string, options?: readonly string[], opts: FieldInfoOpts = {}): string {
  const label = title.toLowerCase()
  const key = opts.key ?? ''
  if (isNumericLabel(label)) return 'Positive integer only; no units, commas, decimals, or text.'
  if (kind === 'bool') return 'Toggle on or off.'
  if (key === 'api_key_auth_location' || key === 'provider_api_key_auth_location') return 'One of: header, query.'
  if (key === 'api_key_header' || key === 'auth_header' || label.includes('api key header') || label.includes('upstream authorization header')) return 'HTTP header name only, without a colon or value.'
  if (key === 'api_key_query_param' || key === 'provider_api_key_query_param') return 'Query parameter name only, without = or the secret value.'
  if (key === 'auth_scheme' || label.includes('upstream authorization scheme')) return 'Credential scheme only, without the secret value; leave blank only when the upstream expects the raw credential.'
  if (key === 'api_key' || key === 'bearer_token' || key === 'client_secret' || key === 'token') return 'Paste the exact secret value; it is masked by default and not echoed after submit.'
  if (key === 'client_id' || label.includes('client id')) return 'Provider-issued client identifier exactly as shown in the upstream OAuth application.'
  if (label.includes('resource') && label.includes('identifier')) return 'Absolute resource audience URI such as resource://pipernet or an HTTPS audience URI; do not use provider:// or include credentials.'
  if (key === 'auth_code_client_auth_method' || key === 'client_credentials_auth_method' || key === 'provider_auth_code_client_auth_method' || key === 'provider_client_credentials_auth_method' || label.includes('oauth client authentication')) return `One of: ${(options ?? []).join(', ')}.`
  if (key === 'oauth_token_hosts' || key === 'provider_oauth_token_hosts' || key === 'bearer_upstream_hosts' || key === 'provider_allowed_upstream_hosts' || label.includes('oauth token endpoint hosts') || label.includes('allowed upstream hosts')) return 'Comma-separated DNS hostnames only; omit paths, schemes, query strings, and credentials.'
  if (key === 'authorization_params' || key === 'token_params' || label.includes('authorization parameters') || label.includes('token parameters')) return 'Comma-separated key=value pairs; do not include Caracal-managed OAuth parameters.'
  if (key === 'resource_id' || key === 'credential_provider_id' || key === 'gateway_application_id' || key === 'application_id' || key === 'session_id' || key === 'edge_id' || key === 'version_id' || key === 'shadow_version_id' || key === 'selected_agent_app_id' || key === 'selected_provider_id' || key === 'selected_resource_id' || key === 'selected_zone_id' || key === 'zone_id') return 'Choose an existing object from the picker or enter its stable ID exactly.'
  if (key === 'existing_app_client_secret') return 'Paste the existing application secret exactly as stored; Console cannot recover it from the API.'
  if (key === 'request_path') return 'Path beginning with /, without scheme, host, or credentials.'
  if (key === 'profile_path' || key === 'secret_file_path') return 'Absolute local file path.'
  if (key === 'credential_env') return 'Environment variable name using letters, numbers, and underscores.'
  if (key === 'request_id') return 'Exact request ID from audit, logs, Gateway, STS, or policy evaluation output.'
  if (key === 'since' || key === 'until') return 'Readable date/time, ISO timestamp, or supported relative time accepted by the API.'
  if (kind === 'list') return 'Comma-separated values; empty items are ignored.'
  if (kind === 'secret') return 'Paste the exact secret value; it is masked by default.'
  if (kind === 'file') return 'Pick a readable file or enter an absolute path.'
  if (kind === 'select') return `One of: ${(options ?? []).map((option) => option || '<empty>').join(', ')}.`
  if (kind === 'multiline') return 'Plain text content; pasted newlines are preserved.'
  if (label.includes('authorization endpoint')) return 'Absolute HTTPS URL for the provider authorization endpoint.'
  if (label.includes('token endpoint')) return 'Absolute HTTPS URL for the provider token endpoint.'
  if (label.includes('redirect uri')) return 'Absolute callback URI registered with the OAuth provider.'
  return 'Non-empty text when the field is marked required.'
}

function isNumericLabel(label: string): boolean {
  return /\b(seconds?|minutes?|hours?|days?|ttl|lifetime|limit|count|budget|depth|hops?|retries|attempts?)\b/.test(label)
}

function numericExampleFor(label: string): string {
  if (label.includes('day')) return '7'
  if (label.includes('ttl') || label.includes('lifetime') || label.includes('second')) return '3600'
  if (label.includes('limit') || label.includes('count')) return '50'
  if (label.includes('depth') || label.includes('hop')) return '3'
  return '10'
}
