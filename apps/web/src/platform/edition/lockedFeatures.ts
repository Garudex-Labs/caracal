/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file describes enterprise capabilities shown as locked surfaces in Community Edition.
*/
export interface LockedFeature {
  slug: string;
  title: string;
  summary: string;
  value: string[];
}

export const LOCKED_FEATURES: Record<string, LockedFeature> = {
  organizations: {
    slug: "organizations",
    title: "Organizations",
    summary: "Group zones under organizations and projects for multi-team isolation at scale.",
    value: [
      "Model business units as organizations above the same zone primitive.",
      "Delegate administration without sharing a single installation.",
      "Keep the Community zone model unchanged underneath.",
    ],
  },
  "teams-roles": {
    slug: "teams-roles",
    title: "Teams & Roles",
    summary: "Manage teams and fine-grained roles beyond installation-scoped administration.",
    value: [
      "Invite teams and assign scoped roles per organization.",
      "Map roles onto Caracal authority without custom policy plumbing.",
      "Review membership and access in one place.",
    ],
  },
  sso: {
    slug: "sso",
    title: "SSO & Directory Sync",
    summary: "Federate identity with SAML, OIDC, and SCIM directory provisioning.",
    value: [
      "Single sign-on for every operator through your IdP.",
      "Automatic provisioning and deprovisioning with SCIM.",
      "Replace local accounts without changing the Caracal security model.",
    ],
  },
  compliance: {
    slug: "compliance",
    title: "Compliance Center",
    summary: "Collect evidence, map controls, and manage retention for audits.",
    value: [
      "Map Caracal audit to SOC 2, ISO, and FedRAMP controls.",
      "Automate evidence collection and retention.",
      "Export immutable reports for auditors.",
    ],
  },
  analytics: {
    slug: "analytics",
    title: "Analytics",
    summary: "Cross-zone dashboards, usage reporting, and anomaly detection.",
    value: [
      "See authority and delegation trends across every zone.",
      "Detect anomalies in agent and resource activity.",
      "Schedule reports for stakeholders.",
    ],
  },
  governance: {
    slug: "governance",
    title: "Governance",
    summary: "Approval workflows, access reviews, and break-glass controls.",
    value: [
      "Require approvals for sensitive authority changes.",
      "Run periodic access recertification.",
      "Break-glass with quorum and full audit.",
    ],
  },
  connectors: {
    slug: "connectors",
    title: "Enterprise Connectors",
    summary: "Integrate with Okta, Entra, Splunk, ServiceNow, and more.",
    value: [
      "Stream audit to your SIEM.",
      "Sync identity from enterprise directories.",
      "Connect ticketing and incident workflows.",
    ],
  },
};
