/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides client-side provider configuration validation at parity with the control plane.
*/
import type { ProviderKind } from "@/platform/api/types";

// These patterns and rules mirror the control-plane validators (apps/api provider routes
// and the Console doctor). Enforcing them in the browser gives operators immediate,
// field-level feedback instead of a round-trip error, and keeps the web at parity with the
// TUI rather than laxer than the backend it submits to.
const PROVIDER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROVIDER_IDENTIFIER_PREFIX = "provider://";
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const AUTH_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const OAUTH_PARAM_PATTERN = /^[A-Za-z0-9._~-]+$/;
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export const RESERVED_AUTHORIZATION_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
]);
export const RESERVED_TOKEN_PARAMS = new Set([
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
  "code",
  "code_verifier",
  "grant_type",
  "redirect_uri",
  "refresh_token",
  "scope",
]);

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isAbsoluteUri(value: string): boolean {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

export function isHeaderName(value: string): boolean {
  return HEADER_TOKEN_PATTERN.test(value);
}

export function isAuthScheme(value: string): boolean {
  return AUTH_SCHEME_PATTERN.test(value);
}

export function isQueryParamName(value: string): boolean {
  return OAUTH_PARAM_PATTERN.test(value);
}

export function isHost(value: string): boolean {
  return HOST_PATTERN.test(value);
}

export interface ParsedParams {
  value: Record<string, string>;
  error?: string;
}

// Advanced OAuth parameter fields are entered as `key=value` pairs (comma-separated) and the
// control plane stores them as a string record. Parse, validate, and reject reserved keys so
// the browser never sends a shape the backend would refuse.
export function parseParams(raw: string, reserved: ReadonlySet<string>): ParsedParams {
  const value: Record<string, string> = {};
  const entries = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) return { value, error: "Use key=value pairs separated by commas." };
    const key = entry.slice(0, eq).trim();
    const val = entry.slice(eq + 1).trim();
    if (!OAUTH_PARAM_PATTERN.test(key)) return { value, error: `Invalid parameter name "${key}".` };
    if (reserved.has(key)) return { value, error: `"${key}" is a reserved OAuth parameter.` };
    if (val === "") return { value, error: `Parameter "${key}" needs a value.` };
    value[key] = val;
  }
  return { value };
}

export function serializeParams(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

export function reservedParamsFor(key: string): ReadonlySet<string> {
  return key === "authorization_params" ? RESERVED_AUTHORIZATION_PARAMS : RESERVED_TOKEN_PARAMS;
}

// Format validation for a single configuration field, keyed by the field name so the rules
// match the control plane regardless of how the form lays the field out.
export function validateFieldFormat(key: string, raw: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  switch (key) {
    case "authorization_endpoint":
    case "token_endpoint":
      return isHttpsUrl(value) ? undefined : "Must be an HTTPS URL.";
    case "redirect_uri":
      return isAbsoluteUri(value) ? undefined : "Must be an absolute URI.";
    case "header_name":
    case "auth_header":
      return isHeaderName(value) ? undefined : "Must be a valid HTTP header name.";
    case "query_param_name":
      return isQueryParamName(value) ? undefined : "Must be a valid query parameter name.";
    case "auth_scheme":
      return isAuthScheme(value) ? undefined : "Must start with a letter (e.g. Bearer).";
    case "allowed_token_hosts": {
      const hosts = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const bad = hosts.find((host) => !isHost(host));
      return bad ? `"${bad}" is not a valid hostname.` : undefined;
    }
    case "authorization_params":
    case "token_params":
      return parseParams(value, reservedParamsFor(key)).error;
    default:
      return undefined;
  }
}

export interface CrossFieldIssue {
  key?: string;
  message: string;
}

// Cross-field credential rules that the control plane enforces. Surfacing them in the form
// stops invalid combinations (e.g. a client secret alongside private_key_jwt) before submit.
export function crossFieldIssues(
  kind: ProviderKind,
  values: Record<string, string>,
): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  if (kind === "oauth2_authorization_code" || kind === "oauth2_client_credentials") {
    const method = (values.client_auth_method || "client_secret_basic").trim();
    const hasSecret = (values.client_secret ?? "").trim() !== "";
    const hasPrivateKey = (values.private_key ?? "").trim() !== "";

    if (kind === "oauth2_authorization_code" && method === "private_key_jwt") {
      issues.push({
        key: "client_auth_method",
        message: "private_key_jwt is not supported for authorization code providers.",
      });
    }
    if (method === "private_key_jwt") {
      if (hasSecret) {
        issues.push({
          key: "client_secret",
          message: "Remove the client secret when using private_key_jwt.",
        });
      }
    } else {
      if (hasPrivateKey) {
        issues.push({
          key: "private_key",
          message: "A private key requires the private_key_jwt method.",
        });
      }
      if ((values.key_id ?? "").trim() !== "") {
        issues.push({
          key: "key_id",
          message: "Key ID requires the private_key_jwt method.",
        });
      }
    }
  }
  if (kind === "api_key") {
    const location = (values.auth_location || "header").trim();
    if (location === "query" && (values.auth_scheme ?? "").trim() !== "") {
      issues.push({
        key: "auth_scheme",
        message: "Authorization scheme applies only to header keys.",
      });
    }
  }
  return issues;
}

// Validates the slug the operator types after the locked provider:// prefix; the form owns
// the prefix, so the value here never carries it.
export function validateIdentifier(value: string): string | undefined {
  const text = value.trim();
  if (!text || PROVIDER_SLUG_PATTERN.test(text)) return undefined;
  return "Use lowercase letters, numbers, and hyphens (e.g. hooli-oidc).";
}

// Accepts pasted full identifiers gracefully: the locked prefix is removed so the slug field
// never displays a doubled namespace.
export function stripIdentifierPrefix(value: string): string {
  return value.startsWith(PROVIDER_IDENTIFIER_PREFIX)
    ? value.slice(PROVIDER_IDENTIFIER_PREFIX.length)
    : value;
}
