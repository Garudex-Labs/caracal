// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Fragment, useMemo } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip as ChartTooltip,
	XAxis,
	YAxis,
} from "recharts";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { useIntelligenceBriefing } from "@/hooks/use-intelligence-workspace";
import type { BriefingMetric, IntelligenceSignal } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useIntelligenceWorkspace } from "./layout";
import {
	AgentLink,
	ChangeBadge,
	PartialDataNotice,
	SourceHealth,
	formatMetricValue,
} from "./shared";

const BREAKDOWNS = ["adoption", "cost", "ownership"] as const;
type Breakdown = (typeof BREAKDOWNS)[number];

const PRIORITY_STYLE: Record<string, string> = {
	critical: "text-destructive",
	warning: "text-warning",
	info: "text-muted-foreground",
};

function metricByKey(metrics: BriefingMetric[], key: string) {
	return metrics.find((metric) => metric.key === key);
}

function SignalActions({ signal }: { signal: IntelligenceSignal }) {
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
			{signal.qualified_name && (() => {
				const [namespace, slug] = signal.qualified_name.split("/");
				return <Link to="/agents/$namespace/$slug" params={{ namespace, slug }} className="text-foreground hover:underline">Open resource</Link>;
			})()}
			{signal.agent_id && (
				<Link to="/agents/$agentId" params={{ agentId: signal.agent_id }} search={{ view: "changes" }} className="text-foreground hover:underline">
					Open changes
				</Link>
			)}
			{signal.agent_id && (
				<Link to="/intelligence/resources" search={(current: Record<string, unknown>) => ({ ...current, resource: signal.agent_id ?? undefined, focus: "attention" })} className="text-foreground hover:underline">
					Inspect resource metrics
				</Link>
			)}
			<Link to="/intelligence/history" search={(current: Record<string, unknown>) => ({ ...current, resource: signal.agent_id ?? (current.resource as string | undefined) })} className="text-foreground hover:underline">
				View related history
			</Link>
		</div>
	);
}

function SignalTable({ signals, selected, onSelect }: { signals: IntelligenceSignal[]; selected?: string; onSelect: (id?: string) => void }) {
	if (!signals.length) {
		return <p className="border-y border-border py-5 text-sm text-muted-foreground">No material changes crossed the current evidence thresholds.</p>;
	}
	return (
		<div className="overflow-x-auto border-y border-border">
			<table className="w-full min-w-190 text-sm">
				<thead>
					<tr className="border-b border-border text-left text-[10px] uppercase text-muted-foreground">
						<th className="w-20 px-3 py-2 font-medium">Priority</th>
						<th className="px-3 py-2 font-medium">Change</th>
						<th className="w-40 px-3 py-2 font-medium">Scope</th>
						<th className="px-3 py-2 font-medium">Why it matters</th>
						<th className="w-24 px-3 py-2 text-right font-medium">Evidence</th>
					</tr>
				</thead>
				<tbody>
					{signals.map((signal) => {
						const open = selected === signal.id;
						return (
							<Fragment key={signal.id}>
								<tr className={cn("border-b border-border/50", open && "bg-muted/20")}>
									<td className={cn("px-3 py-3 text-[10px] font-medium uppercase", PRIORITY_STYLE[signal.severity])}>{signal.severity}</td>
									<td className="px-3 py-3">
										<p className="font-medium text-foreground">{signal.title}</p>
										<p className="mt-0.5 text-[11px] capitalize text-muted-foreground">{signal.classification}</p>
									</td>
									<td className="px-3 py-3">
										{signal.qualified_name ? <AgentLink qualified={signal.qualified_name} label={signal.qualified_name} className="font-mono text-[11px]" /> : <span className="text-xs text-muted-foreground">Project</span>}
									</td>
									<td className="max-w-md px-3 py-3 text-xs leading-5 text-muted-foreground">{signal.impact}</td>
									<td className="px-3 py-3 text-right">
										<button type="button" className="text-xs text-foreground underline-offset-4 hover:underline" onClick={() => onSelect(open ? undefined : signal.id)} aria-expanded={open}>
											{open ? "Close" : "Inspect"}
										</button>
									</td>
								</tr>
								{open && (
									<tr className="border-b border-border/50 bg-muted/10">
										<td colSpan={5} className="px-3 py-4">
											<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
												<div>
													<p className="text-[10px] uppercase text-muted-foreground">Why this was surfaced</p>
													<p className="mt-1 text-sm leading-6 text-foreground">{signal.explanation}</p>
													<div className="mt-4"><SignalActions signal={signal} /></div>
												</div>
												<dl className="divide-y divide-border border-y border-border">
													{signal.evidence.map((evidence) => (
														<div key={evidence.label} className="flex items-center justify-between gap-4 py-2 text-xs">
															<dt className="text-muted-foreground">{evidence.label}</dt>
															<dd className="font-mono text-foreground">{typeof evidence.value === "number" ? evidence.value.toLocaleString() : evidence.value}{evidence.unit === "%" ? "%" : evidence.unit ? ` ${evidence.unit}` : ""}</dd>
														</div>
													))}
												</dl>
											</div>
										</td>
									</tr>
								)}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function BreakdownView({ mode, data }: { mode: Breakdown; data: NonNullable<ReturnType<typeof useIntelligenceBriefing>["data"]> }) {
	if (mode === "adoption") {
		return (
			<div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(240px,0.7fr)]">
				<dl className="divide-y divide-border border-y border-border">
					{[
						["Active users", data.adoption.active_users],
						["New users", data.adoption.new_users],
						["Returning users", data.adoption.returning_users],
						["Attributed sessions", data.adoption.attributed_sessions],
					].map(([label, value]) => (
						<div key={String(label)} className="flex items-center justify-between py-2 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono text-foreground">{value ?? "–"}</dd></div>
					))}
				</dl>
				<p className="text-sm leading-6 text-muted-foreground">
					{data.adoption.top_resource_share_pct === null || data.adoption.attributed_sessions === null
						? "Usage concentration is unavailable for this period."
						: `The most-used resource accounts for ${data.adoption.top_resource_share_pct}% of ${data.adoption.attributed_sessions} attributed sessions.`}
				</p>
			</div>
		);
	}
	if (mode === "cost") {
		const cost = metricByKey(data.metrics, "credits");
		const drivers = [...data.resource_highlights].filter((resource) => resource.credits !== null).sort((left, right) => (right.credits ?? 0) - (left.credits ?? 0)).slice(0, 5);
		return (
			<div>
				<p className="text-sm text-foreground">{cost ? `${formatMetricValue(cost)} this period` : "Cost is unavailable"}{cost?.change_pct !== null && cost?.change_pct !== undefined ? `, ${Math.abs(cost.change_pct)}% ${cost.change_pct >= 0 ? "higher" : "lower"} than the previous period.` : "."}</p>
				{drivers.length > 0 && (
					<table className="mt-3 w-full text-xs"><thead><tr className="border-y border-border text-left text-[10px] uppercase text-muted-foreground"><th className="py-2 font-medium">Primary drivers</th><th className="py-2 text-right font-medium">Credits</th><th className="py-2 text-right font-medium">Per session</th></tr></thead><tbody>{drivers.map((resource) => <tr key={resource.agent_id} className="border-b border-border/50"><td className="py-2"><AgentLink qualified={resource.qualified_name} label={resource.name} /></td><td className="py-2 text-right font-mono">{resource.credits?.toFixed(2)}</td><td className="py-2 text-right font-mono text-muted-foreground">{resource.credits_per_session?.toFixed(4) ?? "–"}</td></tr>)}</tbody></table>
				)}
				<Link to="/intelligence/resources" search={(current: Record<string, unknown>) => ({ ...current, sort: "cost" })} className="mt-3 inline-block text-xs text-foreground hover:underline">Inspect all cost drivers</Link>
			</div>
		);
	}
	return (
		<div className="overflow-x-auto border-y border-border">
			<table className="w-full min-w-120 text-xs">
				<thead><tr className="border-b border-border text-left text-[10px] uppercase text-muted-foreground"><th className="px-3 py-2 font-medium">Maintainer</th><th className="px-3 py-2 font-medium">Responsibility</th><th className="px-3 py-2 text-right font-medium">Owned</th><th className="px-3 py-2 text-right font-medium">Changes</th><th className="px-3 py-2 text-right font-medium">Resolved</th></tr></thead>
				<tbody>{data.ownership.map((owner) => <tr key={owner.user_id} className="border-b border-border/50 last:border-0"><td className="px-3 py-2 text-foreground">{owner.name}</td><td className="px-3 py-2 text-muted-foreground">{owner.department ?? owner.role}</td><td className="px-3 py-2 text-right font-mono">{owner.resources_owned}</td><td className="px-3 py-2 text-right font-mono">{owner.changes_submitted}</td><td className="px-3 py-2 text-right font-mono">{owner.issues_resolved}</td></tr>)}</tbody>
			</table>
		</div>
	);
}

export default function SummaryPage() {
	const { org, project, projectName, range, resource, setContext } = useIntelligenceWorkspace();
	const search = useSearch({ strict: false }) as { signal?: string; breakdown?: Breakdown };
	const query = useIntelligenceBriefing(org, project, range);
	const chartData = useMemo(() => (query.data?.activity ?? []).map((point) => ({ ...point, label: point.date.slice(5) })), [query.data]);

	if (query.isLoading) return <TableSkeleton rows={8} cols={4} />;
	if (query.isError) return <ErrorState message={query.error?.message} onRetry={() => query.refetch()} />;
	if (!query.data) return null;
	if (!query.data.has_data) {
		return <EmptyState title="No project evidence yet" description="Summary appears once this project receives sessions, installs, releases, or review activity." />;
	}

	const data = query.data;
	const scopedResource = resource ? data.resource_highlights.find((candidate) => candidate.agent_id === resource) : undefined;
	const signals = resource ? data.signals.filter((signal) => signal.agent_id === resource) : data.signals;
	const primaryMetrics = ["sessions", "active_users", "tool_completion", "credits"].map((key) => metricByKey(data.metrics, key)).filter(Boolean) as BriefingMetric[];
	const secondaryMetrics = data.metrics.filter((metric) => !primaryMetrics.includes(metric));
	const breakdown = search.breakdown && BREAKDOWNS.includes(search.breakdown) ? search.breakdown : "adoption";

	return (
		<div className="space-y-7">
			<header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
				<div>
					<h1 className="font-display text-xl text-foreground">Project summary</h1>
					<p className="mt-1 text-sm text-muted-foreground">What is happening in {projectName}, what changed, and what needs attention.</p>
				</div>
				<SourceHealth sources={data.sources} generatedAt={data.generated_at} />
			</header>
			<PartialDataNotice sources={data.sources} />
			{resource && (
				<div className="flex items-center justify-between border-y border-border py-2 text-xs">
					<span className="text-muted-foreground">Scoped to <span className="font-medium text-foreground">{scopedResource?.name ?? "selected resource"}</span></span>
					<button type="button" className="text-foreground hover:underline" onClick={() => setContext({ resource: undefined, signal: undefined })}>Clear scope</button>
				</div>
			)}

			<section aria-labelledby="state-heading">
				<div className="mb-2 flex items-baseline justify-between"><h2 id="state-heading" className="text-xs font-medium uppercase text-muted-foreground">Current state</h2><span className="text-[11px] text-muted-foreground">vs previous {range}</span></div>
				<div className="grid grid-cols-2 border-l border-t border-border lg:grid-cols-4">
					{primaryMetrics.map((metric) => <div key={metric.key} className="border-b border-r border-border px-3 py-3"><p className="text-[10px] uppercase text-muted-foreground">{metric.label}</p><div className="mt-2 flex items-baseline justify-between gap-2"><span className="font-mono text-lg text-foreground">{formatMetricValue(metric)}</span><ChangeBadge value={metric.change_pct} points={metric.key === "tool_completion"} /></div></div>)}
				</div>
				{secondaryMetrics.length > 0 && <details className="border-b border-border py-2 text-xs"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">Additional measures</summary><div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">{secondaryMetrics.map((metric) => <span key={metric.key}><span className="text-muted-foreground">{metric.label}</span> <span className="ml-1 font-mono text-foreground">{formatMetricValue(metric)}</span></span>)}</div></details>}
			</section>

			<section aria-labelledby="changes-heading">
				<div className="mb-2 flex items-baseline justify-between"><h2 id="changes-heading" className="text-xs font-medium uppercase text-muted-foreground">Significant changes</h2><span className="font-mono text-[11px] text-muted-foreground">{signals.length}</span></div>
				<SignalTable signals={signals} selected={search.signal} onSelect={(signal) => setContext({ signal })} />
			</section>

			<div className="grid gap-7 border-t border-border pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
				<section className="min-w-0" aria-labelledby="trend-heading">
					<div className="mb-2 flex items-baseline justify-between"><h2 id="trend-heading" className="text-xs font-medium uppercase text-muted-foreground">Daily sessions</h2><Link to="/intelligence/history" search={(current: Record<string, unknown>) => current} className="text-[11px] text-foreground hover:underline">Open history</Link></div>
					<div className="h-44"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 6, right: 8, left: -24, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--color-muted-foreground)" /><YAxis tick={{ fontSize: 10 }} stroke="var(--color-muted-foreground)" allowDecimals={false} /><ChartTooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 3, fontSize: 12 }} /><Line type="monotone" dataKey="sessions" stroke="var(--color-primary-accent)" strokeWidth={1.5} dot={false} /></LineChart></ResponsiveContainer></div>
				</section>

				<section className="min-w-0" aria-labelledby="breakdown-heading">
					<div className="mb-3 flex items-center justify-between gap-3"><h2 id="breakdown-heading" className="text-xs font-medium uppercase text-muted-foreground">Breakdown</h2><div className="flex border-b border-border">{BREAKDOWNS.map((mode) => <button key={mode} type="button" onClick={() => setContext({ breakdown: mode })} className={cn("border-b-2 px-2.5 py-1 text-xs capitalize", breakdown === mode ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{mode}</button>)}</div></div>
					<BreakdownView mode={breakdown} data={data} />
				</section>
			</div>
		</div>
	);
}
