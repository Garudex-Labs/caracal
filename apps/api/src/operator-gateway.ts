// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator LLM gateway: a provider-agnostic completion client built on the Vercel AI SDK over any OpenAI-compatible endpoint with multi-provider failover.

import {
  APICallError,
  extractReasoningMiddleware,
  generateObject,
  generateText,
  smoothStream,
  streamText,
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ZodType } from 'zod'
import { buildGovernanceMiddleware, type GovernanceLimits } from './operator-ai-governance.js'

// A single configured backend. The OpenAI-compatible chat surface is the common
// denominator across hosted providers (OpenAI, Together, Groq), local servers
// (Ollama, vLLM), and aggregators (OpenRouter), so one client reaches all of them
// with no per-vendor SDK. A missing apiKey is valid for local backends that need
// no credential.
export interface ProviderConfig {
  id: string
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
  // The model's context window in tokens, supplied by the administrator since it is a
  // property of the chosen model rather than the transport. Zero means unknown, in which
  // case usage is reported as raw counts without a percentage of the window.
  contextWindow: number
  // A per-provider transport that replaces the default fetch for this provider only. A
  // governed provider routes through the Caracal gateway with a minted resource mandate, so
  // its transport attaches that authority and the key is never held here; an ungoverned
  // provider leaves this unset and calls its backend directly.
  transport?: typeof fetch
}

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionOptions {
  maxTokens?: number
  temperature?: number
  // The id of the provider the caller would like to use first. When it is configured and
  // available it is tried ahead of the failover order; otherwise it is ignored and the
  // normal order applies, so a stale preference never disables the gateway.
  preferredProvider?: string
}

export interface CompletionResult {
  text: string
  // The model's chain of thought when a reasoning model exposes it, either through the
  // OpenAI-compatible reasoning_content channel or inline <think> tags. Absent for models
  // that return only an answer.
  reasoning?: string
  provider: string
  model: string
  promptTokens?: number
  completionTokens?: number
}

// The live channels a streaming completion emits as it is produced. onText receives each answer
// delta so the console types the answer out; onReasoning receives each reasoning delta so a
// reasoning model's chain of thought is shown while it thinks rather than a blank wait before the
// answer begins. onReasoning is optional because not every model exposes reasoning.
export interface StreamHandlers {
  onText: (chunk: string) => void
  onReasoning?: (chunk: string) => void
}

// A schema-validated structured completion: the model's JSON answer parsed into the
// caller's type, with the same provider attribution and token counts as a text
// completion. Used by the agents that need a typed artifact rather than prose.
export interface CompletionObjectResult<T> {
  value: T
  provider: string
  model: string
  promptTokens?: number
  completionTokens?: number
}

export interface ProviderStatus {
  id: string
  model: string
  // Whether the provider is configured well enough to attempt a call. It does not
  // assert reachability - that is what the connectivity check verifies - and never
  // exposes whether a key is present beyond this boolean.
  available: boolean
  // The model's context window in tokens, or zero when the administrator has not
  // declared it. Surfaced so the console can show usage against the chosen model.
  contextWindow: number
}

export interface GatewayStatus {
  enabled: boolean
  providers: ProviderStatus[]
}

// The model that the next completion would run against, with its context window. Null
// when no provider is configured. Drawn from the first available provider, which is the
// one the failover order tries first.
export interface ActiveModel {
  model: string
  contextWindow: number
}

// Cumulative token usage tallied by a usage-tracking gateway wrapper over the calls made
// during a single request, so it never mixes usage across conversations. It also records which
// provider actually served, so a caller can report the real model after a failover and tell when
// Caracal fell back from its primary.
export interface GatewayUsage {
  inputTokens: number
  outputTokens: number
  // The provider and model that served the most recent successful completion, or null when no
  // completion succeeded - a budget refusal before the first call leaves both null.
  provider: string | null
  model: string | null
  // The distinct providers that served a completion this request, in first-served order. More than
  // one entry, or a single entry that is not the failover order's primary, means Caracal fell back.
  providers: string[]
}

// No provider is configured, so the AI tier is off. Distinct from a call failure so
// callers can degrade gracefully rather than treat "off" as an error.
export class GatewayUnavailableError extends Error {
  constructor() {
    super('no AI provider is configured')
    this.name = 'GatewayUnavailableError'
  }
}

// Every configured provider failed. attempts lists the per-provider failure reason
// with secrets already redacted, so it is safe to surface or log.
export class GatewayError extends Error {
  constructor(public readonly attempts: { provider: string; reason: string }[]) {
    super(`all AI providers failed (${attempts.length} attempted)`)
    this.name = 'GatewayError'
  }
}

// The per-turn model-call budget was reached, so a further completion is refused. This bounds the
// multi-agent fan-out deterministically: a turn that would make more model calls than Caracal
// permits stops rather than running an unbounded loop. It is a governance limit, not a model
// failure, so callers distinguish it from a provider error.
export class GatewayBudgetError extends Error {
  constructor(public readonly maxCalls: number) {
    super(`the per-turn model-call budget of ${maxCalls} was reached`)
    this.name = 'GatewayBudgetError'
  }
}

type FetchImpl = typeof fetch

// The OpenAI-compatible provider emits one benign warning on every structured
// completion that runs against a backend which does not advertise strict schema
// support: the gateway deliberately uses the portable JSON-object mode and validates
// the schema itself, so this warning is expected. It is filtered out once at the
// process level while every other warning is forwarded, keeping production logs clean
// without hiding real signal. Installation is idempotent and preserves any logger that
// was already set.
function installStructuredOutputWarningFilter(): void {
  type WarningEntry = { type?: string; feature?: string }
  type WarningLogger = (options: { warnings: WarningEntry[]; provider?: string; model?: string }) => void
  const globals = globalThis as Record<string, unknown>
  if (globals.caracalWarningFilterInstalled) return
  const previous = typeof globals.AI_SDK_LOG_WARNINGS === 'function' ? (globals.AI_SDK_LOG_WARNINGS as WarningLogger) : null
  const logger: WarningLogger = ({ warnings, provider, model }) => {
    const kept = warnings.filter((warning) => !(warning.type === 'unsupported' && warning.feature === 'responseFormat'))
    if (kept.length === 0) return
    if (previous) previous({ warnings: kept, provider, model })
    else console.warn('AI SDK Warning', { provider, model, warnings: kept })
  }
  globals.AI_SDK_LOG_WARNINGS = logger
  globals.caracalWarningFilterInstalled = true
}

installStructuredOutputWarningFilter()

function providerAvailable(provider: ProviderConfig): boolean {
  return provider.baseUrl.length > 0 && provider.model.length > 0
}

// Reasoning-family models reject certain OpenAI-compatible request parameters outright with a 400
// naming the offender (code unsupported_parameter or unsupported_value) instead of ignoring them:
// max_tokens must be max_completion_tokens for those models, and pinned sampling values such as
// temperature are refused. Which models do this is a moving target, so rather than a per-model
// matrix the gateway adapts at the wire: when the provider names the parameter, the request is
// retried with max_tokens renamed to its accepted form - preserving the governance output
// ceiling - and any other named parameter dropped. A 400 that names no parameter returns as-is.
// Learned rewrites are memoized per endpoint and model so only the first call pays the
// discovery round trip.
const WIRE_PARAM_RENAMES: Record<string, string> = { max_tokens: 'max_completion_tokens' }
const WIRE_PARAM_RETRIES = 3
const wireParamMemo = new Map<string, Record<string, string | null>>()

function unsupportedParam(payload: string): string | null {
  try {
    const { error } = JSON.parse(payload) as { error?: { code?: string; param?: string; message?: string } }
    if (!error) return null
    if ((error.code === 'unsupported_parameter' || error.code === 'unsupported_value') && error.param) return error.param
    const named = (error.message ?? '').match(/[Uu]nsupported (?:parameter|value):? '([A-Za-z_]+)'/)
    return named ? named[1] : null
  } catch {
    return null
  }
}

// Applies rename-or-drop actions to a JSON request body. Returns null when the body is not a
// JSON object or none of the named parameters are present, so the caller knows a retry would
// send an identical request.
function rewriteParams(body: string, actions: Record<string, string | null>): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  let touched = false
  for (const [param, rename] of Object.entries(actions)) {
    if (!(param in parsed)) continue
    if (rename !== null && !(rename in parsed)) parsed[rename] = parsed[param]
    delete parsed[param]
    touched = true
  }
  return touched ? JSON.stringify(parsed) : null
}

function adaptWireParams(fetchImpl: FetchImpl, dialect: string): FetchImpl {
  return async (input, init) => {
    let body = typeof init?.body === 'string' ? init.body : null
    if (body === null) return fetchImpl(input, init)
    const learned = wireParamMemo.get(dialect)
    if (learned) body = rewriteParams(body, learned) ?? body
    let res = await fetchImpl(input, { ...init, body })
    for (let attempt = 0; res.status === 400 && attempt < WIRE_PARAM_RETRIES; attempt++) {
      const param = unsupportedParam(await res.clone().text())
      if (param === null) return res
      const action = WIRE_PARAM_RENAMES[param] ?? null
      const rewritten = rewriteParams(body, { [param]: action })
      if (rewritten === null) return res
      wireParamMemo.set(dialect, { ...wireParamMemo.get(dialect), [param]: action })
      body = rewritten
      res = await fetchImpl(input, { ...init, body })
    }
    return res
  }
}

// Builds the OpenAI-compatible backend for one provider. A governed provider carries its own
// transport that routes through the Caracal gateway with a minted mandate; an ungoverned one
// uses the shared fetch. Either way the wire-parameter adapter wraps it so a model that rejects
// a standard parameter is retried in its accepted dialect. fetchImpl is injectable so the
// transport can be exercised without a live backend.
function buildBackend(fetchImpl: FetchImpl, provider: ProviderConfig) {
  return createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
    fetch: adaptWireParams(provider.transport ?? fetchImpl, `${provider.baseUrl}|${provider.model}`),
  })
}

// The chat model for free-text completions, wrapped so a reasoning model's chain of
// thought is captured however it is exposed: the OpenAI-compatible reasoning_content
// channel maps into reasoningText, and the middleware additionally extracts an inline
// <think>...</think> block. The Caracal governance middleware, when present, is applied
// first so the output-token ceiling holds before any provider call.
function buildReasoningModel(fetchImpl: FetchImpl, provider: ProviderConfig, governance?: LanguageModelMiddleware) {
  const reasoning = extractReasoningMiddleware({ tagName: 'think' })
  return wrapLanguageModel({
    model: buildBackend(fetchImpl, provider).chatModel(provider.model),
    middleware: governance ? [governance, reasoning] : reasoning,
  })
}

// The chat model for structured completions. It carries the Caracal governance middleware when
// present so the output-token ceiling holds on the object path too; structured output does not
// need reasoning extraction, so that middleware is not applied here.
function buildObjectModel(fetchImpl: FetchImpl, provider: ProviderConfig, governance?: LanguageModelMiddleware) {
  const model = buildBackend(fetchImpl, provider).chatModel(provider.model)
  return governance ? wrapLanguageModel({ model, middleware: governance }) : model
}

// The AI SDK takes system content through the system option rather than as a message
// role, so system messages are hoisted out and joined, and the rest are passed through.
function splitSystem(messages: GatewayMessage[]): { system?: string; conversation: GatewayMessage[] } {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  return {
    system: system.length > 0 ? system : undefined,
    conversation: messages.filter((message) => message.role !== 'system'),
  }
}

// Derives a failover reason from an error with no secret in it: the API key only
// ever lives in the request's authorization header, never in the SDK's error text,
// so the message and status are safe to surface.
function failureReason(err: unknown): string {
  if (APICallError.isInstance(err)) return `provider returned status ${err.statusCode ?? 'error'}`
  if (err instanceof Error) return err.message.length > 0 ? err.message : err.name
  return 'unknown error'
}

// Performs one free-text chat completion against a single provider through the AI SDK.
// Per-call retry is disabled so this gateway's own failover order owns retry semantics;
// network failures, non-2xx responses, timeouts, and empty completions all throw so the
// caller can fail over.
async function callProvider(
  fetchImpl: FetchImpl,
  provider: ProviderConfig,
  messages: GatewayMessage[],
  options: CompletionOptions,
  governance?: LanguageModelMiddleware,
): Promise<CompletionResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const { system, conversation } = splitSystem(messages)
    const result = await generateText({
      model: buildReasoningModel(fetchImpl, provider, governance),
      system,
      messages: conversation,
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: controller.signal,
      maxRetries: 0,
    })
    const text = result.text.trim()
    if (text.length === 0) throw new Error('provider returned an empty completion')
    const reasoning = result.reasoningText?.trim()
    return {
      text,
      reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
      provider: provider.id,
      model: provider.model,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// Performs one streaming free-text chat completion against a single provider. It emits each text
// and reasoning delta to the handlers as it arrives, then returns the same CompletionResult the
// non-streaming path would, so a caller gets a live preview and the authoritative final text from
// one call. Per-call retry is disabled so this gateway's own failover order owns retry semantics; a
// provider that fails before the first delta fails over cleanly, and an empty completion throws
// like the non-streaming path.
async function callProviderStream(
  fetchImpl: FetchImpl,
  provider: ProviderConfig,
  messages: GatewayMessage[],
  options: CompletionOptions,
  handlers: StreamHandlers,
  governance?: LanguageModelMiddleware,
): Promise<CompletionResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const { system, conversation } = splitSystem(messages)
    const result = streamText({
      model: buildReasoningModel(fetchImpl, provider, governance),
      system,
      messages: conversation,
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: controller.signal,
      maxRetries: 0,
      // Azure delivers a completion in a few coarse chunks, so every token of a chunk lands in one
      // burst and a short answer arrives all at once. Re-pace the text channel word by word so the
      // answer types out smoothly for the reader while reasoning parts pass through untouched.
      experimental_transform: smoothStream({ chunking: 'word' }),
    })
    // Read the full stream so both channels surface live: a text-delta is the answer typed out and
    // a reasoning-delta is the model's chain of thought as it works. Both the reasoning_content
    // channel and inline <think> blocks arrive here as reasoning-delta parts, so the caller can
    // show the thinking while the model reasons instead of waiting for the answer to begin.
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta' && part.text.length > 0) handlers.onText(part.text)
      else if (part.type === 'reasoning-delta' && part.text.length > 0) handlers.onReasoning?.(part.text)
    }
    const text = (await result.text).trim()
    if (text.length === 0) throw new Error('provider returned an empty completion')
    const reasoning = (await result.reasoningText)?.trim()
    const usage = await result.usage
    return {
      text,
      reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
      provider: provider.id,
      model: provider.model,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// Performs one schema-validated structured completion against a single provider. The
// model is asked for JSON and its answer is validated against the schema by the AI SDK,
// so a malformed or off-schema response throws and the caller fails over rather than
// acting on an unvalidated object. JSON-object mode is portable across hosted and local
// OpenAI-compatible backends, so it does not require provider-side schema support.
async function callProviderObject<T>(
  fetchImpl: FetchImpl,
  provider: ProviderConfig,
  messages: GatewayMessage[],
  schema: ZodType<T>,
  options: CompletionOptions,
  governance?: LanguageModelMiddleware,
): Promise<CompletionObjectResult<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const { system, conversation } = splitSystem(messages)
    const result = await generateObject({
      model: buildObjectModel(fetchImpl, provider, governance),
      schema,
      system,
      messages: conversation,
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: controller.signal,
      maxRetries: 0,
    })
    return {
      value: result.object,
      provider: provider.id,
      model: provider.model,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export interface Gateway {
  status(): GatewayStatus
  active(): ActiveModel | null
  complete(messages: GatewayMessage[], options?: CompletionOptions): Promise<CompletionResult>
  completeObject<T>(messages: GatewayMessage[], schema: ZodType<T>, options?: CompletionOptions): Promise<CompletionObjectResult<T>>
  // A free-text completion that emits each text and reasoning delta to the handlers as it arrives
  // and returns the same final CompletionResult as complete(). The deltas are a live preview; the
  // returned result is authoritative. Used by the streaming answer path so the console renders an
  // answer, and the model's thinking, as they are produced rather than all at once.
  stream(messages: GatewayMessage[], handlers: StreamHandlers, options?: CompletionOptions): Promise<CompletionResult>
}

// Runs a per-provider call through the failover order and returns the first success.
// The caller's preferred provider, when available, is tried ahead of the rest; a
// preference for an unknown or unavailable provider is ignored so a stale preference
// never disables the gateway. Every provider failing throws a GatewayError carrying the
// redacted per-provider reasons.
async function runWithFailover<T>(
  available: ProviderConfig[],
  preferredProvider: string | undefined,
  call: (provider: ProviderConfig) => Promise<T>,
): Promise<T> {
  if (available.length === 0) throw new GatewayUnavailableError()
  const order = [...available]
  if (preferredProvider) {
    const index = order.findIndex((provider) => provider.id === preferredProvider)
    if (index > 0) {
      const [preferred] = order.splice(index, 1)
      order.unshift(preferred)
    }
  }
  const attempts: { provider: string; reason: string }[] = []
  for (const provider of order) {
    try {
      return await call(provider)
    } catch (err) {
      attempts.push({ provider: provider.id, reason: failureReason(err) })
    }
  }
  throw new GatewayError(attempts)
}

// Builds a gateway over an ordered provider list. The order is the failover order:
// each completion tries every available provider in turn and returns the first success.
// fetchImpl is injectable so the transport can be exercised without a live backend. When
// governance limits are supplied with a positive output ceiling, every model call carries the
// Caracal governance middleware so the ceiling holds uniformly across providers.
export function createGateway(providers: ProviderConfig[], fetchImpl: FetchImpl = fetch, governance?: GovernanceLimits): Gateway {
  const available = providers.filter(providerAvailable)
  const governanceMiddleware = governance && governance.maxOutputTokens > 0 ? buildGovernanceMiddleware(governance) : undefined

  return {
    status() {
      return {
        enabled: available.length > 0,
        providers: providers.map((provider) => ({
          id: provider.id,
          model: provider.model,
          available: providerAvailable(provider),
          contextWindow: provider.contextWindow,
        })),
      }
    },

    active() {
      const provider = available[0]
      return provider ? { model: provider.model, contextWindow: provider.contextWindow } : null
    },

    complete(messages, options = {}) {
      return runWithFailover(available, options.preferredProvider, (provider) =>
        callProvider(fetchImpl, provider, messages, options, governanceMiddleware),
      )
    },

    completeObject(messages, schema, options = {}) {
      return runWithFailover(available, options.preferredProvider, (provider) =>
        callProviderObject(fetchImpl, provider, messages, schema, options, governanceMiddleware),
      )
    },

    stream(messages, handlers, options = {}) {
      return runWithFailover(available, options.preferredProvider, (provider) =>
        callProviderStream(fetchImpl, provider, messages, options, handlers, governanceMiddleware),
      )
    },
  }
}

// Wraps a gateway for the span of a single request so the real token usage of every
// completion made through it is tallied. The underlying gateway is shared across
// requests, so usage must be collected per call here rather than held on the gateway.
// When maxCalls is set, it also enforces the per-turn model-call budget: each model call
// counts, and a call beyond the budget is refused with a GatewayBudgetError before it reaches a
// provider, so the multi-agent composition for one message can never run an unbounded loop. A
// failover across providers is a single logical call, so the budget bounds agent steps, not
// provider retries.
export function withUsage(gateway: Gateway, options: { maxCalls?: number } = {}): { gateway: Gateway; usage: () => GatewayUsage } {
  let inputTokens = 0
  let outputTokens = 0
  let calls = 0
  let lastProvider: string | null = null
  let lastModel: string | null = null
  const servedProviders: string[] = []
  const maxCalls = options.maxCalls
  const guard = () => {
    if (maxCalls !== undefined && maxCalls > 0 && calls >= maxCalls) throw new GatewayBudgetError(maxCalls)
    calls += 1
  }
  const record = (provider: string, model: string, promptTokens?: number, completionTokens?: number) => {
    inputTokens += promptTokens ?? 0
    outputTokens += completionTokens ?? 0
    lastProvider = provider
    lastModel = model
    if (!servedProviders.includes(provider)) servedProviders.push(provider)
  }
  const tracked: Gateway = {
    status: () => gateway.status(),
    active: () => gateway.active(),
    async complete(messages, options) {
      guard()
      const result = await gateway.complete(messages, options)
      record(result.provider, result.model, result.promptTokens, result.completionTokens)
      return result
    },
    async completeObject(messages, schema, options) {
      guard()
      const result = await gateway.completeObject(messages, schema, options)
      record(result.provider, result.model, result.promptTokens, result.completionTokens)
      return result
    },
    async stream(messages, handlers, options) {
      guard()
      const result = await gateway.stream(messages, handlers, options)
      record(result.provider, result.model, result.promptTokens, result.completionTokens)
      return result
    },
  }
  return {
    gateway: tracked,
    usage: () => ({ inputTokens, outputTokens, provider: lastProvider, model: lastModel, providers: [...servedProviders] }),
  }
}

// Wraps a gateway so every completion prefers the given provider, without touching the
// agents that call it. A null id is a no-op, so callers can wrap unconditionally.
export function preferProvider(gateway: Gateway, providerId: string | null): Gateway {
  if (!providerId) return gateway
  return {
    status: () => gateway.status(),
    active: () => gateway.active(),
    complete: (messages, options = {}) => gateway.complete(messages, { ...options, preferredProvider: providerId }),
    completeObject: (messages, schema, options = {}) =>
      gateway.completeObject(messages, schema, { ...options, preferredProvider: providerId }),
    stream: (messages, handlers, options = {}) => gateway.stream(messages, handlers, { ...options, preferredProvider: providerId }),
  }
}

// Wraps a gateway so a free-text completion streams its answer tokens to onText and its reasoning
// tokens to onReasoning as they arrive while still returning the same final CompletionResult. Only
// complete() streams; completeObject() and the rest pass through unchanged, so a turn's structured
// calls (triage, critique, grounding) are untouched. The deltas are a fire-and-forget live
// preview: the caller's authoritative result is the same whether or not anyone listens, mirroring
// how deliberation stages stream.
export function streamingAnswers(gateway: Gateway, onText: (chunk: string) => void, onReasoning?: (chunk: string) => void): Gateway {
  const handlers: StreamHandlers = { onText, onReasoning }
  return {
    status: () => gateway.status(),
    active: () => gateway.active(),
    complete: (messages, options = {}) => gateway.stream(messages, handlers, options),
    completeObject: (messages, schema, options = {}) => gateway.completeObject(messages, schema, options),
    stream: (messages, streamHandlers, options = {}) => gateway.stream(messages, streamHandlers, options),
  }
}
