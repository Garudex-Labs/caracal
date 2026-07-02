/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file describes enterprise capabilities shown as locked upgrade surfaces in Community Edition.
*/
export type FeatureHome = "settings" | "observability" | "policy";

export type FeatureIcon =
  | "building"
  | "gauge"
  | "mail"
  | "key"
  | "sync"
  | "layers"
  | "wave"
  | "users"
  | "ticket"
  | "zap"
  | "heart"
  | "grid"
  | "chart"
  | "alert"
  | "calendar"
  | "database"
  | "clipboard"
  | "scale"
  | "pen";

export interface LockedFeature {
  slug: string;
  title: string;
  home: FeatureHome;
  summary: string;
  /** Two-line hook shown on the upgrade panel: bright lead, muted follow-up. */
  headline: [string, string];
  value: string[];
  includes: { icon: FeatureIcon; label: string }[];
  community: string;
}

export const LOCKED_FEATURES: Record<string, LockedFeature> = {
  // Organization structure, membership, and federated sign-on form one administration
  // surface in Enterprise, so they upsell as a single page rather than separate entries.
  organization: {
    slug: "organization",
    title: "Organization",
    home: "settings",
    summary: "Organizations above zones, scoped member roles, and federated sign-on.",
    headline: ["Every team, one directory.", "Roles, SSO, and provisioning built in."],
    value: [
      "Model business units as organizations above zones.",
      "Give each operator least-privilege scoped roles.",
      "Sign in through your existing identity provider.",
    ],
    includes: [
      { icon: "building", label: "Organizations and projects" },
      { icon: "gauge", label: "Delegated admin and quotas" },
      { icon: "mail", label: "Invitations with custom roles" },
      { icon: "key", label: "SAML 2.0 and OIDC SSO" },
      { icon: "sync", label: "SCIM 2.0 provisioning" },
      { icon: "layers", label: "Per-zone role scoping" },
    ],
    community: "Community runs as a single owner with local accounts.",
  },
  connectors: {
    slug: "connectors",
    title: "Integrations",
    home: "settings",
    summary: "Connect Caracal to your SIEM, directory, and ticketing systems.",
    headline: ["Plugged into your stack.", "SIEM, directory, and ticketing."],
    value: [
      "Stream audit events to your security tools.",
      "Sync identity from enterprise directories.",
      "Route authority changes into your workflows.",
    ],
    includes: [
      { icon: "wave", label: "SIEM streaming (Splunk, Elastic, Datadog)" },
      { icon: "users", label: "Directory sync (Okta, Entra ID)" },
      { icon: "ticket", label: "Ticketing (ServiceNow, Jira)" },
      { icon: "zap", label: "Authority and audit webhooks" },
      { icon: "heart", label: "Managed health and retries" },
    ],
    community: "Community exposes audit through the console and API.",
  },
  analytics: {
    slug: "analytics",
    title: "Analytics",
    home: "observability",
    summary: "Cross-zone dashboards, usage reporting, and anomaly detection.",
    headline: ["See every zone at once.", "Trends, reports, and anomalies."],
    value: [
      "Follow authority trends across every zone.",
      "Catch anomalies in agent activity early.",
      "Deliver stakeholder reports automatically.",
    ],
    includes: [
      { icon: "grid", label: "Cross-zone dashboards" },
      { icon: "chart", label: "Usage and trend reporting" },
      { icon: "alert", label: "Anomaly detection" },
      { icon: "calendar", label: "Scheduled, exportable reports" },
      { icon: "database", label: "Long-range retention" },
    ],
    community: "Community shows live per-zone activity in the dashboard and Audit.",
  },
  // Compliance is an enterprise capability; Community ships no compliance surface or upsell page.
  governance: {
    slug: "governance",
    title: "Governance",
    home: "policy",
    summary: "Approval workflows, access reviews, and break-glass controls.",
    headline: ["Nothing lands unreviewed.", "Approvals, reviews, break-glass."],
    value: [
      "Require approval before sensitive changes land.",
      "Run periodic access recertification.",
      "Break glass with quorum and a full audit trail.",
    ],
    includes: [
      { icon: "clipboard", label: "Change approval workflows" },
      { icon: "sync", label: "Access recertification" },
      { icon: "alert", label: "Quorum break-glass access" },
      { icon: "scale", label: "Separation-of-duties enforcement" },
      { icon: "pen", label: "Policy review and sign-off" },
    ],
    community: "Community enforces authority directly through active policy sets.",
  },
};

export const ENTERPRISE_FEATURES = Object.values(LOCKED_FEATURES);

export function featuresByHome(home: FeatureHome): LockedFeature[] {
  return ENTERPRISE_FEATURES.filter((feature) => feature.home === home);
}
