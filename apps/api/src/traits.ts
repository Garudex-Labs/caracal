// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Server-side validation for application traits to prevent privilege escalation through unrestricted strings.

import {
  CONTROL_EXPIRES_TRAIT_PREFIX,
  CONTROL_INVOKE_TRAIT,
  CONTROL_MAX_TTL_TRAIT_PREFIX,
  CONTROL_SCOPE_TRAIT_PREFIX,
  controlScopes,
} from '@caracalai/engine'

import type { Actor } from './auth.js'

const TRAIT_MAX_COUNT = 64
const TRAIT_MAX_LENGTH = 128
const TRAIT_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/
const PRIVILEGED_NAMESPACES = ['control', 'caracal.sys'] as const
const CONTROL_MIN_TTL_SECONDS = 60
const CONTROL_MAX_TTL_SECONDS = 900

export interface TraitError {
  error: string
  error_description: string
}

let controlScopeCatalog: Set<string> | undefined

function knownControlScopes(): Set<string> {
  controlScopeCatalog ??= new Set(controlScopes())
  return controlScopeCatalog
}

// Validates the semantics of one control-namespace trait so the stored record is exactly
// what STS and dispatch will enforce: scopes must exist in the Control catalog, the TTL cap
// must be a bounded integer, and the expiry must parse - an unparseable expiry would be
// treated as no expiry at token exchange, silently outliving the operator's intent.
function validateControlTrait(trait: string): string | null {
  if (trait === CONTROL_INVOKE_TRAIT) return null
  if (trait.startsWith(CONTROL_SCOPE_TRAIT_PREFIX)) {
    const scope = trait.slice(CONTROL_SCOPE_TRAIT_PREFIX.length)
    return knownControlScopes().has(scope) ? null : `unknown control scope '${scope}'`
  }
  if (trait.startsWith(CONTROL_MAX_TTL_TRAIT_PREFIX)) {
    const raw = trait.slice(CONTROL_MAX_TTL_TRAIT_PREFIX.length)
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < CONTROL_MIN_TTL_SECONDS || value > CONTROL_MAX_TTL_SECONDS) {
      return `control max TTL must be an integer between ${CONTROL_MIN_TTL_SECONDS} and ${CONTROL_MAX_TTL_SECONDS} seconds`
    }
    return null
  }
  if (trait.startsWith(CONTROL_EXPIRES_TRAIT_PREFIX)) {
    const value = trait.slice(CONTROL_EXPIRES_TRAIT_PREFIX.length)
    return Number.isFinite(Date.parse(value)) ? null : `control expiry '${value}' is not a parseable timestamp`
  }
  return `unknown control trait '${trait}'`
}

export function validateTraits(traits: readonly string[] | undefined, actor: Actor): TraitError | null {
  if (traits === undefined) return null
  if (traits.length > TRAIT_MAX_COUNT) {
    return { error: 'trait_count_exceeded', error_description: `at most ${TRAIT_MAX_COUNT} traits allowed` }
  }
  const seen = new Set<string>()
  let maxTtlCount = 0
  let expiresCount = 0
  for (const trait of traits) {
    if (typeof trait !== 'string' || trait.length === 0 || trait.length > TRAIT_MAX_LENGTH) {
      return { error: 'trait_invalid', error_description: `traits must be 1..${TRAIT_MAX_LENGTH} chars` }
    }
    if (!TRAIT_PATTERN.test(trait)) {
      return { error: 'trait_invalid', error_description: `trait '${trait}' violates [A-Za-z][A-Za-z0-9._:-]* format` }
    }
    if (seen.has(trait)) {
      return { error: 'trait_duplicate', error_description: `duplicate trait '${trait}'` }
    }
    seen.add(trait)
    const namespace = trait.split(':', 1)[0]!
    if (PRIVILEGED_NAMESPACES.includes(namespace as (typeof PRIVILEGED_NAMESPACES)[number]) && actor.scope !== 'global') {
      return { error: 'trait_forbidden', error_description: `trait namespace '${namespace}' requires global admin scope` }
    }
    if (namespace === 'control') {
      const reason = validateControlTrait(trait)
      if (reason) return { error: 'trait_invalid', error_description: reason }
      if (trait.startsWith(CONTROL_MAX_TTL_TRAIT_PREFIX) && ++maxTtlCount > 1) {
        return { error: 'trait_invalid', error_description: 'at most one control max TTL trait allowed' }
      }
      if (trait.startsWith(CONTROL_EXPIRES_TRAIT_PREFIX) && ++expiresCount > 1) {
        return { error: 'trait_invalid', error_description: 'at most one control expiry trait allowed' }
      }
    }
  }
  return null
}
