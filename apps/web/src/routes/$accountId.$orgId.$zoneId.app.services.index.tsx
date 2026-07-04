/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the Services catalog of Caracal platform surfaces beyond the web console and SDK.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { cx } from "@/lib/cx";
import { appLink } from "@/platform/nav/appLink";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/services/")({
  component: ServicesRoute,
});

function ServicesRoute() {
  return (
    <ZoneScopedPage
      title="Services"
      description="Caracal surfaces beyond the web console and SDK."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Services" }]}
    >
      {() => <ServicesPage />}
    </ZoneScopedPage>
  );
}

interface Service {
  id: string;
  name: string;
  command: string;
  to: string;
  image: string;
  imageAlt: string;
  tagline: string;
}

type Layout = "grid" | "rows";

function LayoutIcon({ layout }: { layout: Layout }) {
  return layout === "grid" ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="16" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="13.5" width="16" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

const SERVICES: Service[] = [
  {
    id: "run",
    name: "Launcher",
    command: "caracal run",
    to: "/services/run",
    image: "/launcher.png",
    imageAlt: "Launcher workload configuration preview",
    tagline: "Launch workloads with injected credentials.",
  },
  {
    id: "control",
    name: "Control API",
    command: "HTTP /v1",
    to: "/services/control",
    image: "/control.png",
    imageAlt: "Control API keys and automation preview",
    tagline: "Programmatic administration for automation.",
  },
];

function ServicesPage() {
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<Layout>("grid");
  const normalizedQuery = query.trim().toLowerCase();
  const services = normalizedQuery
    ? SERVICES.filter((service) =>
        [service.name, service.command, service.tagline]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : SERVICES;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 border-b border-border pb-3">
        <label className="flex min-w-0 flex-1 items-center gap-2.5">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="sr-only">Search services</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search services…"
            className="h-8 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        <div className="flex shrink-0 gap-0.5">
          {(["grid", "rows"] as Layout[]).map((mode) => {
            const selected = layout === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-label={mode === "grid" ? "Grid layout" : "Rows layout"}
                aria-pressed={selected}
                onClick={() => setLayout(mode)}
                className={cx(
                  "grid h-8 w-8 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                  selected
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LayoutIcon layout={mode} />
              </button>
            );
          })}
        </div>
      </div>

      {services.length > 0 ? (
        <div
          className={cx(
            "grid gap-4",
            layout === "grid" ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4" : "grid-cols-1",
          )}
        >
          {services.map((service) =>
            layout === "grid" ? (
              <Link
                key={service.id}
                to={appLink(service.to)}
                className="group overflow-hidden rounded-lg border border-border bg-card transition-all hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md"
              >
                <img
                  src={service.image}
                  alt={service.imageAlt}
                  className="aspect-16/10 w-full border-b border-border object-cover object-top transition-transform duration-500 group-hover:scale-[1.02]"
                />
                <div className="flex flex-col gap-1 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">{service.name}</p>
                    <code className="font-mono text-xs text-muted-foreground">
                      {service.command}
                    </code>
                  </div>
                  <p className="text-sm text-muted-foreground">{service.tagline}</p>
                </div>
              </Link>
            ) : (
              <Link
                key={service.id}
                to={appLink(service.to)}
                className="group flex items-center gap-4 overflow-hidden rounded-lg border border-border bg-card p-3 transition-all hover:border-foreground/25 hover:shadow-md"
              >
                <img
                  src={service.image}
                  alt={service.imageAlt}
                  className="aspect-16/10 w-40 shrink-0 rounded-md border border-border object-cover object-top"
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-3">
                    <p className="text-sm font-semibold text-foreground">{service.name}</p>
                    <code className="font-mono text-xs text-muted-foreground">
                      {service.command}
                    </code>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{service.tagline}</p>
                </div>
              </Link>
            ),
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
          <p className="text-sm font-medium text-foreground">No services found</p>
          <p className="mt-1 text-sm text-muted-foreground">Try a different search term.</p>
        </div>
      )}
    </div>
  );
}
