/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Pure presenter that resolves an Operator plan's steps into Console citation destinations.
*/
import type { CitationSource } from "@/components/ai-elements/inline-citation";
import type { OperatorCapability, OperatorCapabilityDomain } from "@/platform/api/types";

import type { PlanItem, PlanStepView } from "./timeline";

// Each capability domain maps to the Console page that owns its items, so a citation can
// open the exact surface the Operator acted on. A destination may pin extra search params,
// such as the view tab that hosts the domain within its page.
const DOMAIN_ROUTE: Partial<
  Record<OperatorCapabilityDomain, { to: string; label: string; search?: Record<string, string> }>
> = {
  zone: { to: "/app/zones", label: "Zone" },
  application: { to: "/app/applications", label: "Application" },
  provider: { to: "/app/providers", label: "Provider" },
  resource: { to: "/app/resources", label: "Resource" },
  policy: { to: "/app/policies", label: "Policy" },
  grant: { to: "/app/sessions", label: "Grant", search: { view: "delegation" } },
  audit: { to: "/app/audit", label: "Audit" },
};

// The argument keys that identify the item a step acts on, in preference order: a human
// name first, then the typed references the control plane uses.
const IDENTITY_KEYS = [
  "name",
  "title",
  "resource_id",
  "application_id",
  "provider_id",
  "user_id",
  "zone_id",
  "id",
];

function itemLabel(args: Record<string, unknown>): string | null {
  for (const key of IDENTITY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// The Console search boxes match on the bare slug, so a scheme-qualified identifier such as
// resource://pipernet focuses the page by its slug rather than the full URI.
function focusValue(label: string): string {
  const scheme = label.indexOf("://");
  return scheme === -1 ? label : label.slice(scheme + 3);
}

// A step points at a real, openable item when it already exists: a read-only step reads an
// existing item, and a mutating step has one only after it has succeeded.
function itemExists(step: PlanStepView): boolean {
  return !step.mutating || step.status === "succeeded";
}

// Resolves a plan's steps into Console citations using the live capability catalog for the
// domain and title, and the step's own arguments for the exact item. Steps whose capability
// is unknown, whose domain has no Console page, or whose item does not yet exist are skipped,
// and duplicate destinations collapse to one source.
export function planCitations(plan: PlanItem, catalog: OperatorCapability[]): CitationSource[] {
  const byId = new Map(catalog.map((capability) => [capability.id, capability]));
  const seen = new Set<string>();
  const sources: CitationSource[] = [];

  for (const step of plan.steps) {
    const capability = byId.get(step.capability);
    if (!capability) continue;
    const destination = DOMAIN_ROUTE[capability.domain];
    if (!destination) continue;
    if (!itemExists(step)) continue;

    const label = itemLabel(step.args);
    const title = label ?? capability.title;
    const dedupe = `${destination.to}|${title}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    sources.push({
      key: step.id,
      title,
      description: step.summary || capability.summary,
      domainLabel: destination.label,
      to: destination.to,
      search: { ...destination.search, ...(label ? { focus: focusValue(label) } : {}) },
    });
  }

  return sources;
}
