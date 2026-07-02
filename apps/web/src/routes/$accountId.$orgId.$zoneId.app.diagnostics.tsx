/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Diagnostics route: the operational status page for the Caracal deployment.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { cx } from "@/lib/cx";
import {
  COMPONENT_ORDER,
  COMPONENTS,
  STATE_LABELS,
  checkTitle,
  componentOf,
  issuesOf,
  stateOf,
  zoneHealthOf,
  type ComponentKey,
  type ComponentState,
  type DiagnosticIssue,
  type ZoneHealth,
} from "@/platform/api/diagnosticsModel";
import { useDiagnostics, useZones } from "@/platform/api/hooks";
import { appLink } from "@/platform/nav/appLink";
import type { DiagnosticCheck, DiagnosticsReport } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/diagnostics")({
  component: DiagnosticsPage,
});

function DiagnosticsPage() {
  const { zoneId: activeZoneId } = Route.useParams();
  const zones = useZones();
  const diagnostics = useDiagnostics();
  const report = diagnostics.data;

  const zoneNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const zone of zones.data ?? []) map.set(zone.id, zone.name);
    return map;
  }, [zones.data]);

  return (
    <ModulePage
      title="Diagnostics"
      description="Operational status of your Caracal deployment: platform components, dependencies, and every zone you own."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Diagnostics" }]}
      actions={<SyncIndicator report={report} fetching={diagnostics.isFetching} />}
    >
      {diagnostics.isLoading ? (
        <LoadingState />
      ) : diagnostics.isError || !report ? (
        <UnavailableState
          retrying={diagnostics.isFetching}
          onRetry={() => void diagnostics.refetch()}
        />
      ) : (
        <StatusConsole
          report={report}
          zoneNames={zoneNames}
          activeZoneId={activeZoneId}
          rechecking={diagnostics.isFetching}
          onRecheck={() => void diagnostics.refetch()}
        />
      )}
    </ModulePage>
  );
}

function StatusConsole({
  report,
  zoneNames,
  activeZoneId,
  rechecking,
  onRecheck,
}: {
  report: DiagnosticsReport;
  zoneNames: Map<string, string>;
  activeZoneId: string;
  rechecking: boolean;
  onRecheck: () => void;
}) {
  const issues = useMemo(() => issuesOf(report, zoneNames), [report, zoneNames]);
  const componentChecks = useMemo(() => {
    const map = new Map<ComponentKey, DiagnosticCheck[]>();
    for (const key of COMPONENT_ORDER) map.set(key, []);
    for (const check of report.checks) {
      const key = componentOf(check);
      if (key) map.get(key)?.push(check);
    }
    return map;
  }, [report.checks]);
  const zoneHealth = useMemo(() => zoneHealthOf(report), [report]);

  return (
    <div className="space-y-5">
      <StatusBanner report={report} rechecking={rechecking} onRecheck={onRecheck} />
      {issues.length > 0 ? <IssuesPanel issues={issues} /> : null}
      <section aria-labelledby="diag-components">
        <SectionHeader
          id="diag-components"
          title="Platform components"
          hint="Shared services every zone depends on."
        />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {COMPONENT_ORDER.map((key) => (
            <ComponentCard key={key} component={key} checks={componentChecks.get(key) ?? []} />
          ))}
        </div>
      </section>
      <section aria-labelledby="diag-zones">
        <SectionHeader
          id="diag-zones"
          title="Zone health"
          hint="Lookup, resources, policy enforcement, and audit for each of your zones."
        />
        <ZoneHealthPanel
          zones={zoneHealth.zones}
          inventory={zoneHealth.inventory}
          zoneNames={zoneNames}
          activeZoneId={activeZoneId}
        />
      </section>
    </div>
  );
}

/* --------------------------------- banner --------------------------------- */

function overallState(report: DiagnosticsReport): ComponentState {
  return stateOf(report.checks);
}

const BANNER_COPY: Record<ComponentState, { headline: string; tone: string; dot: string }> = {
  operational: {
    headline: "All systems operational",
    tone: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  degraded: {
    headline: "Degraded - attention recommended",
    tone: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  outage: {
    headline: "Component outage detected",
    tone: "text-destructive",
    dot: "bg-destructive",
  },
  unknown: {
    headline: "Checking platform…",
    tone: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};

function bannerSubline(report: DiagnosticsReport): string {
  const { fail, warn, ok } = report.summary;
  if (fail > 0) {
    const degraded = warn > 0 ? `, ${warn} degraded` : "";
    return `${fail} check${fail === 1 ? "" : "s"} failing${degraded}. Review the issues below.`;
  }
  if (warn > 0) {
    return `${warn} check${warn === 1 ? "" : "s"} degraded. The platform is serving, but review the issues below.`;
  }
  return `All ${ok} checks passing across platform components and your zones.`;
}

function StatusBanner({
  report,
  rechecking,
  onRecheck,
}: {
  report: DiagnosticsReport;
  rechecking: boolean;
  onRecheck: () => void;
}) {
  const state = overallState(report);
  const copy = BANNER_COPY[state];
  const { summary } = report;
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-border bg-muted/30 px-5 py-4">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
          {state !== "operational" && state !== "unknown" ? (
            <span
              className={cx(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-50",
                copy.dot,
              )}
            />
          ) : null}
          <span className={cx("relative inline-flex h-3 w-3 rounded-full", copy.dot)} />
        </span>
        <div className="min-w-0">
          <h2 className={cx("text-base font-semibold tracking-tight", copy.tone)}>
            {copy.headline}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{bannerSubline(report)}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-1.5" aria-label="Check totals">
          {summary.fail > 0 ? <Badge tone="danger">{summary.fail} failing</Badge> : null}
          {summary.warn > 0 ? <Badge tone="warning">{summary.warn} degraded</Badge> : null}
          <Badge tone={summary.fail === 0 && summary.warn === 0 ? "success" : "muted"}>
            {summary.ok} / {summary.total} passing
          </Badge>
        </div>
        <Button size="sm" variant="secondary" loading={rechecking} onClick={onRecheck}>
          Run checks
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------- issues --------------------------------- */

function IssuesPanel({ issues }: { issues: DiagnosticIssue[] }) {
  return (
    <section aria-labelledby="diag-issues" className="border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <div>
          <h2 id="diag-issues" className="text-sm font-semibold text-foreground">
            Needs attention
          </h2>
          <p className="text-xs text-muted-foreground">
            What failed, why it matters, and how to recover - most severe first.
          </p>
        </div>
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
          {issues.length}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {issues.map((issue, index) => (
          <IssueRow key={`${issue.title}:${index}`} issue={issue} />
        ))}
      </ul>
    </section>
  );
}

function IssueRow({ issue }: { issue: DiagnosticIssue }) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={issue.severity === "critical" ? "danger" : "warning"}>
          {issue.severity === "critical" ? "Critical" : "Warning"}
        </Badge>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{issue.title}</span>
      </div>
      <p className="mt-1.5 wrap-break-word font-mono text-xs text-muted-foreground">
        {issue.explanation}
      </p>
      {issue.impact ? (
        <p className="mt-1.5 text-xs text-foreground">
          <span className="font-medium">Impact:</span> {issue.impact}
        </p>
      ) : null}
      {issue.guidance ? (
        <p className="mt-1.5 text-xs text-foreground">
          <span className="font-medium">Recovery:</span> {issue.guidance}
        </p>
      ) : null}
      {issue.link ? (
        <Link
          to={appLink(issue.link.sub, issue.link.zoneId)}
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {issue.link.label}
          <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </li>
  );
}

/* ------------------------------- components ------------------------------- */

const STATE_BADGE_TONE: Record<ComponentState, "success" | "warning" | "danger" | "muted"> = {
  operational: "success",
  degraded: "warning",
  outage: "danger",
  unknown: "muted",
};

function ComponentCard({
  component,
  checks,
}: {
  component: ComponentKey;
  checks: DiagnosticCheck[];
}) {
  const meta = COMPONENTS[component];
  const state = stateOf(checks);
  return (
    <div className="flex flex-col border border-border">
      <div className="flex items-start justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{meta.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{meta.purpose}</p>
        </div>
        <Badge tone={STATE_BADGE_TONE[state]}>{STATE_LABELS[state]}</Badge>
      </div>
      {checks.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">No checks reported.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {checks.map((check, index) => (
            <CheckRow key={`${check.check}:${index}`} check={check} />
          ))}
        </ul>
      )}
    </div>
  );
}

const CHECK_DOT: Record<DiagnosticCheck["status"], { cls: string; label: string }> = {
  ok: { cls: "bg-emerald-500", label: "passing" },
  warn: { cls: "bg-amber-500", label: "degraded" },
  fail: { cls: "bg-destructive", label: "failing" },
};

function CheckRow({ check }: { check: DiagnosticCheck }) {
  const dot = CHECK_DOT[check.status];
  return (
    <li
      className={cx(
        "flex items-baseline gap-2.5 px-4 py-2",
        check.status === "fail" && "bg-destructive/4",
      )}
    >
      <span
        role="img"
        aria-label={dot.label}
        className={cx("h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full", dot.cls)}
      />
      <span className="shrink-0 text-xs font-medium text-foreground">{checkTitle(check)}</span>
      <span
        className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground"
        title={check.detail}
      >
        {check.detail}
      </span>
    </li>
  );
}

/* --------------------------------- zones ---------------------------------- */

function ZoneHealthPanel({
  zones,
  inventory,
  zoneNames,
  activeZoneId,
}: {
  zones: ZoneHealth[];
  inventory: DiagnosticCheck | undefined;
  zoneNames: Map<string, string>;
  activeZoneId: string;
}) {
  const ordered = useMemo(
    () =>
      [...zones].sort((a, b) => {
        if (a.zoneId === activeZoneId) return -1;
        if (b.zoneId === activeZoneId) return 1;
        return (zoneNames.get(a.zoneId) ?? a.zoneId).localeCompare(
          zoneNames.get(b.zoneId) ?? b.zoneId,
        );
      }),
    [zones, activeZoneId, zoneNames],
  );

  if (ordered.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border border-dashed border-border px-4 py-4">
        <p className="text-sm text-muted-foreground">
          {inventory?.detail ?? "No zone checks were reported."}
        </p>
        <Link
          to={appLink("/zones")}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Create a zone
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border border border-border">
      {ordered.map((zone) => (
        <ZoneRow
          key={zone.zoneId}
          zone={zone}
          name={zoneNames.get(zone.zoneId) ?? zone.zoneId}
          current={zone.zoneId === activeZoneId}
        />
      ))}
    </div>
  );
}

function ZoneRow({ zone, name, current }: { zone: ZoneHealth; name: string; current: boolean }) {
  const [open, setOpen] = useState(current || zone.state !== "operational");
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
      >
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
        {current ? <Badge tone="neutral">Current zone</Badge> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Badge tone={STATE_BADGE_TONE[zone.state]}>{STATE_LABELS[zone.state]}</Badge>
          <Chevron open={open} />
        </span>
      </button>
      {open ? (
        <ul className="divide-y divide-border/60 border-t border-border/60 bg-muted/20">
          {zone.checks.map((check, index) => (
            <CheckRow key={`${check.check}:${index}`} check={check} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* --------------------------------- states --------------------------------- */

function LoadingState() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function UnavailableState({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <EmptyState
      title="Diagnostics unavailable"
      description="The control plane is not connected or did not respond. Start the local stack with `caracal up` and confirm admin credentials are provisioned; this view recovers automatically."
      action={
        <Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>
          Retry now
        </Button>
      }
    />
  );
}

/* -------------------------------- partials -------------------------------- */

function SectionHeader({ id, title, hint }: { id: string; title: string; hint: string }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h2>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function SyncIndicator({
  report,
  fetching,
}: {
  report: DiagnosticsReport | undefined;
  fetching: boolean;
}) {
  const relative = useRelativeTime(report?.generatedAt);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        {fetching ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
        ) : null}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      {fetching ? "Syncing…" : report ? `Updated ${relative}` : "Live"}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function useRelativeTime(iso: string | undefined): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 5_000);
    return () => clearInterval(timer);
  }, []);
  if (!iso) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
