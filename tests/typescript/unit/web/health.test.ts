// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for platform-health collapsing and diagnostic severity ranking shown in the navbar.

import { describe, expect, it } from "vitest";

import {
  diagnosticSeverityRank,
  platformHealthOf,
} from "../../../../apps/web/src/platform/api/hooks.ts";
import type { DiagnosticsReport } from "../../../../apps/web/src/platform/api/types.ts";

function report(summary: { ok: number; warn: number; fail: number }): DiagnosticsReport {
  return {
    command: "doctor",
    mode: "system",
    ready: summary.fail === 0,
    strict: false,
    context: { apiUrl: "http://localhost:3000", zoneScope: "all", zoneIds: [] },
    summary: { ...summary, total: summary.ok + summary.warn + summary.fail },
    checks: [],
    generatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("platformHealthOf", () => {
  it("reports unknown while the report is still loading", () => {
    expect(platformHealthOf(undefined)).toBe("unknown");
  });

  it("reports healthy when nothing is failing or warning", () => {
    expect(platformHealthOf(report({ ok: 5, warn: 0, fail: 0 }))).toBe("healthy");
  });

  it("reports attention when only warnings are present", () => {
    expect(platformHealthOf(report({ ok: 4, warn: 1, fail: 0 }))).toBe("attention");
  });

  it("reports unhealthy when any check fails, even alongside warnings", () => {
    expect(platformHealthOf(report({ ok: 1, warn: 2, fail: 1 }))).toBe("unhealthy");
  });

  it("treats an all-zero summary as healthy", () => {
    expect(platformHealthOf(report({ ok: 0, warn: 0, fail: 0 }))).toBe("healthy");
  });
});

describe("diagnosticSeverityRank", () => {
  it("sorts failures above warnings above healthy checks", () => {
    expect(diagnosticSeverityRank("fail")).toBeLessThan(diagnosticSeverityRank("warn"));
    expect(diagnosticSeverityRank("warn")).toBeLessThan(diagnosticSeverityRank("ok"));
  });

  it("orders a mixed list failures-first", () => {
    const sorted = (["ok", "fail", "warn", "ok"] as const)
      .slice()
      .sort((a, b) => diagnosticSeverityRank(a) - diagnosticSeverityRank(b));
    expect(sorted).toEqual(["fail", "warn", "ok", "ok"]);
  });
});
