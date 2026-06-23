/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the documentation route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { SectionLabel } from "@/components/SiteShell";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — Caracal" },
      {
        name: "description",
        content: "Choose the Caracal documentation path that matches your implementation.",
      },
      { property: "og:title", content: "Caracal Documentation" },
      {
        property: "og:description",
        content: "Open the core Caracal docs or enterprise implementation guides.",
      },
    ],
  }),
  component: DocsPage,
});

const DOCS = [
  {
    label: "Core Docs",
    title: "Caracal Open Source",
    href: "https://docs.caracal.run/",
    eyebrow: "Start here",
    items: [
      "Get started",
      "Mandates and delegation",
      "SDKs and connectors",
      "Self-host operations",
    ],
    command: "docs.caracal.run",
  },
  {
    label: "Enterprise Docs",
    title: "Caracal Enterprise",
    href: "https://docs.caracal.run/enterprise",
    eyebrow: "For teams",
    items: ["SSO and SCIM", "Security architecture", "Governance", "Production operations"],
    command: "docs.caracal.run/enterprise",
  },
];

function DocsPage() {
  return (
    <>
      <section className="border-b border-border px-4 py-10 sm:px-6 md:px-10 md:py-14">
        <SectionLabel>Documentation</SectionLabel>
        <h1 className="mt-6 max-w-4xl text-4xl font-medium leading-[1.05] tracking-tight md:text-6xl">
          Open the right Caracal docs for the way you build.
        </h1>
      </section>

      <section className="grid grid-cols-1 border-b border-border lg:grid-cols-2">
        {DOCS.map((doc, index) => (
          <DocSection key={doc.href} doc={doc} index={index} />
        ))}
      </section>
    </>
  );
}

function DocSection({ doc, index }: { doc: (typeof DOCS)[number]; index: number }) {
  const primary = index === 0;

  return (
    <a
      href={doc.href}
      className={`group block min-h-[34rem] border-border p-6 transition hover:bg-surface sm:p-8 md:p-10 ${
        primary ? "lg:border-r" : ""
      }`}
    >
      <div className="flex h-full flex-col justify-between gap-10">
        <div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                {doc.eyebrow}
              </div>
              <div className="mt-2 font-mono text-xs text-muted-foreground">{doc.label}</div>
            </div>
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-border bg-card text-lg transition group-hover:bg-foreground group-hover:text-background">
              ↗
            </span>
          </div>

          <h2 className="mt-10 max-w-xl text-3xl font-medium leading-tight tracking-tight md:text-5xl">
            {doc.title}
          </h2>

          <div className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 [&>*]:bg-background">
            {doc.items.map((item) => (
              <div key={item} className="flex items-center gap-2 p-4 text-sm">
                <span className="text-foreground">+</span>
                <span className="text-muted-foreground">{item}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="h-2 w-2 rounded-full bg-rose-400" />
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="ml-3 font-mono text-xs text-muted-foreground">open docs</span>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-5 font-mono text-xs sm:text-sm">
            <span className="truncate text-muted-foreground">
              <span className="text-accent-purple">https://</span>
              {doc.command}
            </span>
            <span className="shrink-0 text-foreground">Open →</span>
          </div>
        </div>
      </div>
    </a>
  );
}
