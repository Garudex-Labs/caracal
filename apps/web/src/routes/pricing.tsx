/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the pricing route.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { SectionLabel } from "@/components/SiteShell";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing · Caracal" },
      {
        name: "description",
        content:
          "Free open-source framework. Managed infrastructure plans for production teams and enterprises.",
      },
      { property: "og:title", content: "Caracal Pricing" },
      {
        property: "og:description",
        content: "Starter, Pro, and Enterprise plans for Caracal infrastructure.",
      },
    ],
  }),
  component: PricingPage,
});

const PLANS = [
  {
    name: "Community Edition",
    price: "Free",
    suffix: "Apache 2.0",
    blurb: "Self-host the full Caracal stack and integrate the SDK.",
    features: [
      "Full authority model: mandates, delegation, policy, audit",
      "TypeScript, Python, and Go SDKs and connectors",
      "Zones as a manual tenant isolation primitive",
      "Self-host every service: Gateway, STS, Coordinator, audit",
      "Community support",
    ],
    cta: "Read the docs",
    to: "/docs",
  },
  {
    name: "Enterprise Edition",
    price: "Custom",
    suffix: "",
    blurb: "Fully managed Caracal for production teams.",
    features: [
      "Managed multi-tenancy: tenants, organizations, workspaces",
      "Hosted management UI for every tenant",
      "Fully managed data plane, no services to run",
      "SAML and OIDC SSO with SCIM provisioning",
      "Commercial SLA, priority support, and onboarding",
    ],
    cta: "Contact Sales",
    to: "/enterprise",
  },
];

function PricingPage() {
  return (
    <div className="px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Pricing</SectionLabel>
      <h1 className="mt-6 max-w-3xl text-3xl font-medium leading-tight tracking-tight md:text-5xl">
        Start free and self-hosted. Scale to fully managed Caracal.
      </h1>

      <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2">
        {PLANS.map((p) => (
          <div key={p.name} className="flex flex-col rounded-lg border border-border bg-card p-6">
            <h3 className="text-lg font-semibold tracking-tight">{p.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{p.blurb}</p>
            <div className="mt-6 flex items-baseline gap-1">
              <span className="text-4xl font-medium tracking-tight">{p.price}</span>
              <span className="text-sm text-muted-foreground">{p.suffix}</span>
            </div>
            <ul className="mt-6 flex-1 space-y-2.5">
              {p.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 text-emerald-600">✓</span>
                  <span className="text-muted-foreground">{f}</span>
                </li>
              ))}
            </ul>
            <Link
              to={p.to}
              className="mt-6 inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium transition hover:bg-surface"
            >
              {p.cta}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
