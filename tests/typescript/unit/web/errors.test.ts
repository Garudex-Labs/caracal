// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the full-page error taxonomy: status resolution and catalog content.

import { describe, expect, it } from "vitest";

import {
  ERROR_CATALOG,
  FALLBACK_ERROR_CODE,
  errorEntry,
} from "../../../../apps/web/src/platform/errors/catalog.ts";
import {
  HttpError,
  errorToStatus,
  isHttpError,
} from "../../../../apps/web/src/platform/errors/httpError.ts";

describe("HttpError", () => {
  it("carries a status and a default message", () => {
    const err = new HttpError(404);
    expect(err.status).toBe(404);
    expect(err.message).toBe("HTTP 404");
    expect(err.name).toBe("HttpError");
  });

  it("is recognized by the type guard and not confused with plain errors", () => {
    expect(isHttpError(new HttpError(500))).toBe(true);
    expect(isHttpError(new Error("nope"))).toBe(false);
    expect(isHttpError({ status: 500 })).toBe(false);
    expect(isHttpError(null)).toBe(false);
  });
});

describe("errorToStatus", () => {
  it("uses the HttpError status directly", () => {
    expect(errorToStatus(new HttpError(403))).toBe(403);
  });

  it("reads a numeric status/statusCode/code field from a thrown object", () => {
    expect(errorToStatus({ status: 401 })).toBe(401);
    expect(errorToStatus({ statusCode: 409 })).toBe(409);
    expect(errorToStatus({ code: 503 })).toBe(503);
  });

  it("parses a 3-digit string status", () => {
    expect(errorToStatus({ status: "429" })).toBe(429);
  });

  it("passes through any 4xx/5xx even when not in the catalog", () => {
    expect(errorToStatus({ status: 418 })).toBe(418);
  });

  it("falls back to 500 for non-HTTP, out-of-range, or unparseable values", () => {
    expect(errorToStatus(new Error("network"))).toBe(FALLBACK_ERROR_CODE);
    expect(errorToStatus({ status: 200 })).toBe(FALLBACK_ERROR_CODE);
    expect(errorToStatus({ status: "abc" })).toBe(FALLBACK_ERROR_CODE);
    expect(errorToStatus(undefined)).toBe(FALLBACK_ERROR_CODE);
    expect(errorToStatus("boom")).toBe(FALLBACK_ERROR_CODE);
  });
});

describe("error catalog", () => {
  it("maps every cataloged code to a complete entry", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.title, `title for ${code}`).toBeTruthy();
      expect(entry.description, `description for ${code}`).toBeTruthy();
      expect(entry.actions.length, `actions for ${code}`).toBeGreaterThan(0);
    }
  });

  it("offers sign-in on 401 and dashboard on 403 (authz-aware recovery)", () => {
    expect(errorEntry(401).actions).toContain("signin");
    expect(errorEntry(403).actions).toContain("dashboard");
  });

  it("offers retry on transient upstream failures", () => {
    for (const code of [429, 500, 502, 503, 504]) {
      expect(errorEntry(code).actions, `retry for ${code}`).toContain("retry");
    }
  });

  it("falls back to the 500 entry for an unknown code", () => {
    expect(errorEntry(799)).toBe(ERROR_CATALOG[FALLBACK_ERROR_CODE]);
  });
});
