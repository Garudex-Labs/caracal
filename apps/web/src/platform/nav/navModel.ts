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
      { id: "zones", label: "Zones", to: "/app/zones" },
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
      { id: "policy-sets", label: "Policy Sets", to: "/app/policy-sets", zoneScoped: true },
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    items: [
      { id: "agents", label: "Agents", to: "/app/agents", zoneScoped: true },
      { id: "delegation", label: "Delegation", to: "/app/delegation", zoneScoped: true },
      { id: "sessions", label: "Sessions", to: "/app/sessions", zoneScoped: true },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    items: [
      { id: "audit", label: "Audit", to: "/app/audit", zoneScoped: true },
      { id: "diagnostics", label: "Diagnostics", to: "/app/diagnostics" },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [{ id: "control", label: "Control API", to: "/app/control", zoneScoped: true }],
  },
  {
    id: "settings",
    label: "Settings",
    items: [{ id: "settings", label: "Settings", to: "/app/settings" }],
  },
  {
    id: "enterprise",
    label: "Enterprise",
    items: [
      {
        id: "organizations",
        label: "Organizations",
        to: "/app/enterprise/organizations",
        locked: true,
      },
      {
        id: "teams-roles",
        label: "Teams & Roles",
        to: "/app/enterprise/teams-roles",
        locked: true,
      },
      { id: "sso", label: "SSO & Directory Sync", to: "/app/enterprise/sso", locked: true },
      {
        id: "compliance",
        label: "Compliance Center",
        to: "/app/enterprise/compliance",
        locked: true,
      },
      { id: "analytics", label: "Analytics", to: "/app/enterprise/analytics", locked: true },
      { id: "governance", label: "Governance", to: "/app/enterprise/governance", locked: true },
      {
        id: "connectors",
        label: "Enterprise Connectors",
        to: "/app/enterprise/connectors",
        locked: true,
      },
    ],
  },
];
