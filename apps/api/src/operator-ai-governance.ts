// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal-set governance for every Operator model call: a provider middleware that caps output tokens uniformly and a per-turn model-call budget that bounds the agentic fan-out.

import type { LanguageModelMiddleware } from 'ai'

// The deployment-set limits Caracal enforces over the Operator's model usage, independent of which
// agent makes a call. maxOutputTokens is a hard ceiling on a single completion's output, clamping
// any larger request so no agent - present or future - can ask for an unbounded generation.
// maxCallsPerTurn bounds how many model calls a single message turn may make, so the multi-agent
// composition can never run an unbounded loop. Either limit at zero disables that bound.
export interface GovernanceLimits {
  maxOutputTokens: number
  maxCallsPerTurn: number
}

// The least-privilege default: a high output ceiling that clamps only a pathological request (every
// Operator agent asks for far less) and a per-turn call budget well above any real turn (the
// largest today is triage plus a planner plus a security review), so the defaults bound runaways
// without affecting normal operation. A deployment can tighten either through configuration.
export function defaultGovernanceLimits(): GovernanceLimits {
  return { maxOutputTokens: 4096, maxCallsPerTurn: 12 }
}

// Resolves the governance limits from configuration, clamping each to a safe non-negative integer.
// A value of zero is preserved as "disable this bound" so a deployment can intentionally lift one.
export function buildGovernanceLimits(input: Partial<GovernanceLimits> = {}): GovernanceLimits {
  const fallback = defaultGovernanceLimits()
  const clamp = (value: number | undefined, dflt: number) => (value === undefined ? dflt : Math.max(0, Math.trunc(value)))
  return {
    maxOutputTokens: clamp(input.maxOutputTokens, fallback.maxOutputTokens),
    maxCallsPerTurn: clamp(input.maxCallsPerTurn, fallback.maxCallsPerTurn),
  }
}

// The provider middleware that enforces the output-token ceiling on every model call. It transforms
// the call parameters before they reach the provider, clamping maxOutputTokens down to the ceiling
// (and setting it when a call left it open), so the bound holds uniformly across hosted and local
// backends regardless of which agent issued the call. A ceiling of zero leaves the parameters
// untouched. This is provider governance, not authority: it bounds cost and runaway generation; the
// single write path, validation, preview, and approval are unchanged.
export function buildGovernanceMiddleware(limits: GovernanceLimits): LanguageModelMiddleware {
  return {
    transformParams: async ({ params }) => {
      if (limits.maxOutputTokens <= 0) return params
      const requested = params.maxOutputTokens
      const capped = requested === undefined ? limits.maxOutputTokens : Math.min(requested, limits.maxOutputTokens)
      return { ...params, maxOutputTokens: capped }
    },
  }
}
