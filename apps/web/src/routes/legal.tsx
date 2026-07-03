/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the legal route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SectionLabel } from "@/components/SiteShell";

export const Route = createFileRoute("/legal")({
  head: () => ({
    meta: [
      { title: "Legal · Caracal" },
      {
        name: "description",
        content: "Licensing, privacy posture, and security disclosures for Caracal.",
      },
      { property: "og:title", content: "Caracal Legal" },
      { property: "og:description", content: "Licensing, privacy, and security." },
    ],
  }),
  component: LegalPage,
});

const REPO = "https://github.com/Garudex-Labs/caracal";

const DOCS = {
  license: {
    title: "Licensing",
    updated: "Apache 2.0",
    body: [
      "Caracal is open-source software licensed under the Apache License, Version 2.0 free to use, copy, modify, and distribute, provided you preserve license notices and attribution.",
      "This repository contains the Community Edition only. Enterprise features are developed and licensed separately under a written commercial agreement and are not part of this codebase.",
      "The codebase may not be used to train, fine-tune, or develop machine-learning or AI models without prior written authorization from Garudex Labs. Copyright © 2026 Garudex Labs.",
    ],
  },
  privacy: {
    title: "Privacy",
    updated: "Self-hosted · you own your data",
    body: [
      "Caracal is self-hosted. You run the API, Coordinator, STS, Gateway, and Audit services in your own environment and own all data they process.",
      "Services persist only what the authority lifecycle requires agent sessions, service leases, delegation edges, mandates, and audit evidence. The audit ledger never stores plaintext claims, secrets resolve from files, and logs and responses redact key material and credentials.",
      "Garudex Labs collects no telemetry from self-hosted deployments. For licensing or enterprise inquiries, contact support@caracal.run.",
    ],
  },
};

const LINKS = [
  { label: "Apache 2.0 License", href: `${REPO}/blob/main/LICENSE` },
  { label: "Notice", href: `${REPO}/blob/main/NOTICE` },
  { label: "Code of Conduct", href: `${REPO}/blob/main/.github/CODE_OF_CONDUCT.md` },
  { label: "Security Policy", href: `${REPO}/blob/main/.github/SECURITY.md` },
  { label: "Threat Model", href: `${REPO}/blob/main/governance/THREAT_MODEL.md` },
  { label: "Incident Response", href: `${REPO}/blob/main/governance/INCIDENT_RESPONSE.md` },
  { label: "Governance", href: `${REPO}/blob/main/governance/GOVERNANCE.md` },
];

type DocKey = keyof typeof DOCS;

function LegalPage() {
  const [active, setActive] = useState<DocKey>("license");
  const doc = DOCS[active];
  return (
    <div className="px-4 py-10 sm:px-6 md:px-10 md:py-14">
      <SectionLabel>Legal</SectionLabel>
      <div className="mt-6 flex flex-wrap gap-2">
        {(Object.entries(DOCS) as [DocKey, (typeof DOCS)[DocKey]][]).map(([k, v]) => (
          <button
            key={k}
            onClick={() => setActive(k)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
              active === k
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.title}
          </button>
        ))}
      </div>

      <article className="mt-10 max-w-3xl">
        <h1 className="text-3xl font-medium tracking-tight md:text-4xl">{doc.title}</h1>
        <div className="mt-2 text-xs text-muted-foreground">{doc.updated}</div>
        <div className="mt-8 space-y-6">
          {doc.body.map((p, i) => (
            <p key={i} className="text-base leading-relaxed text-muted-foreground">
              {p}
            </p>
          ))}
        </div>
      </article>

      <div className="mt-14 max-w-3xl border-t border-border pt-8">
        <h2 className="text-sm font-semibold tracking-tight">Source documents</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The authoritative versions live in the open-source repository.
        </p>
        <div className="mt-5 grid grid-cols-1 gap-px bg-border sm:grid-cols-2 [&>*]:bg-background">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-2 p-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              {l.label}
              <span aria-hidden className="text-muted-foreground">
                ↗
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
