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
  sso: {
    slug: "sso",
    title: "SSO & Directory Sync",
    home: "settings",
    summary: "Federate operator identity with SAML, OIDC, and SCIM directory provisioning.",
    value: [
      "Sign in every operator through your existing identity provider.",
      "Provision and deprovision access automatically as your directory changes.",
      "Enforce MFA and session policy centrally without local accounts.",
    ],
    includes: [
      "SAML 2.0 and OIDC single sign-on",
      "SCIM 2.0 user and group provisioning",
      "Just-in-time account creation",
      "Directory-driven deprovisioning",
      "Enforced IdP session and MFA policy",
    ],
    community: "Community uses local email-and-password accounts with per-device sessions.",
  },
  "teams-roles": {
    slug: "teams-roles",
    title: "Members & Roles",
    home: "settings",
    summary: "Invite operators and grant scoped roles instead of one shared installation admin.",
    value: [
      "Give each operator the least privilege they need.",
      "Map roles onto Caracal authority without custom policy plumbing.",
      "Review who can do what from one place.",
    ],
    includes: [
      "Member invitations and lifecycle",
      "Predefined and custom roles",
      "Per-zone and per-organization scoping",
      "Role-to-authority mapping",
      "Membership and access review",
    ],
    community: "Community runs as a single installation-scoped administrator.",
  },
  organizations: {
    slug: "organizations",
    title: "Organization",
    home: "settings",
    summary:
      "Group zones under organizations and projects for clean multi-team isolation at scale.",
    value: [
      "Model business units as organizations above the same zone primitive.",
      "Delegate administration without sharing one installation.",
      "Keep the Community zone model unchanged underneath.",
    ],
    includes: [
      "Organizations and projects above zones",
      "Strict cross-organization isolation",
      "Delegated organization administration",
      "Per-organization quotas and settings",
      "Organization-level audit scoping",
    ],
    community: "Community manages zones directly within a single workspace.",
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
