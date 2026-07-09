/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Presentation model mapping raw doctor checks onto platform components, zone health, severities, and remediation.
*/
import type { DiagnosticCheck, DiagnosticsReport } from "./types";

export type ComponentKey =
  "controlPlane" | "authority" | "gateway" | "audit" | "coordinator" | "runtime";

export type ComponentState = "operational" | "degraded" | "outage" | "unknown";

export const COMPONENT_ORDER: ComponentKey[] = [
  "controlPlane",
  "authority",
  "gateway",
  "audit",
  "coordinator",
  "runtime",
];

export const COMPONENTS: Record<ComponentKey, { name: string; purpose: string }> = {
  controlPlane: {
    name: "Control plane",
    purpose: "Admin API, configuration store, and operator authority.",
  },
  authority: {
    name: "Authority (STS)",
    purpose: "Token exchange and policy evaluation for every credential issued.",
  },
  gateway: {
    name: "Gateway",
    purpose: "Enforcement of credentials and revocations on live upstream traffic.",
  },
  audit: {
    name: "Audit pipeline",
    purpose: "Tamper-evident recording of every authority decision.",
  },
  coordinator: {
    name: "Coordinator",
    purpose: "Agent lifecycle, delegation, and background delivery workers.",
  },
  runtime: {
    name: "Runtime environment",
    purpose: "Host configuration, TLS, secrets, database, and cache endpoints.",
  },
};

export const STATE_LABELS: Record<ComponentState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  unknown: "Unknown",
};

/** Maps a doctor check onto the platform component it observes; zone checks return null. */
export function componentOf(check: DiagnosticCheck): ComponentKey | null {
  if (check.section === "zones") return null;
  if (check.section === "preflight") return "runtime";
  if (check.section === "health") return "controlPlane";
  if (check.check.startsWith("sts ")) return "authority";
  if (check.check.startsWith("gateway ")) return "gateway";
  if (check.check.startsWith("audit ")) return "audit";
  if (check.check.startsWith("coordinator ")) return "coordinator";
  return "controlPlane";
}

/** Collapses a set of checks into the component's worst observed state. */
export function stateOf(checks: DiagnosticCheck[]): ComponentState {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.status === "fail")) return "outage";
  if (checks.some((check) => check.status === "warn")) return "degraded";
  return "operational";
}

const PLATFORM_TITLES: Record<string, string> = {
  "api health": "API reachability",
  "clock skew": "Clock synchronization",
  "admin auth": "Admin authority",
  "admin config": "Admin credentials",
};

type ZoneCheckKind = "lookup" | "resources" | "policy sets" | "audit query";

const ZONE_TITLES: Record<ZoneCheckKind, string> = {
  lookup: "Zone lookup",
  resources: "Resource inventory",
  "policy sets": "Policy enforcement",
  "audit query": "Audit trail query",
};

const ZONE_CHECK_RE = /^(\S+) (lookup|resources|policy sets|audit query)$/;

function zoneCheckRef(check: DiagnosticCheck): { zoneId: string; kind: ZoneCheckKind } | null {
  if (check.section !== "zones") return null;
  const match = ZONE_CHECK_RE.exec(check.check);
  if (!match) return null;
  return { zoneId: match[1], kind: match[2] as ZoneCheckKind };
}

/** Human-readable title for a check row; raw check names stay in the detail line. */
export function checkTitle(check: DiagnosticCheck): string {
  const exact = PLATFORM_TITLES[check.check];
  if (exact) return exact;
  const zone = zoneCheckRef(check);
  if (zone) return ZONE_TITLES[zone.kind];
  if (check.section === "readiness") {
    if (check.check.endsWith(" readiness")) return "Service readiness";
    if (check.check.endsWith(" metrics")) return "Operational metrics";
    if (check.check.endsWith(" config")) return "Endpoint configuration";
  }
  return check.check;
}

export interface ZoneHealth {
  zoneId: string;
  state: ComponentState;
  checks: DiagnosticCheck[];
}

/** Groups zone-section checks per zone, plus the inventory check when no zones exist. */
export function zoneHealthOf(report: DiagnosticsReport): {
  inventory: DiagnosticCheck | undefined;
  zones: ZoneHealth[];
} {
  const inventory = report.checks.find(
    (check) => check.section === "zones" && check.check === "zone inventory",
  );
  const byZone = new Map<string, DiagnosticCheck[]>();
  for (const check of report.checks) {
    const ref = zoneCheckRef(check);
    if (!ref) continue;
    const group = byZone.get(ref.zoneId);
    if (group) group.push(check);
    else byZone.set(ref.zoneId, [check]);
  }
  const zones = [...byZone.entries()].map(([zoneId, checks]) => ({
    zoneId,
    state: stateOf(checks),
    checks,
  }));
  return { inventory, zones };
}

export type IssueSeverity = "critical" | "warning";

export interface IssueLink {
  label: string;
  sub: string;
  zoneId?: string;
}

export interface DiagnosticIssue {
  severity: IssueSeverity;
  title: string;
  explanation: string;
  impact?: string;
  guidance?: string;
  link?: IssueLink;
}

const COMPONENT_IMPACT: Record<ComponentKey, string> = {
  controlPlane:
    "The console and admin API cannot reliably manage zones until the control plane recovers.",
  authority: "Applications cannot exchange tokens, so no new credentials are issued.",
  gateway: "Live enforcement is unavailable; calls proxied through the gateway will fail.",
  audit:
    "Authority decisions may go unrecorded; treat the audit trail as incomplete until this is resolved.",
  coordinator: "Sessions, delegations, and background delivery are stalled.",
  runtime: "Local runtime configuration prevents services from operating cleanly.",
};

const ZONE_IMPACT = "Operations in this zone may be unavailable or unrecorded.";

const ZONE_LINKS: Record<ZoneCheckKind, IssueLink> = {
  lookup: { label: "Open zones", sub: "/zones" },
  resources: { label: "Open resources", sub: "/resources" },
  "policy sets": { label: "Open policy sets", sub: "/policies" },
  "audit query": { label: "Open audit", sub: "/audit" },
};

function issueOf(check: DiagnosticCheck, zoneNames: Map<string, string>): DiagnosticIssue {
  const severity: IssueSeverity = check.status === "fail" ? "critical" : "warning";
  const zone = zoneCheckRef(check);
  if (zone) {
    const zoneName = zoneNames.get(zone.zoneId) ?? zone.zoneId;
    const link = ZONE_LINKS[zone.kind];
    return {
      severity,
      title: `${zoneName} · ${ZONE_TITLES[zone.kind]}`,
      explanation: check.detail,
      impact: severity === "critical" ? ZONE_IMPACT : undefined,
      guidance: check.advice,
      link: zone.kind === "lookup" ? link : { ...link, zoneId: zone.zoneId },
    };
  }
  if (check.section === "zones") {
    return {
      severity,
      title: "No zones available",
      explanation: check.detail,
      guidance: check.advice,
      link: { label: "Create a zone", sub: "/zones" },
    };
  }
  const component = componentOf(check) ?? "controlPlane";
  return {
    severity,
    title: `${COMPONENTS[component].name} · ${checkTitle(check)}`,
    explanation: check.detail,
    impact: severity === "critical" ? COMPONENT_IMPACT[component] : undefined,
    guidance: check.advice,
  };
}

/** Every failing or degraded check as an actionable issue, most severe first. */
export function issuesOf(
  report: DiagnosticsReport,
  zoneNames: Map<string, string>,
): DiagnosticIssue[] {
  const issues = report.checks
    .filter((check) => check.status !== "ok")
    .map((check) => issueOf(check, zoneNames));
  return [
    ...issues.filter((i) => i.severity === "critical"),
    ...issues.filter((i) => i.severity === "warning"),
  ];
}
