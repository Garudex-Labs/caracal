/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file mirrors control-plane field constraints so the web surfaces validation before submit.
*/
const ZONE_SLUG_PATTERN = /^[a-z0-9-]+$/;

// Mirrors apps/api/src/routes/resources.ts validateResourceIdentifier: an absolute audience
// URI that is not in the provider:// namespace and carries no credentials.
export function validateResourceIdentifier(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Identifier must be an absolute URI (e.g. resource://pipernet).";
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
