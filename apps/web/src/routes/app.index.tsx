/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Console dashboard route.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Button, Card, SectionTitle, Skeleton, Stat } from "@/components/ui";
import { activeZones, getActiveZone, workspaceLabel } from "@/platform/state/localInstall";

export const Route = createFileRoute("/app/")({
  component: DashboardPage,
});

const QUICK_ACTIONS = [
  { label: "Create zone", to: "/app/zones" },
  { label: "Add application", to: "/app/applications" },
  { label: "Write policy", to: "/app/policies" },
  { label: "View audit", to: "/app/audit" },
];

const RECENT = [
  { when: "2m ago", text: "Policy set v3 activated" },
  { when: "18m ago", text: "Agent session delegated read scope" },
  { when: "1h ago", text: "Application acme-worker created" },
  { when: "3h ago", text: "Resource billing-api updated" },
];

function DashboardPage() {
  const workspace = workspaceLabel();
  const [loading, setLoading] = useState(true);
  const [zoneCount, setZoneCount] = useState(0);
  const [activeName, setActiveName] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setZoneCount(activeZones().length);
      setActiveName(getActiveZone()?.name ?? null);
      setLoading(false);
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <ModulePage
      title="Dashboard"
      description={`${workspace} · ${activeName ? `active zone ${activeName}` : "no active zone"}`}
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Dashboard" }]}
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Active zones"
          value={zoneCount}
          hint="Across this installation"
          loading={loading}
        />
        <Stat label="Applications" value={6} hint="Agent identities" loading={loading} />
        <Stat label="Policy sets" value={2} hint="1 active" loading={loading} />
        <Stat label="Agent sessions" value={3} hint="Live now" loading={loading} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Quick actions</SectionTitle>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {QUICK_ACTIONS.map((action) => (
              <Link
                key={action.to}
                to={action.to}
                className="rounded-md border border-border bg-background px-3 py-3 text-center text-sm font-medium transition-colors hover:bg-accent"
              >
                {action.label}
              </Link>
            ))}
          </div>

          <div className="mt-6">
            <SectionTitle>Recent activity</SectionTitle>
            {loading ? (
              <div className="mt-3 flex flex-col gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <Skeleton className="h-4 w-56" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                ))}
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {RECENT.map((item) => (
                  <li key={item.text} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="text-foreground">{item.text}</span>
                    <span className="text-xs text-muted-foreground">{item.when}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <SectionTitle>Audit summary</SectionTitle>
            <div className="mt-3 flex items-center gap-4">
              <div>
                <div className="text-2xl font-semibold tracking-tight text-foreground">1,284</div>
                <div className="text-xs text-muted-foreground">decisions · 24h</div>
              </div>
              <div className="flex flex-col gap-1">
                <Badge tone="success">1,190 allow</Badge>
                <Badge tone="warning">94 deny</Badge>
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle>Health</SectionTitle>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {["Gateway", "STS", "Coordinator", "Audit"].map((service) => (
                <li key={service} className="flex items-center justify-between">
                  <span className="text-foreground">{service}</span>
                  <Badge tone="success">Healthy</Badge>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <SectionTitle>Setup recommendations</SectionTitle>
            <ul className="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">
              <li>· Add an identity provider to your active zone.</li>
              <li>· Create a Control API key for automation.</li>
              <li>· Activate a policy set before going live.</li>
            </ul>
            <div className="mt-3">
              <Link to="/app/settings">
                <Button variant="secondary" size="sm">
                  Open settings
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </ModulePage>
  );
}
