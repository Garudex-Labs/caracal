/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file mirrors control-plane field constraints so the web surfaces validation before submit.
*/
const TRAIT_MAX_COUNT = 32;
const TRAIT_MAX_LENGTH = 128;
const TRAIT_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const PRIVILEGED_TRAIT_NAMESPACES = ["control"];
const ZONE_SLUG_PATTERN = /^[a-z0-9-]+$/;

export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Mirrors apps/api/src/traits.ts. Returns an error string when the comma-separated traits
// violate count, length, format, uniqueness, or privileged-namespace rules.
export function validateTraits(traits: string[]): string | undefined {
  if (traits.length > TRAIT_MAX_COUNT) {
    return `At most ${TRAIT_MAX_COUNT} traits allowed.`;
  }
  const seen = new Set<string>();
  for (const trait of traits) {
    if (trait.length > TRAIT_MAX_LENGTH) {
      return `Traits must be 1–${TRAIT_MAX_LENGTH} characters.`;
    }
    if (!TRAIT_PATTERN.test(trait)) {
      return `Trait "${trait}" must match [A-Za-z][A-Za-z0-9._:-]*.`;
    }
    if (seen.has(trait)) {
      return `Duplicate trait "${trait}".`;
    }
    seen.add(trait);
  }
  return undefined;
}

// Flags privileged trait namespaces that the control plane only accepts from global-scope
// admins, so operators see the constraint before a 403 instead of after.
export function privilegedTraits(traits: string[]): string[] {
  return traits.filter((trait) =>
    PRIVILEGED_TRAIT_NAMESPACES.includes(trait.split(":", 1)[0] ?? ""),
  );
}

// Mirrors apps/api/src/routes/resources.ts validateResourceIdentifier: an absolute audience
// URI that is not in the provider:// namespace and carries no credentials.
export function validateResourceIdentifier(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Identifier must be an absolute URI (e.g. resource://payments-api).";
  }
  if (url.protocol === "provider:") {
    return "Resource identifiers cannot use the provider:// namespace.";
  }
  if (url.username || url.password) {
    return "Identifier must not embed credentials.";
  }
  return undefined;
}

export function validateZoneSlug(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!ZONE_SLUG_PATTERN.test(text)) {
    return "Slug may only contain lowercase letters, numbers, and hyphens.";
  }
  return undefined;
}
