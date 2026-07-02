/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file describes enterprise capabilities shown as locked upgrade surfaces in Community Edition.
*/
export type FeatureHome = "settings" | "observability" | "policy";

export interface LockedFeature {
  slug: string;
  title: string;
  home: FeatureHome;
  summary: string;
  value: string[];
  includes: string[];
  community: string;
}

export const LOCKED_FEATURES: Record<string, LockedFeature> = {
  // Organization structure, membership, and federated sign-on form one administration
  // surface in Enterprise, so they upsell as a single page rather than separate entries.
  organization: {
    slug: "organization",
    title: "Organization",
    home: "settings",
    summary:
      "Organizations above zones, scoped member roles, and federated sign-on with directory provisioning.",
    value: [
      "Model business units as organizations above the same zone primitive.",
      "Give each operator the least privilege they need with scoped roles.",
      "Sign in every operator through your existing identity provider.",
      "Provision and deprovision access automatically as your directory changes.",
    ],
    includes: [
      "Organizations and projects above zones with strict isolation",
      "Delegated organization administration, quotas, and audit scoping",
      "Member invitations with predefined and custom roles",
      "Per-zone and per-organization role scoping",
      "SAML 2.0 and OIDC single sign-on",
      "SCIM 2.0 provisioning and directory-driven deprovisioning",
    ],
    community:
      "Community runs as a single installation-scoped administrator with local email-and-password accounts.",
  },
  connectors: {
    slug: "connectors",
    title: "Integrations",
    home: "settings",
    summary: "Connect Caracal to your SIEM, directory, and ticketing systems.",
    value: [
      "Stream audit events to the tools your security team already uses.",
      "Sync identity from enterprise directories.",
      "Wire authority changes into incident and change workflows.",
    ],
    includes: [
      "SIEM streaming (Splunk, Elastic, Datadog)",
      "Directory sync (Okta, Entra ID)",
      "Ticketing and ITSM (ServiceNow, Jira)",
      "Webhooks for authority and audit events",
      "Managed connector health and retries",
    ],
    community: "Community exposes audit through the console and API for your own export.",
  },
  analytics: {
    slug: "analytics",
    title: "Analytics",
    home: "observability",
    summary:
      "Cross-zone dashboards, usage reporting, and anomaly detection over authority activity.",
    value: [
      "See authority and delegation trends across every zone.",
      "Detect anomalies in agent and resource activity early.",
      "Schedule reports for stakeholders automatically.",
    ],
    includes: [
      "Cross-zone authority dashboards",
      "Usage and trend reporting",
      "Anomaly detection on agent activity",
      "Scheduled and exportable reports",
      "Long-range historical retention",
    ],
    community: "Community shows live per-zone activity in the dashboard and Audit.",
  },
  // Compliance is an enterprise capability; Community ships no compliance surface or upsell page.
  governance: {
    slug: "governance",
    title: "Governance",
    home: "policy",
    summary:
      "Approval workflows, access reviews, and break-glass controls for sensitive authority.",
    value: [
      "Require approvals before sensitive authority changes take effect.",
      "Run periodic access recertification campaigns.",
      "Break glass with quorum and a full audit trail.",
    ],
    includes: [
      "Change approval workflows",
      "Periodic access recertification",
      "Quorum-based break-glass access",
      "Separation-of-duties enforcement",
      "Policy change review and sign-off",
    ],
    community: "Community enforces authority directly through the policy sets you activate.",
  },
};

export const ENTERPRISE_FEATURES = Object.values(LOCKED_FEATURES);

export function featuresByHome(home: FeatureHome): LockedFeature[] {
  return ENTERPRISE_FEATURES.filter((feature) => feature.home === home);
}
