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
      { id: "sessions", label: "Sessions", to: "/app/sessions", zoneScoped: true },
      { id: "signins", label: "Sign-ins", to: "/app/signins", zoneScoped: true },
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
    id: "platform",
    label: "Platform",
    items: [{ id: "services", label: "Services", to: "/app/services", zoneScoped: true }],
  },
];
