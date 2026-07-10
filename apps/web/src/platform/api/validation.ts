/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file mirrors control-plane field constraints so the web surfaces validation before submit.
*/
const ZONE_SLUG_PATTERN = /^[a-z0-9-]+$/;
const RESOURCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESOURCE_IDENTIFIER_PREFIX = "resource://";

// Validates the slug typed after the locked resource:// prefix; the form owns the prefix,
// so the value here never carries it.
export function validateResourceIdentifier(value: string): string | undefined {
  const text = value.trim();
  if (!text || RESOURCE_SLUG_PATTERN.test(text)) return undefined;
  return "Use lowercase letters, numbers, and hyphens (e.g. pipernet).";
}

// Accepts pasted full identifiers gracefully: the locked prefix is removed so the slug field
// never displays a doubled namespace.
export function stripResourceIdentifierPrefix(value: string): string {
  return value.startsWith(RESOURCE_IDENTIFIER_PREFIX)
    ? value.slice(RESOURCE_IDENTIFIER_PREFIX.length)
    : value;
}

export function validateZoneSlug(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!ZONE_SLUG_PATTERN.test(text)) {
    return "Slug may only contain lowercase letters, numbers, and hyphens.";
  }
  return undefined;
}
