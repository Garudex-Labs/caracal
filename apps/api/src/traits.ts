// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Server-side validation for application traits to prevent privilege escalation through unrestricted strings.

import type { Actor } from './auth.js'

const TRAIT_MAX_COUNT = 32
const TRAIT_MAX_LENGTH = 128
const TRAIT_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/
const PRIVILEGED_NAMESPACES = ['control'] as const

export interface TraitError {
  error: string
  detail: string
}

export function validateTraits(traits: readonly string[] | undefined, actor: Actor): TraitError | null {
  if (traits === undefined) return null
  if (traits.length > TRAIT_MAX_COUNT) {
    return { error: 'trait_count_exceeded', detail: `at most ${TRAIT_MAX_COUNT} traits allowed` }
  }
  const seen = new Set<string>()
  for (const trait of traits) {
    if (typeof trait !== 'string' || trait.length === 0 || trait.length > TRAIT_MAX_LENGTH) {
      return { error: 'trait_invalid', detail: `traits must be 1..${TRAIT_MAX_LENGTH} chars` }
    }
    if (!TRAIT_PATTERN.test(trait)) {
      return { error: 'trait_invalid', detail: `trait '${trait}' violates [A-Za-z][A-Za-z0-9._:-]* format` }
    }
    if (seen.has(trait)) {
      return { error: 'trait_duplicate', detail: `duplicate trait '${trait}'` }
    }
    seen.add(trait)
    const namespace = trait.split(':', 1)[0]!
    if (PRIVILEGED_NAMESPACES.includes(namespace as typeof PRIVILEGED_NAMESPACES[number]) && actor.scope !== 'global') {
      return { error: 'trait_forbidden', detail: `trait namespace '${namespace}' requires global admin scope` }
    }
  }
  return null
}
