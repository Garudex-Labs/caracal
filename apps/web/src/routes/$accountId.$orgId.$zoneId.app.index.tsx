/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Console dashboard overview route.
*/
import { appLink } from "@/platform/nav/appLink";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SectionLabel } from "@/components/SiteShell";
import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { auditDecisionTone, auditEventContext, auditEventLabel } from "@/lib/auditPresentation";
import { cx } from "@/lib/cx";
import { useActiveZone, useApprovalCounts, useZoneOverview, useZones } from "@/platform/api/hooks";
import type { OverviewEvent, Zone, ZoneOverview } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/")({
  component: DashboardPage,
});

type Tone = "ok" | "warn" | "danger" | "muted";

function DashboardPage() {
  const zonesQuery = useZones();
  const { zones, activeZone } = useActiveZone();

  const frame = (body: ReactNode, actions?: ReactNode) => (
    <ModulePage
      title="Dashboard"
      description="Your zone's authority posture, recent activity, and setup at a glance."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Dashboard" }]}
      actions={actions}
    >
      {body}
    </ModulePage>
  );

  if (zonesQuery.isLoading) {
    return frame(<DashboardSkeleton />);
  }

  if (zones.length === 0 || !activeZone) {
    return frame(
      <EmptyState
        title="Create your first zone"
        description="Zones are Caracal's primary trust boundary. Create one to manage applications, resources, providers, and policies."
        action={
          <Link to={appLink("/zones")}>
            <Button>Go to Zones</Button>
          </Link>
        }
      />,
    );
  }

  return <ConnectedDashboard zone={activeZone} />;
}

function ConnectedDashboard({ zone }: { zone: Zone }) {
  const overview = useZoneOverview(zone.id);
  const approvals = useApprovalCounts(zone.id);

  const frame = (body: ReactNode) => (
    <ModulePage
      title="Dashboard"
      description="Your zone's authority posture, recent activity, and setup at a glance."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Dashboard" }]}
    >
      {body}
    </ModulePage>
  );

  if (overview.isLoading) {
    return frame(<DashboardSkeleton />);
  }

  if (overview.isError || !overview.data) {
    return frame(
      <EmptyState
        title="Could not load this zone's overview"
        description="The Console could not reach the control plane. Check that the Caracal runtime is up, then try again."
        action={
          <Button variant="secondary" onClick={() => overview.refetch()}>
            Retry
          </Button>
        }
      />,
    );
  }

  const data = overview.data;

  return frame(
    <div className="space-y-6">
      <PostureStrip data={data} />

      <div className="grid border border-border lg:grid-cols-[minmax(0,1fr)_360px]">
        <ActivityFeed events={data.recent_events} />
        <div className="border-t border-border lg:border-l lg:border-t-0">
          <AttentionPanel items={buildAttention(data, approvals.data?.pending ?? 0)} />
          <InventoryPanel data={data} />
        </div>
      </div>
    </div>,
  );
}

/* ----------------------------- posture strip ----------------------------- */

function PostureStrip({ data }: { data: ZoneOverview }) {
  const enforcing = data.policy_sets.enforcing > 0;
  const hasProtectables = data.applications.total > 0 || data.resources.total > 0;
  const { allowed, denied } = data.decisions_24h;
  const activeSessions = data.sessions.active;
  const { expired, expiring_soon: expiring } = data.applications;
  const atRisk = expired + expiring;

  return (
    <section className="border border-border">
      <header className="border-b border-border px-5 py-3.5">
        <SectionLabel>Authority posture</SectionLabel>
      </header>
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4 [&>*]:bg-background">
        <PostureCell
          to={appLink("/policies")}
          label="Enforcement"
          value={enforcing ? "Enforcing" : "Default-deny"}
          tone={enforcing ? "ok" : hasProtectables ? "warn" : "muted"}
          sub={
            enforcing
              ? (data.policy_sets.active_name ?? "Active policy set")
              : hasProtectables
                ? "Secure default · activate a policy set to allow access"
                : "Secure default · nothing to enforce yet"
          }
        />
        <PostureCell
          to={appLink("/audit")}
          label="Denied (24h)"
          value={String(denied)}
          tone={denied > 0 ? "danger" : allowed > 0 ? "ok" : "muted"}
          sub={
            allowed + denied > 0
              ? `${allowed} allowed in the last 24 hours`
              : "No decisions in the last 24 hours"
          }
        />
        <PostureCell
          to={appLink("/subjects")}
          label="Active Subject authority records"
          value={String(activeSessions)}
          tone={activeSessions > 0 ? "ok" : "muted"}
          sub={activeSessions > 0 ? "Currently authenticated" : "None authenticated"}
        />
        <PostureCell
          to={appLink("/applications")}
          label="Credential health"
          value={String(atRisk)}
          tone={expired > 0 ? "danger" : atRisk > 0 ? "warn" : "ok"}
          sub={atRisk === 0 ? "All credentials valid" : `${expired} expired · ${expiring} expiring`}
        />
      </div>
    </section>
  );
}

function PostureCell({
  to,
  label,
  value,
  sub,
  tone,
}: {
  to: string;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}) {
  return (
    <Link to={to} className="group block p-5 transition-colors hover:bg-surface">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </span>
        <ToneDot tone={tone} />
      </div>
      <div className={cx("mt-3 text-2xl font-semibold tracking-tight", toneText(tone))}>
        {value}
      </div>
      <div className="mt-2 truncate text-xs text-muted-foreground">{sub}</div>
    </Link>
  );
}

/* ----------------------------- activity feed ----------------------------- */

function ActivityFeed({ events }: { events: OverviewEvent[] }) {
  return (
    <section className="flex h-[420px] flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <SectionLabel>Recent activity</SectionLabel>
        <Link
          to={appLink("/audit")}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View audit
        </Link>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex flex-1">
            <EmptyState
              bordered={false}
              title="No activity yet"
              description="Authority decisions and security events appear here as traffic flows through this zone."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((event) => {
              const context = auditEventContext(event);
              return (
                <li key={event.id}>
                  <Link
                    to={appLink("/audit")}
                    search={event.request_id ? { focus: event.request_id } : {}}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface"
                  >
                    <DecisionDot decision={event.decision} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {auditEventLabel(event.event_type)}
                        </span>
                        {event.decision ? (
                          <Badge tone={auditDecisionTone(event.decision)}>{event.decision}</Badge>
                        ) : null}
                      </div>
                      {context ? (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {context}
                        </span>
                      ) : null}
                    </div>
                    <time
                      dateTime={event.occurred_at}
                      className="flex-shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                    >
                      {relativeTime(event.occurred_at)}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------------------------- attention panel ---------------------------- */

interface AttentionItem {
  id: string;
  tone: "danger" | "warn" | "info";
  title: string;
  detail: string;
  to: string;
}

function buildAttention(data: ZoneOverview, pendingApprovals: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  const enforcing = data.policy_sets.enforcing > 0;
  const hasProtectables = data.applications.total > 0 || data.resources.total > 0;
  const { expired, expiring_soon: expiring } = data.applications;
  const denied = data.decisions_24h.denied;
  const unenforced = data.resources.unenforced;

  // Pending holds lead the list: a Session is parked on each one, so every
  // minute unnoticed is a minute of a human-visible stall.
  if (pendingApprovals > 0) {
    items.push({
      id: "approvals",
      tone: "warn",
      title: `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} awaiting a decision`,
      detail: "Sessions are parked on these holds until someone with authority decides.",
      to: appLink("/approvals"),
    });
  }

  // Default-deny with no active policy set is the secure baseline, not a failure. Only flag it
  // once the zone actually has applications or resources that requests cannot reach yet, and
  // as attention (amber), never an alarming error. A brand-new empty zone is guided by the
  // setup checklist instead.
  if (!enforcing && hasProtectables) {
    items.push({
      id: "deny-all",
      tone: "warn",
      title: "No policy set active",
      detail:
        "Requests deny by default until a policy set is activated. Activate one to allow access.",
      to: appLink("/policies"),
    });
  }
  if (expired > 0) {
    items.push({
      id: "expired",
      tone: "warn",
      title: `${expired} expired application${expired === 1 ? "" : "s"}`,
      detail: "Expired identities can no longer obtain authority. Rotate or remove them.",
      to: appLink("/applications"),
    });
  }
  if (denied > 0) {
    items.push({
      id: "denied",
      tone: "warn",
      title: `${denied} denied decision${denied === 1 ? "" : "s"} in the last 24 hours`,
      detail: "Review denials to confirm they are expected, not misconfiguration.",
      to: appLink("/audit"),
    });
  }
  if (data.providers.total === 0) {
    items.push({
      id: "provider",
      tone: "info",
      title: "No providers configured",
      detail: "Add a provider before applications can obtain upstream credentials.",
      to: appLink("/providers"),
    });
  }
  if (expiring > 0) {
    items.push({
      id: "expiring",
      tone: "info",
      title: `${expiring} application${expiring === 1 ? "" : "s"} expiring soon`,
      detail: "Credentials expire within 7 days. Plan rotation.",
      to: appLink("/applications"),
    });
  }
  if (unenforced > 0) {
    items.push({
      id: "unenforced",
      tone: "info",
      title: `${unenforced} resource${unenforced === 1 ? "" : "s"} without operation enforcement`,
      detail:
        "Authorization is uniform across the transport. Declare operations for finer control.",
      to: appLink("/resources"),
    });
  }
  return items;
}

function AttentionPanel({ items }: { items: AttentionItem[] }) {
  return (
    <section className="flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <SectionLabel>Requires attention</SectionLabel>
        {items.length > 0 ? (
          <span className="text-xs font-medium text-muted-foreground">{items.length}</span>
        ) : null}
      </header>

      {items.length === 0 ? (
        <div className="flex items-center gap-2.5 px-5 py-4 text-sm text-muted-foreground">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          All clear. No action required.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id}>
              <Link to={item.to} className="block px-5 py-3 transition-colors hover:bg-surface">
                <div className="flex items-start gap-2.5">
                  <ToneDot
                    tone={item.tone === "info" ? "muted" : item.tone === "warn" ? "warn" : "danger"}
                    className="mt-1.5"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{item.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{item.detail}</div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------- inventory panel ---------------------------- */

function InventoryPanel({ data }: { data: ZoneOverview }) {
  const rows = [
    { label: "Applications", value: data.applications.total, to: appLink("/applications") },
    { label: "Resources", value: data.resources.total, to: appLink("/resources") },
    { label: "Providers", value: data.providers.total, to: appLink("/providers") },
    { label: "Policy sets", value: data.policy_sets.total, to: appLink("/policies") },
  ];

  return (
    <section className="flex flex-col border-t border-border">
      <header className="border-b border-border px-5 py-3.5">
        <SectionLabel>Inventory</SectionLabel>
      </header>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.label}>
            <Link
              to={row.to}
              className="flex items-center justify-between gap-3 px-5 py-2.5 transition-colors hover:bg-surface"
            >
              <span className="text-sm text-muted-foreground">{row.label}</span>
              <span className="font-mono text-sm tabular-nums text-foreground">{row.value}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------- helpers -------------------------------- */

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Skeleton className="h-[420px] w-full" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    </div>
  );
}

function ToneDot({ tone, className }: { tone: Tone; className?: string }) {
  const color = {
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    danger: "bg-destructive",
    muted: "bg-muted-foreground/40",
  }[tone];
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block h-2 w-2 flex-shrink-0 rounded-full", color, className)}
    />
  );
}

function DecisionDot({ decision }: { decision: string | null }) {
  const tone = auditDecisionTone(decision);
  return <ToneDot tone={tone === "success" ? "ok" : tone === "danger" ? "danger" : "muted"} />;
}

function toneText(tone: Tone): string {
  return {
    ok: "text-foreground",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-destructive",
    muted: "text-muted-foreground",
  }[tone];
}

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return "-";
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
