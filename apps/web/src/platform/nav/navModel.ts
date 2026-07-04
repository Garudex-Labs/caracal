/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Console navigation model shared across editions.
*/
export interface NavItem {
  id: string;
  label: string;
  to: string;
  locked?: boolean;
  zoneScoped?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [{ id: "dashboard", label: "Dashboard", to: "/app" }],
  },
  {
    id: "access",
    label: "Access",
    items: [
      { id: "applications", label: "Applications", to: "/app/applications", zoneScoped: true },
      { id: "providers", label: "Providers", to: "/app/providers", zoneScoped: true },
      { id: "resources", label: "Resources", to: "/app/resources", zoneScoped: true },
    ],
  },
  {
    id: "policy",
    label: "Policy",
    items: [
      { id: "policies", label: "Policies", to: "/app/policies", zoneScoped: true },
      { id: "governance", label: "Governance", to: "/app/enterprise/governance", locked: true },
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    items: [
      { id: "run", label: "Run", to: "/app/run", zoneScoped: true },
      { id: "agents", label: "Agents", to: "/app/agents", zoneScoped: true },
      { id: "sessions", label: "Sessions", to: "/app/sessions", zoneScoped: true },
      { id: "approvals", label: "Approvals", to: "/app/approvals", zoneScoped: true },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    items: [
      { id: "audit", label: "Audit", to: "/app/audit", zoneScoped: true },
      { id: "analytics", label: "Analytics", to: "/app/enterprise/analytics", locked: true },
      // Compliance is an enterprise capability; Community has no dedicated compliance page.
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [{ id: "control", label: "Control API", to: "/app/control", zoneScoped: true }],
  },
];
