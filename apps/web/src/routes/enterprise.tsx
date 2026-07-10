/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the enterprise route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import Cal, { getCalApi } from "@calcom/embed-react";
import { SectionLabel } from "@/components/SiteShell";

const CAL_LINK = "rawx18/caracal-enterprise-sales";

export const Route = createFileRoute("/enterprise")({
  head: () => ({
    meta: [
      { title: "Enterprise · Caracal" },
      {
        name: "description",
        content:
          "Enterprise-grade agent governance without operating the stack: managed multi-tenancy, hosted control plane, SSO and SCIM, fully managed data plane, and commercial support.",
      },
      { property: "og:title", content: "Caracal for Enterprise" },
      {
        property: "og:description",
        content:
          "Fully managed Caracal: managed multi-tenancy, hosted control plane, SSO, and commercial support.",
      },
    ],
  }),
  component: EnterprisePage,
});

function EnterprisePage() {
  return (
    <div className="px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Enterprise</SectionLabel>
      <h1 className="mt-6 max-w-3xl text-4xl font-medium leading-[1.05] tracking-tight md:text-6xl">
        Enterprise-grade agent governance,{" "}
        <span className="text-muted-foreground">without operating the stack.</span>
      </h1>

      <ComparisonTable />
      <BookACall />
    </div>
  );
}
function ComparisonTable() {
  const rows = [
    ["Authority model: mandates, delegation, policy, audit", "Included", "Included"],
    ["SDKs and connectors", "Included", "Included"],
    ["Zones as a manual isolation primitive", "Included", "Included"],
    [
      "Managed multi-tenancy",
      "Self-modeled with zones and the Admin API",
      "Native tenant, organization, and workspace lifecycle",
    ],
    ["Single sign-on (SSO)", "Not included", "SAML and OIDC SSO with SCIM provisioning"],
    [
      "Teams and role-based access control",
      "Not included",
      "Org, team, and role management across tenants",
    ],
    [
      "Control surface",
      "Local Console and self-hosted Admin API",
      "Hosted management UI for all tenants",
    ],
    [
      "Gateway and services",
      "You deploy and operate every service",
      "Fully managed Gateway, STS, Coordinator, and audit plane",
    ],
    [
      "Integration effort",
      "Run the full stack, then integrate the SDK",
      "Integrate the SDK against managed endpoints; no services to run",
    ],
    ["Support", "Community and issues", "Commercial SLA, priority support, and onboarding"],
  ];
  return (
    <div className="mt-16 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-170 border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface">
            <th className="px-4 py-3 font-semibold tracking-tight">Capability</th>
            <th className="px-4 py-3 font-semibold tracking-tight">
              Community Edition{" "}
              <span className="font-normal text-muted-foreground">(Apache 2.0)</span>
            </th>
            <th className="px-4 py-3 font-semibold tracking-tight">
              Enterprise Edition{" "}
              <span className="font-normal text-muted-foreground">(commercial)</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([capability, community, enterprise]) => (
            <tr key={capability} className="border-b border-border align-top last:border-0">
              <td className="px-4 py-3 font-medium">{capability}</td>
              <td className="px-4 py-3 text-muted-foreground">{community}</td>
              <td className="px-4 py-3 text-muted-foreground">{enterprise}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function BookACall() {
  useEffect(() => {
    (async () => {
      const cal = await getCalApi();
      cal("ui", { theme: "auto", hideEventTypeDetails: false, layout: "month_view" });
    })();
  }, []);
  return (
    <section id="book" className="mt-20">
      <SectionLabel>Talk to sales</SectionLabel>
      <h2 className="mt-4 text-2xl font-medium tracking-tight md:text-3xl">
        Book an enterprise call
      </h2>
      <div className="mt-6 overflow-hidden rounded-md border border-border bg-background">
        <Cal
          calLink={CAL_LINK}
          style={{ width: "100%", height: "760px", overflow: "scroll" }}
          config={{ layout: "month_view", theme: "auto" }}
        />
      </div>
    </section>
  );
}
