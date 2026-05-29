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
    meaning: hint ? sentence(hint) : meaningFor(kind, title),
    when: whenFor(kind, title, opts),
    impact: impactFor(kind, title),
    example: exampleFor(kind, title, opts.options),
    valid: `${required} ${validFor(kind, title, opts.options)}`,
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
      { label: 'OAuth2 auth code', value: 'Use for user-approved integrations with a consent screen, callback URI, and refreshable delegated access.' },
      { label: 'OAuth2 client creds', value: 'Use for server-to-server OAuth where no end user signs in and the provider issues tokens to the application itself.' },
      { label: 'API key', value: 'Use when the provider gives a long-lived key that must be sent in a specific request header.' },
      { label: 'Bearer token', value: 'Use when a provider access token is already issued outside Caracal and should be forwarded as-is.' },
    ],
    terms: [
      { label: 'Delegated', value: 'A user or account has approved access through the provider, and Caracal refreshes that provider grant when needed.' },
      { label: 'Service token', value: 'The provider issues tokens to a backend application instead of a signed-in user.' },
      { label: 'Static secret', value: 'The provider credential is provisioned out-of-band and stored sealed for Gateway use.' },
    ],
    example: 'Use Caracal mandate for a PiperNet service with a verifier; use none for a Gateway-only enforcement route; use OAuth2 auth code for a user-connected Hooli workspace.',
    valid: 'Pick exactly one supported provider type. Use none only when the upstream expects no credential. Use Caracal mandate when the upstream accepts Caracal mandates as its auth credential. If the upstream docs mention an authorization URL and redirect URI, use OAuth2 auth code. If they mention client credentials, use OAuth2 client creds. If they give one header key, use API key. If they give a ready bearer token, use Bearer token.',
    after: 'After choosing a type, Console shows the required fields for that upstream auth mode and hides fields that do not apply.',
    notes: [
      'Caracal app secrets are not provider credentials; they only authenticate the agent to Caracal.',
      'Provider credentials stay behind STS/Gateway and should not be copied into agent code.',
      'Prefer OAuth2 flows over static tokens when the upstream provider supports rotation and revocation.',
    ],
  })
}

export function openInfo(app: App, page: InfoPage | undefined): void {
  if (!page) {
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

function meaningFor(kind: string, title: string): string {
  const label = title.toLowerCase()
  if (isNumericLabel(label)) return `${title} is a numeric value that controls a count, limit, lifetime, or time window.`
  if (label.includes('forward') && label.includes('caracal identity')) return `${title} tells Gateway to send the Caracal resource mandate to the upstream service in addition to the provider credential.`
  if (label.includes('name')) return `${title} is the operator-facing label shown in lists, pickers, details, and setup output.`
  if (label.includes('provider') && label.includes('identifier')) return `${title} is the stable API-facing name for a configured upstream credential or mandate source.`
  if (label.includes('resource') && label.includes('identifier')) return `${title} is the stable audience value that grants, policies, tokens, and Gateway bindings use.`
  if (label.includes('identifier')) return `${title} is a stable API-facing value used by clients, policy input, tokens, and audit records.`
  if (label.includes('scope')) return `${title} defines named permissions that requests, grants, and policies evaluate.`
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
  if (opts.picker) return `Pick an existing ${entityName(label)} when reusing configured state; type only when the flow accepts a new value.`
  if (isNumericLabel(label)) return 'Use this when you need to bound a lifetime, result count, retry budget, or other numeric operational limit.'
  if (label.includes('forward') && label.includes('caracal identity')) return 'Turn this on only for a trusted upstream that authenticates with provider-native credentials but also needs Caracal subject, scopes, target, zone, or audit context.'
  if (label.includes('name')) return 'Enter the name operators should recognize later in lists, pickers, grants, audit views, and setup output.'
  if (label.includes('provider') && label.includes('identifier')) return 'Leave blank to let Console generate one from the provider name; set it only when automation needs a specific stable name.'
  if (label.includes('resource') && label.includes('identifier')) return 'Set this only when clients, policies, or automation need a stable resource audience that differs from the generated default.'
  if (label.includes('identifier')) return 'Set this only when clients, policies, or automation need a stable identifier that differs from the generated default.'
  if (label.includes('upstream auth header')) return 'Use this only when the upstream API expects provider credentials in a non-standard HTTP header.'
  if (label.includes('upstream auth scheme')) return 'Use this only when the upstream API expects a provider credential prefix such as Bearer or ApiKey.'
  if (opts.advanced) return 'Use this only when the inferred default or standard picker does not match an enterprise or non-standard setup.'
  if (label.includes('scope')) return 'Use the scopes that the application will request and that grants or policies should be able to authorize.'
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
  if (label.includes('grant')) return 'grant'
  if (label.includes('session')) return 'session'
  return 'object'
}

function impactFor(kind: string, title: string): string {
  const label = title.toLowerCase()
  if (isNumericLabel(label)) return 'Changing this value changes how long something remains valid, how much data is returned, or which numeric limit the API applies.'
  if (label.includes('scope')) return 'Scopes bound here constrain what tokens, grants, or policies may authorize later.'
  if (label.includes('forward') && label.includes('caracal identity')) return 'Gateway keeps the provider credential in the upstream auth header and sends the Caracal mandate separately as X-Caracal-Identity.'
  if (label.includes('provider') && label.includes('identifier')) return 'Resources, grants, setup output, and automation can reference the provider by this stable name.'
  if (label.includes('resource') && label.includes('identifier')) return 'Changing a resource audience can break clients and grants that request the old value.'
  if (label.includes('identifier')) return 'Identifiers are stable API-facing names; changing them can affect clients and automation.'
  if (label.includes('upstream auth header')) return 'Gateway writes the provider credential to this header after removing caller-supplied credential headers.'
  if (label.includes('upstream auth scheme')) return 'Gateway prefixes the provider credential with this scheme when building the upstream request.'
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
  if (label.includes('authorization endpoint')) return 'After submit, Console saves this in provider config so OAuth authorization-code flows can redirect users to the provider consent page.'
  if (label.includes('token endpoint')) return 'After submit, Console saves this in provider config so STS can exchange or refresh provider tokens.'
  if (label.includes('redirect uri')) return 'After submit, Console saves this in provider config and the OAuth provider must have the same callback URI registered.'
  return opts.advanced
    ? 'After saving advanced options, Console keeps this value on the parent form and sends it only when you submit.'
    : 'After submit, Console sends this value to the Control API and shows the result or validation error.'
}

function termsFor(title: string): InfoPair[] | undefined {
  const label = title.toLowerCase()
  const terms: InfoPair[] = []
  if (label.includes('dcr') || label.includes('dynamic client')) terms.push({ label: 'DCR', value: 'Dynamic Client Registration; lets an app be registered through the API when the zone enables it.' })
  if (label.includes('forward') && label.includes('caracal identity')) terms.push({ label: 'X-Caracal-Identity', value: 'Gateway header containing the Caracal mandate when an upstream also needs Caracal authorization context.' })
  if (label.includes('scope')) terms.push({ label: 'Scope', value: 'A named permission string requested in a token and evaluated by grants and policies.' })
  if (label.includes('resource')) terms.push({ label: 'Resource', value: 'The protected API, service, audience, or Gateway target being accessed.' })
  if (label.includes('provider')) terms.push({ label: 'Provider', value: 'An upstream credential source Caracal can use for protected calls.' })
  if (label.includes('policy')) terms.push({ label: 'Policy', value: 'Authorization logic that evaluates requests and returns allow, deny, or partial decisions.' })
  if (label.includes('grant')) terms.push({ label: 'Grant', value: 'A binding that lets one subject use one application against selected resource scopes.' })
  if (label.includes('session')) terms.push({ label: 'Session', value: 'A tracked authority context used for token exchange, delegation, or agent activity.' })
  return terms.length > 0 ? terms : undefined
}

function actionMeaning(normalized: string, label: string): string {
  if (normalized.includes('create') || normalized.includes('new')) return 'Creates a new Control API object using the values in the current form.'
  if (normalized.includes('edit') || normalized.includes('patch')) return 'Changes the selected object by sending only the submitted fields.'
  if (normalized.includes('delete')) return 'Archives or removes the selected object through the Control API.'
  if (normalized.includes('validate')) return 'Checks policy or configuration input without making it active.'
  if (normalized.includes('simulate')) return 'Runs a dry evaluation so you can inspect the decision before changing live behavior.'
  if (normalized.includes('activate')) return 'Makes a selected version the effective policy set used for authorization decisions.'
  if (normalized.includes('revoke')) return 'Stops a grant, delegation, token, or key from being used again.'
  if (normalized.includes('rotate')) return 'Issues replacement credentials while keeping the managed object identity.'
  if (normalized.includes('credential')) return 'Opens a credential workflow for reading or inspecting protected-resource tokens.'
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

function exampleFor(kind: string, label: string, options?: readonly string[]): string {
  const normalized = label.toLowerCase()
  if (kind === 'bool') return 'yes'
  if (kind === 'list' && normalized.includes('authorization params')) return 'access_type=offline,prompt=consent'
  if (kind === 'list' && normalized.includes('token params')) return 'tenant=hooli'
  if (kind === 'list') return 'read,write'
  if (kind === 'secret') return '••••'
  if (kind === 'file') return '/home/richard/pied-piper/policies/pipernet.rego'
  if (kind === 'select') return options?.find((option) => option.length > 0) ?? 'Choose one of the listed options.'
  if (isNumericLabel(normalized)) return numericExampleFor(normalized)
  if (normalized.includes('forward') && normalized.includes('caracal identity')) return 'no'
  if (normalized.includes('authorization endpoint')) return 'https://login.hooli.example/oauth/authorize'
  if (normalized.includes('token endpoint')) return 'https://login.hooli.example/oauth/token'
  if (normalized.includes('redirect uri')) return 'http://localhost:3000/v1/zones/z1/provider-grants/oauth/callback'
  if (normalized.includes('url')) return 'https://api.pipernet.example'
  if (normalized.includes('provider') && normalized.includes('identifier')) return 'provider://hooli-pipernet'
  if (normalized.includes('resource') && normalized.includes('identifier')) return 'resource://pipernet'
  if (normalized.includes('identifier')) return 'resource://pipernet'
  if (normalized.includes('provider') && normalized.includes('name')) return 'Hooli OAuth2'
  if (normalized.includes('resource') && normalized.includes('name')) return 'PiperNet'
  if (normalized.includes('zone') && normalized.includes('name')) return 'Pied Piper Production'
  if (normalized.includes('app') && normalized.includes('name')) return 'Son of Anton'
  if (normalized.includes('subject')) return 'user:richard.hendricks@piedpiper.example'
  return 'Son of Anton'
}

function validFor(kind: string, title: string, options?: readonly string[]): string {
  if (isNumericLabel(title.toLowerCase())) return 'Positive integer only; no units, commas, decimals, or text.'
  if (kind === 'bool') return 'Toggle on or off.'
  if (kind === 'list') return 'Comma-separated values; empty items are ignored.'
  if (kind === 'secret') return 'Paste the exact secret value; it is masked by default.'
  if (kind === 'file') return 'Pick a readable file or enter an absolute path.'
  if (kind === 'select') return `One of: ${(options ?? []).map((option) => option || '<empty>').join(', ')}.`
  if (kind === 'multiline') return 'Plain text content; pasted newlines are preserved.'
  const label = title.toLowerCase()
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
