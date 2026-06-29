/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Diagnostics operations console: the single source of truth for platform health.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Badge, EmptyState, Skeleton } from "@/components/ui";
import { cx } from "@/lib/cx";
import {
  diagnosticSeverityRank,
  platformHealthOf,
  useDiagnostics,
  useZones,
  type PlatformHealth,
} from "@/platform/api/hooks";
import type {
  DiagnosticCheck,
  DiagnosticSection,
  DiagnosticStatus,
  DiagnosticsReport,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/diagnostics")({
  component: DiagnosticsPage,
});

const SECTION_ORDER: DiagnosticSection[] = ["health", "readiness", "zones", "preflight"];
const SECTION_LABELS: Record<DiagnosticSection, string> = {
  health: "System health",
  readiness: "Service readiness",
  zones: "Zone diagnostics",
  preflight: "Local preflight",
};
const SECTION_HINTS: Record<DiagnosticSection, string> = {
  health: "Control-plane reachability, admin authority, and clock integrity.",
  readiness: "Per-service readiness and metrics for the authority, audit, and coordinator planes.",
  zones: "Per-zone lookup, resources, policy enforcement, and audit pipeline.",
  preflight: "Local runtime configuration and environment checks.",
};

function DiagnosticsPage() {
  const [mode, setMode] = useState<"system" | "preflight">("system");
  const [strict, setStrict] = useState(false);
  const [zoneScope, setZoneScope] = useState<string>("all");
  const zones = useZones();
  const diagnostics = useDiagnostics({
    preflight: mode === "preflight",
    strict,
    zoneId: mode === "system" && zoneScope !== "all" ? zoneScope : undefined,
  });
  const report = diagnostics.data;

  const zoneNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const zone of zones.data ?? []) map.set(zone.id, zone.name);
    return map;
  }, [zones.data]);

  return (
    <ModulePage
      title="Diagnostics"
      description="Live operational health of the Caracal control plane: services, authority, policy, zones, and runtime."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Diagnostics" }]}
      actions={<SyncIndicator report={report} fetching={diagnostics.isFetching} />}
    >
      <DiagnosticsControls
        mode={mode}
        strict={strict}
        zoneScope={zoneScope}
        zones={zones.data ?? []}
        onMode={setMode}
        onStrict={setStrict}
        onZoneScope={setZoneScope}
      />
      {diagnostics.isLoading ? (
        <LoadingState />
      ) : diagnostics.isError || !report ? (
        <UnavailableState />
      ) : (
        <DiagnosticsConsole report={report} zoneNames={zoneNames} />
      )}
    </ModulePage>
  );
}

// Operator controls mirroring the Console doctor: switch between a full system check and
// a local preflight, gate readiness on strict mode, and narrow zone diagnostics to one
// zone for fast, targeted runs.
function DiagnosticsControls({
  mode,
  strict,
  zoneScope,
  zones,
  onMode,
  onStrict,
  onZoneScope,
}: {
  mode: "system" | "preflight";
  strict: boolean;
  zoneScope: string;
  zones: { id: string; name: string }[];
  onMode: (mode: "system" | "preflight") => void;
  onStrict: (strict: boolean) => void;
  onZoneScope: (zoneId: string) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 border border-border bg-muted/20 px-3 py-2.5">
      <div className="inline-flex overflow-hidden border border-border">
        {(["system", "preflight"] as const).map((value) => (
          <button
            key={value}
            onClick={() => onMode(value)}
            className={cx(
              "px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              mode === value
                ? "bg-foreground text-background"
                : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {value === "system" ? "System check" : "Preflight"}
          </button>
        ))}
      </div>

      {mode === "system" ? (
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span>Zone scope</span>
          <select
            value={zoneScope}
            onChange={(e) => onZoneScope(e.target.value)}
            className="h-8 border border-border bg-background px-2 text-xs text-foreground"
          >
            <option value="all">All zones</option>
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="text-xs text-muted-foreground">
          Local runtime and environment checks only.
        </span>
      )}

      <button
        onClick={() => onStrict(!strict)}
        className={cx(
          "ml-auto inline-flex items-center gap-2 border px-3 py-1.5 text-xs font-medium transition-colors",
          strict
            ? "border-foreground bg-foreground text-background"
            : "border-border text-muted-foreground hover:text-foreground",
        )}
        title="Strict mode treats warnings as not-ready, matching CI readiness gates."
      >
        <span
          className={cx(
            "inline-block h-2 w-2 rounded-full",
            strict ? "bg-background" : "bg-muted-foreground",
          )}
        />
        Strict readiness
      </button>
    </div>
  );
}

function DiagnosticsConsole({
  report,
  zoneNames,
}: {
  report: DiagnosticsReport;
  zoneNames: Map<string, string>;
}) {
  const health = platformHealthOf(report);
  const attention = useMemo(
    () =>
      report.checks
        .filter((check) => check.status !== "ok")
        .sort((a, b) => diagnosticSeverityRank(a.status) - diagnosticSeverityRank(b.status)),
    [report.checks],
  );
  const actions = useMemo(() => uniqueAdvice(attention), [attention]);

  return (
    <div className="space-y-5">
      <OverviewBar report={report} health={health} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <AttentionPanel checks={attention} zoneNames={zoneNames} health={health} />
        <ActionsPanel actions={actions} health={health} />
      </div>

      <div className="space-y-5">
        {SECTION_ORDER.map((section) => {
          const checks = report.checks.filter((check) => check.section === section);
          if (checks.length === 0) return null;
          return (
            <SectionTable key={section} section={section} checks={checks} zoneNames={zoneNames} />
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------- overview -------------------------------- */

function OverviewBar({ report, health }: { report: DiagnosticsReport; health: PlatformHealth }) {
  const { summary, context } = report;
  return (
    <div className="border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-3">
          <HealthDot health={health} large />
          <div>
            <div className="text-sm font-semibold text-foreground">{healthHeadline(health)}</div>
            <div className="text-xs text-muted-foreground">{healthSubline(report)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={report.ready ? "success" : "danger"}>
            {report.ready ? "Ready" : "Not ready"}
          </Badge>
          <Badge tone="muted">{report.mode === "system" ? "System check" : "Preflight"}</Badge>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6 [&>*]:bg-background">
        <Metric label="Failing" value={summary.fail} tone={summary.fail > 0 ? "fail" : undefined} />
        <Metric
          label="Warnings"
          value={summary.warn}
          tone={summary.warn > 0 ? "warn" : undefined}
        />
        <Metric label="Passing" value={summary.ok} />
        <Metric label="Checks" value={summary.total} />
        <Metric
          label="Zone scope"
          text={zoneScopeText(context.zoneScope, context.zoneIds.length)}
        />
        <Metric label="Admin API" text={context.apiUrl} mono />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  text,
  tone,
  mono = false,
}: {
  label: string;
  value?: number;
  text?: string;
  tone?: "fail" | "warn";
  mono?: boolean;
}) {
  const color =
    tone === "fail"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      {value !== undefined ? (
        <div className={cx("mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", color)}>
          {value}
        </div>
      ) : (
        <div
          className={cx("mt-1.5 truncate text-sm font-medium", color, mono && "font-mono text-xs")}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- attention -------------------------------- */

function AttentionPanel({
  checks,
  zoneNames,
  health,
}: {
  checks: DiagnosticCheck[];
  zoneNames: Map<string, string>;
  health: PlatformHealth;
}) {
  return (
    <div className="border border-border">
      <PanelHeader
        title="Needs attention"
        hint="Failing and degraded checks, most severe first."
        count={checks.length}
      />
      {checks.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-6">
          <HealthDot health={health} />
          <p className="text-sm text-muted-foreground">
            Every check is passing. No failing or degraded components.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {checks.map((check, index) => (
            <AttentionRow
              key={`${check.section}:${check.check}:${index}`}
              check={check}
              zoneNames={zoneNames}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttentionRow({
  check,
  zoneNames,
}: {
  check: DiagnosticCheck;
  zoneNames: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const hasAdvice = Boolean(check.advice);
  return (
    <li>
      <button
        onClick={() => hasAdvice && setOpen((v) => !v)}
        className={cx(
          "flex w-full items-start gap-3 px-4 py-3 text-left",
          hasAdvice && "hover:bg-accent/50",
        )}
      >
        <StatusDot status={check.status} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {humanizeCheck(check, zoneNames)}
            </span>
            <SectionTag section={check.section} />
          </div>
          <p className="mt-0.5 break-words text-xs text-muted-foreground">{check.detail}</p>
          {open && check.advice ? (
            <div className="mt-2 border-l-2 border-border pl-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Recovery
              </div>
              <p className="mt-1 break-words text-xs text-foreground">{check.advice}</p>
            </div>
          ) : null}
        </div>
        {hasAdvice ? <Chevron open={open} /> : null}
      </button>
    </li>
  );
}

function ActionsPanel({ actions, health }: { actions: string[]; health: PlatformHealth }) {
  return (
    <div className="border border-border">
      <PanelHeader title="Recommended actions" hint="Deduplicated recovery guidance." />
      {actions.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {health === "healthy"
            ? "Nothing to do. The control plane is operating normally."
            : "No specific guidance available for the current findings."}
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {actions.map((action, index) => (
            <li key={index} className="flex gap-3 px-4 py-3">
              <span className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <p className="break-words text-xs text-foreground">{action}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* -------------------------------- sections -------------------------------- */

function SectionTable({
  section,
  checks,
  zoneNames,
}: {
  section: DiagnosticSection;
  checks: DiagnosticCheck[];
  zoneNames: Map<string, string>;
}) {
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  return (
    <div className="border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{SECTION_LABELS[section]}</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {SECTION_HINTS[section]}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {fail > 0 ? <Badge tone="danger">{fail} fail</Badge> : null}
          {warn > 0 ? <Badge tone="warning">{warn} warn</Badge> : null}
          {fail === 0 && warn === 0 ? <Badge tone="success">All clear</Badge> : null}
          <span className="ml-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {checks.length}
          </span>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {checks.map((check, index) => (
          <CheckRow key={`${check.check}:${index}`} check={check} zoneNames={zoneNames} />
        ))}
      </ul>
    </div>
  );
}

function CheckRow({
  check,
  zoneNames,
}: {
  check: DiagnosticCheck;
  zoneNames: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const hasAdvice = Boolean(check.advice);
  return (
    <li>
      <button
        onClick={() => hasAdvice && setOpen((v) => !v)}
        className={cx(
          "flex w-full items-center gap-3 px-4 py-2.5 text-left",
          hasAdvice && "hover:bg-accent/50",
        )}
      >
        <StatusPill status={check.status} />
        <span className="w-56 flex-shrink-0 truncate font-mono text-xs text-foreground">
          {humanizeCheck(check, zoneNames)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {check.detail}
        </span>
        {hasAdvice ? <Chevron open={open} /> : <span className="w-3.5 flex-shrink-0" />}
      </button>
      {open && check.advice ? (
        <div className="border-t border-border bg-muted/30 px-4 py-2.5 pl-[4.25rem]">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Recovery
          </span>
          <p className="mt-1 break-words text-xs text-foreground">{check.advice}</p>
        </div>
      ) : null}
    </li>
  );
}

/* --------------------------------- states --------------------------------- */

function LoadingState() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function UnavailableState() {
  return (
    <EmptyState
      title="Diagnostics unavailable"
      description="The control plane is not connected or did not respond. Start the local stack with `caracal up`, confirm admin credentials are provisioned, then this view recovers automatically."
    />
  );
}

/* -------------------------------- partials -------------------------------- */

function PanelHeader({ title, hint, count }: { title: string; hint: string; count?: number }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {count !== undefined && count > 0 ? (
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
          {count}
        </span>
      ) : null}
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
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className="relative flex h-2 w-2">
        {fetching ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
        ) : null}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      {fetching ? "Syncing…" : report ? `Updated ${relative}` : "Live"}
    </span>
  );
}

function StatusDot({ status, className }: { status: DiagnosticStatus; className?: string }) {
  const tone =
    status === "fail" ? "bg-destructive" : status === "warn" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <span className={cx("inline-block h-2 w-2 flex-shrink-0 rounded-full", tone, className)} />
  );
}

function StatusPill({ status }: { status: DiagnosticStatus }) {
  const map: Record<DiagnosticStatus, { label: string; cls: string }> = {
    ok: { label: "ok", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
    warn: { label: "warn", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
    fail: { label: "fail", cls: "bg-destructive/15 text-destructive" },
  };
  const entry = map[status];
  return (
    <span
      className={cx(
        "inline-flex w-12 flex-shrink-0 justify-center rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide",
        entry.cls,
      )}
    >
      {entry.label}
    </span>
  );
}

function HealthDot({ health, large = false }: { health: PlatformHealth; large?: boolean }) {
  const tone =
    health === "unhealthy"
      ? "bg-destructive"
      : health === "attention"
        ? "bg-amber-500"
        : health === "healthy"
          ? "bg-emerald-500"
          : "bg-muted-foreground";
  const size = large ? "h-3 w-3" : "h-2.5 w-2.5";
  return (
    <span className="relative flex flex-shrink-0">
      <span className={cx("inline-block rounded-full", size, tone)} />
    </span>
  );
}

function SectionTag({ section }: { section: DiagnosticSection }) {
  return (
    <span className="flex-shrink-0 rounded border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
      {section}
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
      className={cx(
        "mt-0.5 flex-shrink-0 text-muted-foreground transition-transform",
        open && "rotate-180",
      )}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/* --------------------------------- helpers -------------------------------- */

function healthHeadline(health: PlatformHealth): string {
  if (health === "unhealthy") return "Platform unhealthy";
  if (health === "attention") return "Platform degraded";
  if (health === "healthy") return "Platform healthy";
  return "Checking platform…";
}

function healthSubline(report: DiagnosticsReport): string {
  const { fail, warn } = report.summary;
  if (fail > 0) {
    return `${fail} component${fail === 1 ? "" : "s"} failing${warn > 0 ? `, ${warn} degraded` : ""}. Requires attention.`;
  }
  if (warn > 0) {
    return `${warn} component${warn === 1 ? "" : "s"} degraded. Review recommended.`;
  }
  return "All control-plane components are operating normally.";
}

function zoneScopeText(scope: string, count: number): string {
  if (scope === "none") return "No zones";
  if (scope === "all") return `All zones (${count})`;
  return `${count} selected`;
}

// Zone checks are keyed by raw zone id; swap a leading id for its human name so the
// operator scans by zone, not UUID.
const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(.*)$/i;

function humanizeCheck(check: DiagnosticCheck, zoneNames: Map<string, string>): string {
  const match = UUID_RE.exec(check.check);
  if (!match) return check.check;
  const name = zoneNames.get(match[1]);
  return name ? `${name} · ${match[2]}` : check.check;
}

function uniqueAdvice(checks: DiagnosticCheck[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const check of checks) {
    if (check.advice && !seen.has(check.advice)) {
      seen.add(check.advice);
      out.push(check.advice);
    }
  }
  return out;
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
