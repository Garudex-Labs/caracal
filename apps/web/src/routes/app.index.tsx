/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Console dashboard overview route.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SectionLabel } from "@/components/SiteShell";
import { LiveBadge } from "@/components/console/LiveBadge";
import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { cx } from "@/lib/cx";
import {
  useActiveZone,
  useApplications,
  useAudit,
  useConsoleStatus,
  usePolicySets,
  useProviders,
  useResources,
  useSessions,
} from "@/platform/api/hooks";
import type { Application, AuditEvent, ConsoleStatus, Zone } from "@/platform/api/types";
import { workspaceLabel } from "@/platform/state/localInstall";

export const Route = createFileRoute("/app/")({
  component: DashboardPage,
});

type Connection = "connecting" | "not_configured" | "unreachable" | "connected";
type Tone = "ok" | "warn" | "danger" | "muted";

function connectionOf(
  status: ConsoleStatus | undefined,
  isLoading: boolean,
  isError: boolean,
): Connection {
  if (isLoading) return "connecting";
  if (isError || !status) return "unreachable";
  if (!status.configured) return "not_configured";
  if (!status.reachable) return "unreachable";
  return "connected";
}

function DashboardPage() {
  const workspace = workspaceLabel();
  const statusQuery = useConsoleStatus();
  const { zones, activeZone } = useActiveZone();

  const connection = connectionOf(statusQuery.data, statusQuery.isLoading, statusQuery.isError);

  const frame = (body: ReactNode, actions?: ReactNode) => (
    <ModulePage
      title="Dashboard"
      description={activeZone ? `${workspace} · ${activeZone.name}` : workspace}
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Dashboard" }]}
      actions={actions}
    >
      {body}
    </ModulePage>
  );

  if (connection === "connecting") {
    return frame(<DashboardSkeleton />);
  }

  if (connection === "not_configured") {
    return frame(
      <EmptyState
        title="Control plane not connected"
        description="No admin credentials were found. Start the local stack with `caracal up` to provision the control plane, then reload."
        action={<Button onClick={() => statusQuery.refetch()}>Check again</Button>}
      />,
    );
  }

  if (connection === "unreachable") {
    return frame(
      <EmptyState
        title="Control plane unreachable"
        description={`The control plane at ${statusQuery.data?.apiUrl ?? "the configured endpoint"} is not responding. Confirm the stack is running, then retry.`}
        action={<Button onClick={() => statusQuery.refetch()}>Retry</Button>}
      />,
    );
  }

  if (zones.length === 0 || !activeZone) {
    return frame(
      <EmptyState
        title="Create your first zone"
        description="Zones are Caracal's primary trust boundary. Create one to manage applications, resources, providers, and policies."
        action={
          <Link to="/app/zones">
            <Button>Go to Zones</Button>
          </Link>
        }
      />,
    );
  }

  return (
    <ConnectedDashboard
      zone={activeZone}
      refreshing={statusQuery.isFetching}
      onRefresh={() => statusQuery.refetch()}
    />
  );
}

function ConnectedDashboard({
  zone,
  refreshing,
  onRefresh,
}: {
  zone: Zone;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const workspace = workspaceLabel();
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
    providerCount: providerRows.length,
    providersLoading: providers.isLoading,
    expired,
    expiring,
    unenforcedResources,
    denied,
  });

  const setupComplete =
    zone && providerRows.length > 0 && policySetRows.some((ps) => ps.active_version_id);

  return (
    <ModulePage
      title="Dashboard"
      description={`${workspace} · ${zone.name}`}
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Dashboard" }]}
      actions={
        <div className="flex items-center gap-2">
          <LiveBadge label="Live" />
          <Button variant="secondary" size="sm" onClick={onRefresh} loading={refreshing}>
            Refresh
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        <PostureStrip
          loading={policySets.isLoading || sessions.isLoading || apps.isLoading}
          enforcing={enforcing}
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

        {!setupComplete ? (
          <SetupStrip
            hasProvider={providerRows.length > 0}
            hasPolicySet={policySetRows.some((ps) => ps.active_version_id)}
          />
        ) : null}
      </div>
    </ModulePage>
  );
}

/* ----------------------------- posture strip ----------------------------- */

function PostureStrip({
  loading,
  enforcing,
  activePolicySet,
  allowed,
  denied,
  activeSessions,
  atRisk,
  expired,
}: {
  loading: boolean;
  enforcing: boolean;
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
          to="/app/policy-sets"
          label="Enforcement"
          loading={loading}
          value={enforcing ? "Enforcing" : "Deny-all"}
          tone={enforcing ? "ok" : "danger"}
          sub={
            enforcing
              ? (activePolicySet ?? "Active policy set")
              : "No active policy set — requests deny"
          }
        />
        <PostureCell
          to="/app/audit"
          label="Denied (recent)"
          loading={loading}
          value={String(denied)}
          tone={denied > 0 ? "danger" : "ok"}
          sub={`${allowed} allowed`}
        />
        <PostureCell
          to="/app/sessions"
          label="Active sessions"
          loading={loading}
          value={String(activeSessions)}
          tone={activeSessions > 0 ? "ok" : "muted"}
          sub={activeSessions > 0 ? "Currently authenticated" : "None authenticated"}
        />
        <PostureCell
          to="/app/applications"
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
          to="/app/audit"
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
        <div className="flex flex-1 flex-col items-center justify-center px-5 py-12 text-center">
          <p className="text-sm font-medium text-foreground">No activity yet</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Authority decisions and security events appear here as traffic flows through this zone.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {recent.map((event) => (
            <li key={event.id}>
              <Link
                to="/app/audit"
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
  providerCount,
  providersLoading,
  expired,
  expiring,
  unenforcedResources,
  denied,
}: {
  enforcing: boolean;
  policySetsLoading: boolean;
  providerCount: number;
  providersLoading: boolean;
  expired: number;
  expiring: number;
  unenforcedResources: number;
  denied: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!enforcing && !policySetsLoading) {
    items.push({
      id: "deny-all",
      tone: "danger",
      title: "No active policy set",
      detail: "Every request in this zone denies by default. Activate a policy set.",
      to: "/app/policy-sets",
    });
  }
  if (expired > 0) {
    items.push({
      id: "expired",
      tone: "warn",
      title: `${expired} expired application${expired === 1 ? "" : "s"}`,
      detail: "Expired identities can no longer obtain authority. Rotate or remove them.",
      to: "/app/applications",
    });
  }
  if (denied > 0) {
    items.push({
      id: "denied",
      tone: "warn",
      title: `${denied} denied decision${denied === 1 ? "" : "s"} recently`,
      detail: "Review denials to confirm they are expected, not misconfiguration.",
      to: "/app/audit",
    });
  }
  if (providerCount === 0 && !providersLoading) {
    items.push({
      id: "provider",
      tone: "info",
      title: "No providers configured",
      detail: "Add a provider before applications can obtain upstream credentials.",
      to: "/app/providers",
    });
  }
  if (expiring > 0) {
    items.push({
      id: "expiring",
      tone: "info",
      title: `${expiring} application${expiring === 1 ? "" : "s"} expiring soon`,
      detail: "Credentials expire within 7 days. Plan rotation.",
      to: "/app/applications",
    });
  }
  if (unenforcedResources > 0) {
    items.push({
      id: "unenforced",
      tone: "info",
      title: `${unenforcedResources} resource${unenforcedResources === 1 ? "" : "s"} without operation enforcement`,
      detail:
        "Authorization is uniform across the transport. Declare operations for finer control.",
      to: "/app/resources",
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
          All clear — no action required.
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
    { label: "Applications", value: applications, to: "/app/applications" },
    { label: "Resources", value: resources, to: "/app/resources" },
    { label: "Providers", value: providers, to: "/app/providers" },
    { label: "Policy sets", value: policySets, to: "/app/policy-sets" },
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

/* ------------------------------- setup strip ------------------------------ */

function SetupStrip({
  hasProvider,
  hasPolicySet,
}: {
  hasProvider: boolean;
  hasPolicySet: boolean;
}) {
  const steps = [
    { label: "Create a zone", done: true, to: "/app/zones" },
    { label: "Add a provider", done: hasProvider, to: "/app/providers" },
    { label: "Activate a policy set", done: hasPolicySet, to: "/app/policy-sets" },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <section className="border border-border">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <SectionLabel>Finish setup</SectionLabel>
        <span className="text-xs font-medium text-muted-foreground">{done}/3 complete</span>
      </header>
      <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {steps.map((step) => (
          <Link
            key={step.label}
            to={step.to}
            className="flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-surface"
          >
            <span
              className={cx("text-sm", step.done ? "text-muted-foreground" : "text-foreground")}
            >
              {step.label}
            </span>
            {step.done ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
            ) : (
              <span className="text-xs font-medium text-foreground">Do this</span>
            )}
          </Link>
        ))}
      </div>
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
  if (Number.isNaN(diff)) return "—";
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
