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
import { cx } from "@/lib/cx";
import {
  useActiveZone,
  useApplications,
  useAudit,
  usePolicySets,
  useProviders,
  useResources,
  useSessions,
  useZones,
} from "@/platform/api/hooks";
import type { Application, AuditEvent, Zone } from "@/platform/api/types";

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
  const zoneId = zone.id;

  const apps = useApplications(zoneId);
  const resources = useResources(zoneId);
  const providers = useProviders(zoneId);
  const policySets = usePolicySets(zoneId);
  const sessions = useSessions(zoneId);
  const audit = useAudit(zoneId);

  const appRows = apps.data ?? [];
  const resourceRows = resources.data ?? [];
  const providerRows = providers.data ?? [];
  const policySetRows = policySets.data ?? [];
  const sessionRows = sessions.data ?? [];
  const auditRows = [...(audit.data ?? [])].sort(
    (a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at),
  );

  const enforcing = policySetRows.some((ps) => ps.active_version_id);
  const activeSessions = sessionRows.filter((s) => s.status === "active").length;
  const expired = appRows.filter(isExpired).length;
  const expiring = appRows.filter(isExpiring).length;
  const atRisk = expired + expiring;
  const unenforcedResources = resourceRows.filter(
    (r) => r.operation_enforcement !== "enforced",
  ).length;

  const decided = auditRows.filter((e) => e.decision);
  const denied = decided.filter((e) => e.decision === "deny").length;
  const allowed = decided.filter((e) => e.decision === "allow").length;

  const attention = buildAttention({
    enforcing,
    policySetsLoading: policySets.isLoading,
    hasProtectables: appRows.length > 0 || resourceRows.length > 0,
    providerCount: providerRows.length,
    providersLoading: providers.isLoading,
    expired,
    expiring,
    unenforcedResources,
    denied,
  });

  return (
    <ModulePage
      title="Dashboard"
      description="Your zone's authority posture, recent activity, and setup at a glance."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Dashboard" }]}
    >
      <div className="space-y-6">
        <PostureStrip
          loading={policySets.isLoading || sessions.isLoading || apps.isLoading}
          enforcing={enforcing}
          hasProtectables={appRows.length > 0 || resourceRows.length > 0}
          activePolicySet={activePolicySetName(policySetRows)}
          allowed={allowed}
          denied={denied}
          activeSessions={activeSessions}
          atRisk={atRisk}
          expired={expired}
        />

        <div className="grid border border-border lg:grid-cols-[minmax(0,1fr)_360px]">
          <ActivityFeed loading={audit.isLoading} error={audit.isError} events={auditRows} />
          <div className="border-t border-border lg:border-l lg:border-t-0">
            <AttentionPanel
              loading={policySets.isLoading || providers.isLoading}
              items={attention}
            />
            <InventoryPanel
              loading={apps.isLoading || resources.isLoading}
              applications={appRows.length}
              resources={resourceRows.length}
              providers={providerRows.length}
              policySets={policySetRows.length}
            />
          </div>
        </div>
      </div>
    </ModulePage>
  );
}

/* ----------------------------- posture strip ----------------------------- */

function PostureStrip({
  loading,
  enforcing,
  hasProtectables,
  activePolicySet,
  allowed,
  denied,
  activeSessions,
  atRisk,
  expired,
}: {
  loading: boolean;
  enforcing: boolean;
  hasProtectables: boolean;
  activePolicySet: string | null;
  allowed: number;
  denied: number;
  activeSessions: number;
  atRisk: number;
  expired: number;
}) {
  return (
    <section className="border border-border">
      <header className="border-b border-border px-5 py-3.5">
        <SectionLabel>Authority posture</SectionLabel>
      </header>
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4 [&>*]:bg-background">
        <PostureCell
          to={appLink("/policy-sets")}
          label="Enforcement"
          loading={loading}
          value={enforcing ? "Enforcing" : "Default-deny"}
          tone={enforcing ? "ok" : hasProtectables ? "warn" : "muted"}
          sub={
            enforcing
              ? (activePolicySet ?? "Active policy set")
              : hasProtectables
                ? "Secure default · activate a policy set to allow access"
                : "Secure default · nothing to enforce yet"
          }
        />
        <PostureCell
          to={appLink("/audit")}
          label="Denied (recent)"
          loading={loading}
          value={String(denied)}
          tone={denied > 0 ? "danger" : "ok"}
          sub={`${allowed} allowed`}
        />
        <PostureCell
          to={appLink("/sessions")}
          label="Active sessions"
          loading={loading}
          value={String(activeSessions)}
          tone={activeSessions > 0 ? "ok" : "muted"}
          sub={activeSessions > 0 ? "Currently authenticated" : "None authenticated"}
        />
        <PostureCell
          to={appLink("/applications")}
          label="At-risk identities"
          loading={loading}
          value={String(atRisk)}
          tone={atRisk > 0 ? "warn" : "ok"}
          sub={
            atRisk === 0
              ? "All credentials valid"
              : `${expired} expired · ${atRisk - expired} expiring`
          }
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
  loading,
}: {
  to: string;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
  loading: boolean;
}) {
  return (
    <Link to={to} className="group block p-5 transition-colors hover:bg-surface">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </span>
        <ToneDot tone={tone} />
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-24" />
      ) : (
        <div className={cx("mt-3 text-2xl font-semibold tracking-tight", toneText(tone))}>
          {value}
        </div>
      )}
      <div className="mt-2 truncate text-xs text-muted-foreground">{sub}</div>
    </Link>
  );
}

/* ----------------------------- activity feed ----------------------------- */

function ActivityFeed({
  loading,
  error,
  events,
}: {
  loading: boolean;
  error: boolean;
  events: AuditEvent[];
}) {
  const recent = events.slice(0, 9);

  return (
    <section className="flex min-h-[420px] flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <SectionLabel>Recent activity</SectionLabel>
        <Link
          to={appLink("/audit")}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View audit
        </Link>
      </header>

      {loading ? (
        <div className="flex flex-col gap-2 p-5">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <p className="p-5 text-sm text-muted-foreground">
          Audit activity is unavailable right now.
        </p>
      ) : recent.length === 0 ? (
        <div className="flex flex-1">
          <EmptyState
            bordered={false}
            title="No activity yet"
            description="Authority decisions and security events appear here as traffic flows through this zone."
          />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {recent.map((event) => (
            <li key={event.id}>
              <Link
                to={appLink("/audit")}
                className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface"
              >
                <DecisionDot decision={event.decision} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {event.event_type}
                    </span>
                    {event.decision ? (
                      <Badge tone={decisionTone(event.decision)}>{event.decision}</Badge>
                    ) : null}
                  </div>
                  {event.request_id ? (
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                      {event.request_id}
                    </span>
                  ) : null}
                </div>
                <span className="flex-shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                  {relativeTime(event.occurred_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
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

function buildAttention({
  enforcing,
  policySetsLoading,
  hasProtectables,
  providerCount,
  providersLoading,
  expired,
  expiring,
  unenforcedResources,
  denied,
}: {
  enforcing: boolean;
  policySetsLoading: boolean;
  hasProtectables: boolean;
  providerCount: number;
  providersLoading: boolean;
  expired: number;
  expiring: number;
  unenforcedResources: number;
  denied: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  // Default-deny with no active policy set is the secure baseline, not a failure. Only flag it
  // once the zone actually has applications or resources that requests cannot reach yet, and
  // as attention (amber), never an alarming error. A brand-new empty zone is guided by the
  // setup checklist instead.
  if (!enforcing && !policySetsLoading && hasProtectables) {
    items.push({
      id: "deny-all",
      tone: "warn",
      title: "No policy set active",
      detail:
        "Requests deny by default until a policy set is activated. Activate one to allow access.",
      to: appLink("/policy-sets"),
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
      title: `${denied} denied decision${denied === 1 ? "" : "s"} recently`,
      detail: "Review denials to confirm they are expected, not misconfiguration.",
      to: appLink("/audit"),
    });
  }
  if (providerCount === 0 && !providersLoading) {
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
  if (unenforcedResources > 0) {
    items.push({
      id: "unenforced",
      tone: "info",
      title: `${unenforcedResources} resource${unenforcedResources === 1 ? "" : "s"} without operation enforcement`,
      detail:
        "Authorization is uniform across the transport. Declare operations for finer control.",
      to: appLink("/resources"),
    });
  }
  return items;
}

function AttentionPanel({ loading, items }: { loading: boolean; items: AttentionItem[] }) {
  return (
    <section className="flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <SectionLabel>Requires attention</SectionLabel>
        {!loading && items.length > 0 ? (
          <span className="text-xs font-medium text-muted-foreground">{items.length}</span>
        ) : null}
      </header>

      {loading ? (
        <div className="p-5">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-2.5 px-5 py-4 text-sm text-muted-foreground">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
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

function InventoryPanel({
  loading,
  applications,
  resources,
  providers,
  policySets,
}: {
  loading: boolean;
  applications: number;
  resources: number;
  providers: number;
  policySets: number;
}) {
  const rows = [
    { label: "Applications", value: applications, to: appLink("/applications") },
    { label: "Resources", value: resources, to: appLink("/resources") },
    { label: "Providers", value: providers, to: appLink("/providers") },
    { label: "Policy sets", value: policySets, to: appLink("/policy-sets") },
  ];

  return (
    <section className="flex flex-col border-t border-border">
      <header className="border-b border-border px-5 py-3.5">
        <SectionLabel>Inventory</SectionLabel>
      </header>
      {loading ? (
        <div className="p-5">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
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
      )}
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
    <span className={cx("inline-block h-2 w-2 flex-shrink-0 rounded-full", color, className)} />
  );
}

function DecisionDot({ decision }: { decision: string | null }) {
  return (
    <ToneDot
      tone={
        decisionTone(decision) === "success"
          ? "ok"
          : decisionTone(decision) === "danger"
            ? "danger"
            : decisionTone(decision) === "warning"
              ? "warn"
              : "muted"
      }
    />
  );
}

function toneText(tone: Tone): string {
  return {
    ok: "text-foreground",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-destructive",
    muted: "text-muted-foreground",
  }[tone];
}

function decisionTone(decision: string | null): "success" | "danger" | "warning" | "muted" {
  if (decision === "allow") return "success";
  if (decision === "deny") return "danger";
  if (decision === "partial") return "warning";
  return "muted";
}

function isExpired(app: Application): boolean {
  return Boolean(app.expires_at && Date.parse(app.expires_at) < Date.now());
}

function isExpiring(app: Application): boolean {
  if (!app.expires_at) return false;
  const at = Date.parse(app.expires_at);
  const now = Date.now();
  return at >= now && at < now + 7 * 24 * 60 * 60 * 1000;
}

function activePolicySetName(
  policySets: { name: string; active_version_id: string | null }[],
): string | null {
  const active = policySets.find((ps) => ps.active_version_id);
  return active ? active.name : null;
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
