// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The Operator LLM gateway: a provider-agnostic completion client built on the Vercel AI SDK over any OpenAI-compatible endpoint with multi-provider failover.

import { APICallError, extractReasoningMiddleware, generateObject, generateText, wrapLanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ZodType } from 'zod'

// A single configured backend. The OpenAI-compatible chat surface is the common
// denominator across hosted providers (OpenAI, Together, Groq), local servers
// (Ollama, vLLM), and gateways (LiteLLM), so one client reaches all of them. In
// production the recommended backend is a LiteLLM proxy, which owns per-provider
// integration, BYOK, and key budgets so Caracal never maintains provider SDKs. A
// missing apiKey is valid for local backends that need no credential.
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
  // assert reachability — that is what the connectivity check verifies — and never
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
// during a single request, so it never mixes usage across conversations.
export interface GatewayUsage {
  inputTokens: number
  outputTokens: number
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
  const globals = globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: WarningLogger | false
    caracalWarningFilterInstalled?: boolean
  }
  if (globals.caracalWarningFilterInstalled) return
  const previous = typeof globals.AI_SDK_LOG_WARNINGS === 'function' ? globals.AI_SDK_LOG_WARNINGS : null
  globals.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
    const kept = warnings.filter((warning) => !(warning.type === 'unsupported' && warning.feature === 'responseFormat'))
    if (kept.length === 0) return
    if (previous) previous({ warnings: kept, provider, model })
    else console.warn('AI SDK Warning', { provider, model, warnings: kept })
  }
  globals.caracalWarningFilterInstalled = true
}

installStructuredOutputWarningFilter()

function providerAvailable(provider: ProviderConfig): boolean {
  return provider.baseUrl.length > 0 && provider.model.length > 0
}

// Builds the OpenAI-compatible backend for one provider. fetchImpl is injectable so the
// transport can be exercised without a live backend. In production the recommended
// backend is a LiteLLM proxy that fronts every provider behind this one wire format.
function buildBackend(fetchImpl: FetchImpl, provider: ProviderConfig) {
  return createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
    fetch: fetchImpl,
  })
}

// The chat model for free-text completions, wrapped so a reasoning model's chain of
// thought is captured however it is exposed: the OpenAI-compatible reasoning_content
// channel maps into reasoningText, and the middleware additionally extracts an inline
// <think>...</think> block.
function buildReasoningModel(fetchImpl: FetchImpl, provider: ProviderConfig) {
  return wrapLanguageModel({
    model: buildBackend(fetchImpl, provider).chatModel(provider.model),
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  })
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
): Promise<CompletionResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const { system, conversation } = splitSystem(messages)
    const result = await generateText({
      model: buildReasoningModel(fetchImpl, provider),
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
): Promise<CompletionObjectResult<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs)
  try {
    const { system, conversation } = splitSystem(messages)
    const result = await generateObject({
      model: buildBackend(fetchImpl, provider).chatModel(provider.model),
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
// fetchImpl is injectable so the transport can be exercised without a live backend.
export function createGateway(providers: ProviderConfig[], fetchImpl: FetchImpl = fetch): Gateway {
  const available = providers.filter(providerAvailable)

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
      return runWithFailover(available, options.preferredProvider, (provider) => callProvider(fetchImpl, provider, messages, options))
    },

    completeObject(messages, schema, options = {}) {
      return runWithFailover(available, options.preferredProvider, (provider) =>
        callProviderObject(fetchImpl, provider, messages, schema, options),
      )
    },
  }
}

// Wraps a gateway for the span of a single request so the real token usage of every
// completion made through it is tallied. The underlying gateway is shared across
// requests, so usage must be collected per call here rather than held on the gateway.
export function withUsage(gateway: Gateway): { gateway: Gateway; usage: () => GatewayUsage } {
  let inputTokens = 0
  let outputTokens = 0
  const tracked: Gateway = {
    status: () => gateway.status(),
    active: () => gateway.active(),
    async complete(messages, options) {
      const result = await gateway.complete(messages, options)
      inputTokens += result.promptTokens ?? 0
      outputTokens += result.completionTokens ?? 0
      return result
    },
    async completeObject(messages, schema, options) {
      const result = await gateway.completeObject(messages, schema, options)
      inputTokens += result.promptTokens ?? 0
      outputTokens += result.completionTokens ?? 0
      return result
    },
  }
  return { gateway: tracked, usage: () => ({ inputTokens, outputTokens }) }
}

// Wraps a gateway so every completion prefers the given provider, without touching the
// agents that call it. A null id is a no-op, so callers can wrap unconditionally.
export function preferProvider(gateway: Gateway, providerId: string | null): Gateway {
  if (!providerId) return gateway
  return {
    status: () => gateway.status(),
    active: () => gateway.active(),
    complete: (messages, options = {}) => gateway.complete(messages, { ...options, preferredProvider: providerId }),
    completeObject: (messages, schema, options = {}) => gateway.completeObject(messages, schema, { ...options, preferredProvider: providerId }),
  }
}
