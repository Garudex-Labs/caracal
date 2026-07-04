/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the Services catalog of Caracal platform surfaces beyond the web console and SDK.
*/
import { createFileRoute, Link } from "@tanstack/react-router";

import { NavIcon } from "@/components/console/NavIcon";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
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
  tagline: string;
  description: string;
}

const SERVICES: Service[] = [
  {
    id: "run",
    name: "Launcher",
    command: "caracal run",
    to: "/services/run",
    tagline: "Launch workloads with injected credentials.",
    description:
      "caracal run starts any command under a workload identity: it authenticates with the workload's ID and client secret, fetches its launch bindings, injects short-lived resource credentials into the environment, and runs the process. No zone IDs, tokens, or config files live on the machine.",
  },
  {
    id: "control",
    name: "Control API",
    command: "HTTP /v1",
    to: "/services/control",
    tagline: "Programmatic administration for automation.",
    description:
      "Everything the console manages, exposed as an API: zones, applications, resources, policies, and audit. Open the endpoint, mint scoped Control credentials, and drive it from scripts, CI, or the Admin SDK.",
  },
];

function ServicesPage() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {SERVICES.map((service) => (
        <Link
          key={service.id}
          to={appLink(service.to)}
          className="group flex flex-col gap-4 rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/25"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted/60 text-foreground">
                <NavIcon name={service.id} className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="font-medium text-foreground">{service.name}</div>
                <code className="font-mono text-xs text-muted-foreground">{service.command}</code>
              </div>
            </div>
            <span
              aria-hidden="true"
              className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
            >
              →
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-foreground">{service.tagline}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{service.description}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
