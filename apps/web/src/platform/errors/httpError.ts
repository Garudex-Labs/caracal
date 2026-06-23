/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file maps runtime and HTTP errors to full-page error codes the web client can render.
*/
import { redirect } from "@tanstack/react-router";

import { ERROR_CATALOG, FALLBACK_ERROR_CODE } from "./catalog";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

function readStatus(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const candidate = record.status ?? record.statusCode ?? record.code;
  if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  if (typeof candidate === "string" && /^[0-9]{3}$/.test(candidate)) return Number(candidate);
  return null;
}

/** Resolve any thrown value to a status code the catalog can render, defaulting to 500. */
export function errorToStatus(value: unknown): number {
  if (isHttpError(value)) return value.status;
  const status = readStatus(value);
  if (status && ERROR_CATALOG[status]) return status;
  if (status && status >= 400 && status <= 599) return status;
  return FALLBACK_ERROR_CODE;
}

/** Throw a router redirect to the full-size error page for the given status. */
export function redirectToError(status: number): never {
  throw redirect({ to: "/error/$code", params: { code: String(status) } });
}
