// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// System status center: the authoritative operational picture of this
// deployment. Overall state first, then per-component health with
// expandable diagnostics, then operational notices (restart pending,
// security warnings). Server-aggregated (services/system_status) - the
// page never infers health from unrelated APIs, and admin access is
// enforced server-side on the endpoint itself.

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRestartStatus, useSystemStatus, useSystemWarnings } from "@/hooks/use-api";
import { RestartStatusControl } from "@/components/settings/restart-status";
import { cn } from "@/lib/utils";
import type { SystemComponentStatus, SystemHealthState } from "@/lib/types";

const STATE_META: Record<SystemHealthState, { label: string; dot: string; text: string }> = {
	healthy: { label: "Healthy", dot: "bg-success", text: "text-success" },
	degraded: { label: "Degraded", dot: "bg-warning", text: "text-warning" },
	critical: { label: "Critical", dot: "bg-destructive", text: "text-destructive" },
	unknown: { label: "Unknown", dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

function StatusDot({ state, className }: { state: SystemHealthState; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("inline-block h-2 w-2 shrink-0 rounded-full", STATE_META[state]?.dot, className)}
		/>
	);
}

function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatChecked(iso: string): string {
	if (!iso) return "–";
	const delta = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(delta)) return "–";
	if (delta < 15_000) return "just now";
	if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
	return `${Math.round(delta / 60_000)}m ago`;
}

function ComponentRow({ component }: { component: SystemComponentStatus }) {
	const [open, setOpen] = useState(component.status === "critical");
	const meta = STATE_META[component.status] ?? STATE_META.unknown;
	const metrics = Object.entries(component.metrics ?? {}).filter(([key]) => key !== "issues");
	const issues = (component.metrics?.issues as string[] | undefined) ?? [];
	const hasDetail = !!component.detail || metrics.length > 0 || issues.length > 0;

	return (
		<div className="border-b border-border/60 last:border-b-0">
			<button
				type="button"
				onClick={() => hasDetail && setOpen((v) => !v)}
				aria-expanded={hasDetail ? open : undefined}
				className={cn(
					"grid w-full grid-cols-[14px_minmax(9rem,14rem)_1fr_5rem_6rem_16px] items-center gap-3 px-3 py-2.5 text-left text-sm",
					hasDetail && "transition-colors hover:bg-accent/30",
				)}
			>
				<StatusDot state={component.status} />
				<span className="truncate font-medium">{component.name}</span>
				<span className="hidden truncate text-xs text-muted-foreground md:inline">{component.purpose}</span>
				<span className="text-right font-mono text-xs text-muted-foreground">
					{component.latency_ms != null ? `${component.latency_ms.toFixed(0)} ms` : "–"}
				</span>
				<span className={cn("text-right text-xs font-medium capitalize", meta.text)}>{component.status}</span>
				{hasDetail ? (
					open ? (
						<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
					)
				) : (
					<span />
				)}
			</button>
			{open && hasDetail && (
				<div className="space-y-1.5 border-t border-border/40 bg-accent/20 px-3 py-2.5 pl-8 text-xs">
					{component.detail && <p className={cn(meta.text)}>{component.detail}</p>}
					{issues.map((issue) => (
						<p key={issue} className="text-warning">
							• {issue}
						</p>
					))}
					{metrics.length > 0 && (
						<p className="font-mono text-muted-foreground">
							{metrics.map(([key, value]) => `${key}=${String(value)}`).join("  ")}
						</p>
					)}
					<p className="text-muted-foreground">Last checked {formatChecked(component.checked_at)}</p>
				</div>
			)}
		</div>
	);
}

export default function StatusPage() {
	const status = useSystemStatus({ refetchInterval: 15_000 });
	const warnings = useSystemWarnings();
	const restart = useRestartStatus();
	const data = status.data;

	const overallMeta = data ? (STATE_META[data.overall] ?? STATE_META.unknown) : null;
	const notices = [
		...(restart.data?.required
			? [{ level: "warning", code: "restart_pending", message: "Configuration changes are waiting for a server restart." }]
			: []),
		...(warnings.data ?? []),
	];

	return (
		<div className="mx-auto w-full max-w-6xl space-y-6 p-6">
			<header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
				<div>
					<h1 className="text-lg font-semibold tracking-tight">System Status</h1>
					<p className="mt-0.5 text-[13px] text-muted-foreground">
						Operational health of this deployment and its infrastructure.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<RestartStatusControl onRestarted={() => status.refetch()} />
					<Button size="sm" variant="outline" disabled={status.isFetching} onClick={() => status.refetch()}>
						<RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", status.isFetching && "animate-spin")} />
						Re-check
					</Button>
				</div>
			</header>

			{status.isLoading ? (
				<TableSkeleton rows={5} />
			) : status.isError ? (
				<ErrorState
					message="The status endpoint is unreachable - treat the system as degraded."
					onRetry={() => status.refetch()}
				/>
			) : data && overallMeta ? (
				<>
					{/* Overall state: is the system healthy, what is affected, how fresh is this. */}
					<section
						aria-label="Overall system state"
						className={cn(
							"flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-4 py-3",
							data.overall === "healthy" && "border-success/40 bg-success/5",
							data.overall === "degraded" && "border-warning/40 bg-warning/5",
							data.overall === "critical" && "border-destructive/40 bg-destructive/5",
						)}
					>
						<span className="flex items-center gap-2">
							<StatusDot state={data.overall} className="h-2.5 w-2.5" />
							<span className={cn("text-sm font-semibold", overallMeta.text)}>{overallMeta.label}</span>
						</span>
						{data.failing_components.length > 0 && (
							<span className="text-xs text-destructive">
								Failing: {data.failing_components.join(", ")}
							</span>
						)}
						{data.degraded_components.length > 0 && (
							<span className="text-xs text-warning">
								Degraded: {data.degraded_components.join(", ")}
							</span>
						)}
						<span className="ml-auto flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
							<span>v{data.version}</span>
							<span>up {formatUptime(data.uptime_seconds)}</span>
							<span>checked {formatChecked(data.checked_at)}</span>
						</span>
					</section>

					{/* Component health: one row per dependency, expandable diagnostics. */}
					<section aria-label="Component health" className="space-y-2">
						<h2 className="text-[13px] font-semibold uppercase tracking-wider text-foreground/80">Components</h2>
						<div className="rounded-md border border-border">
							{data.components.map((component) => (
								<ComponentRow key={component.id} component={component} />
							))}
						</div>
					</section>

					{/* Operational notices: pending restarts and security warnings. */}
					{notices.length > 0 && (
						<section aria-label="Operational notices" className="space-y-2">
							<h2 className="text-[13px] font-semibold uppercase tracking-wider text-foreground/80">Notices</h2>
							<div className="space-y-1.5">
								{notices.map((notice) => (
									<div
										key={notice.code}
										className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs"
									>
										<AlertTriangle
											className={cn(
												"mt-0.5 h-3.5 w-3.5 shrink-0",
												notice.level === "critical" ? "text-destructive" : "text-warning",
											)}
										/>
										<span className="min-w-0">
											<Badge variant="outline" className="mr-2 px-1.5 py-0 text-[10px] uppercase">
												{notice.level}
											</Badge>
											{notice.message}
										</span>
									</div>
								))}
							</div>
						</section>
					)}
				</>
			) : null}
		</div>
	);
}
