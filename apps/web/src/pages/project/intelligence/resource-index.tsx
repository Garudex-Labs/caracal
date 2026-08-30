// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Fragment, useDeferredValue, useEffect, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	useIntelligenceCompare,
	useIntelligenceResources,
	useIntelligenceResourceVersions,
} from "@/hooks/use-intelligence-workspace";
import type { IntelligenceResource, ResourceFocus, ResourceSort } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useIntelligenceWorkspace } from "./layout";
import { ChangeBadge, PartialDataNotice, SourceHealth, formatNumber } from "./shared";

const FOCUS: { value: ResourceFocus; label: string }[] = [
	{ value: "all", label: "All resources" },
	{ value: "attention", label: "Needs attention" },
	{ value: "growing", label: "Growing" },
	{ value: "declining", label: "Declining" },
	{ value: "underused", label: "Underused" },
];

const SORTS: { value: ResourceSort; label: string }[] = [
	{ value: "impact", label: "Highest usage" },
	{ value: "attention", label: "Most attention" },
	{ value: "growth", label: "Fastest growth" },
	{ value: "cost", label: "Highest cost" },
	{ value: "name", label: "Name" },
];

function displayValue(value: number | null, suffix = "") {
	return value === null ? "–" : `${formatNumber(value)}${suffix}`;
}

function Comparison({ rows, a, b, onClear }: { rows: IntelligenceResource[]; a?: string; b?: string; onClear: () => void }) {
	const { org, project, range } = useIntelligenceWorkspace();
	const query = useIntelligenceCompare(org, project, range, a, b);
	if (!a) return null;
	const first = rows.find((row) => row.agent_id === a);
	if (!b) {
		return (
			<div className="flex items-center justify-between border-y border-border py-2 text-xs">
				<span className="text-muted-foreground"><span className="font-medium text-foreground">{first?.name ?? "One resource"}</span> selected. Choose one more resource to compare.</span>
				<button type="button" className="text-foreground hover:underline" onClick={onClear}>Clear</button>
			</div>
		);
	}
	if (query.isLoading) return <p className="border-y border-border py-3 text-xs text-muted-foreground">Loading comparison…</p>;
	if (query.isError || !query.data) {
		return <div className="flex items-center justify-between border-y border-border py-2 text-xs text-destructive"><span>Comparison is unavailable.</span><button type="button" className="underline" onClick={() => query.refetch()}>Retry</button></div>;
	}
	const metrics = [
		{ label: "Sessions", left: query.data.a.sessions, right: query.data.b.sessions, delta: query.data.deltas.sessions_pct, suffix: "%" },
		{ label: "Tool completion", left: query.data.a.tool_completion_pct, right: query.data.b.tool_completion_pct, delta: query.data.deltas.tool_completion_delta, suffix: " pts" },
		{ label: "Installs", left: query.data.a.downloads, right: query.data.b.downloads, delta: query.data.deltas.downloads_pct, suffix: "%" },
		{ label: "Credits / session", left: query.data.a.credits_per_session, right: query.data.b.credits_per_session, delta: query.data.deltas.credits_pct, suffix: "%" },
	];
	return (
		<section className="border-y border-border py-3" aria-labelledby="comparison-heading">
			<div className="mb-2 flex items-center justify-between gap-3">
				<h2 id="comparison-heading" className="text-xs font-medium text-foreground">Comparing {query.data.a.name} and {query.data.b.name}</h2>
				<button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onClear}>Clear comparison</button>
			</div>
			<div className="overflow-x-auto">
				<table className="w-full min-w-130 text-xs">
					<thead><tr className="border-y border-border text-left text-[10px] uppercase text-muted-foreground"><th className="py-2 font-medium">Measure</th><th className="py-2 text-right font-medium">{query.data.a.name}</th><th className="py-2 text-right font-medium">{query.data.b.name}</th><th className="py-2 text-right font-medium">Difference</th></tr></thead>
					<tbody>{metrics.map((metric) => <tr key={metric.label} className="border-b border-border/50"><td className="py-2 text-muted-foreground">{metric.label}</td><td className="py-2 text-right font-mono">{metric.left ?? "–"}</td><td className="py-2 text-right font-mono">{metric.right ?? "–"}</td><td className="py-2 text-right font-mono text-foreground">{metric.delta === null ? "–" : `${metric.delta > 0 ? "+" : ""}${metric.delta}${metric.suffix}`}</td></tr>)}</tbody>
				</table>
			</div>
		</section>
	);
}

function VersionComparison({ resourceId }: { resourceId: string }) {
	const { org, project, range } = useIntelligenceWorkspace();
	const query = useIntelligenceResourceVersions(org, project, resourceId, range);
	const [beforeVersion, setBeforeVersion] = useState("");
	const [afterVersion, setAfterVersion] = useState("");
	useEffect(() => {
		const versions = query.data?.versions ?? [];
		setBeforeVersion(versions[1]?.version ?? versions[0]?.version ?? "");
		setAfterVersion(versions[0]?.version ?? "");
	}, [query.data, resourceId]);
	if (query.isLoading) return <p className="mt-3 text-xs text-muted-foreground">Loading version evidence…</p>;
	if (query.isError) return <p className="mt-3 text-xs text-destructive">Version evidence is unavailable. <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button></p>;
	if (!query.data || query.data.versions.length < 2) return <p className="mt-3 text-xs text-muted-foreground">A second observed version is required for comparison.</p>;
	const before = query.data.versions.find((version) => version.version === beforeVersion);
	const after = query.data.versions.find((version) => version.version === afterVersion);
	const metrics: { label: string; previous: number | null; current: number | null; suffix: string }[] = before && after ? [
		{ label: "Sessions", previous: before.sessions, current: after.sessions, suffix: "" },
		{ label: "Tool completion", previous: before.tool_completion_pct, current: after.tool_completion_pct, suffix: "%" },
		{ label: "Credits", previous: before.credits, current: after.credits, suffix: " cr" },
	] : [];
	return (
		<div className="mt-3">
			<div className="flex max-w-md items-center gap-2">
				<select value={beforeVersion} onChange={(event) => setBeforeVersion(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs">{query.data.versions.map((version) => <option key={version.version} value={version.version}>{version.version}</option>)}</select>
				<span className="text-xs text-muted-foreground">to</span>
				<select value={afterVersion} onChange={(event) => setAfterVersion(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs">{query.data.versions.map((version) => <option key={version.version} value={version.version}>{version.version}</option>)}</select>
			</div>
			<dl className="mt-3 max-w-xl divide-y divide-border border-y border-border text-xs">{metrics.map((metric) => <div key={metric.label} className="flex items-center justify-between py-2"><dt className="text-muted-foreground">{metric.label}</dt><dd className="font-mono text-foreground">{metric.previous === null ? "–" : `${metric.previous}${metric.suffix}`} → {metric.current === null ? "–" : `${metric.current}${metric.suffix}`}</dd></div>)}</dl>
		</div>
	);
}

function ResourceDetails({ resource, onClose }: { resource: IntelligenceResource; onClose: () => void }) {
	return (
		<div className="bg-muted/10 px-3 py-4">
			<div className="flex items-start justify-between gap-4"><div><h3 className="text-sm font-medium text-foreground">{resource.name}</h3><p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{resource.qualified_name ?? resource.agent_id}</p></div><button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button></div>
			<div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
				<div>
					<dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-4"><div><dt className="text-muted-foreground">Owner</dt><dd className="mt-1 text-foreground">{resource.owner ?? "Unassigned"}</dd></div><div><dt className="text-muted-foreground">Version</dt><dd className="mt-1 font-mono text-foreground">{resource.version ?? "–"}</dd></div><div><dt className="text-muted-foreground">Last used</dt><dd className="mt-1 font-mono text-foreground">{resource.last_used?.slice(0, 10) ?? "–"}</dd></div><div><dt className="text-muted-foreground">Open issues</dt><dd className="mt-1 font-mono text-foreground">{resource.open_issues ?? "–"}</dd></div></dl>
					{resource.attention_reasons.length > 0 && <p className="mt-4 text-xs text-warning">Needs attention: {resource.attention_reasons.join(", ")}.</p>}
					<div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs"><Link to="/intelligence" search={(current: Record<string, unknown>) => ({ ...current, resource: resource.agent_id, signal: undefined })} className="text-foreground hover:underline">View signals</Link><Link to="/intelligence/history" search={(current: Record<string, unknown>) => ({ ...current, resource: resource.agent_id })} className="text-foreground hover:underline">View history</Link><Link to="/agents/$agentId" params={{ agentId: resource.agent_id }} search={{ view: "changes" }} className="text-foreground hover:underline">Open changes</Link>{resource.qualified_name && (() => { const [namespace, slug] = resource.qualified_name.split("/"); return <Link to="/agents/$namespace/$slug" params={{ namespace, slug }} className="text-foreground hover:underline">Open resource</Link>; })()}</div>
				</div>
				<details className="border-t border-border pt-2 text-xs"><summary className="cursor-pointer font-medium text-foreground">Compare versions</summary><VersionComparison resourceId={resource.agent_id} /></details>
			</div>
		</div>
	);
}

export default function ResourceIndexPage() {
	const { org, project, range, resource, setContext } = useIntelligenceWorkspace();
	const search = useSearch({ strict: false }) as { focus?: ResourceFocus; sort?: ResourceSort; q?: string; page?: number; a?: string; b?: string };
	const deferredSearch = useDeferredValue(search.q ?? "");
	const focus = FOCUS.some((item) => item.value === search.focus) ? search.focus! : "all";
	const sort = SORTS.some((item) => item.value === search.sort) ? search.sort! : "impact";
	const page = search.page ?? 1;
	const query = useIntelligenceResources(org, project, { range, focus, search: deferredSearch, sort, page, pageSize: 25 });
	const comparisonFull = !!search.a && !!search.b;
	const toggleComparison = (id: string) => {
		if (search.a === id) setContext({ a: search.b, b: undefined });
		else if (search.b === id) setContext({ b: undefined });
		else if (!search.a) setContext({ a: id });
		else if (!search.b) setContext({ b: id });
	};

	return (
		<div className="space-y-5">
			<header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4"><div><h1 className="font-display text-xl text-foreground">Resource intelligence</h1><p className="mt-1 text-sm text-muted-foreground">Usage, growth, reliability, cost, ownership, and version evidence in one index.</p></div>{query.data && <SourceHealth sources={query.data.sources} generatedAt={query.data.generated_at} />}</header>
			{query.data && <PartialDataNotice sources={query.data.sources} />}
			<div className="flex flex-wrap items-center gap-2 border-b border-border pb-3"><Input value={search.q ?? ""} onChange={(event) => setContext({ q: event.target.value || undefined, page: 1 })} placeholder="Search resource or owner" className="h-8 min-w-56 flex-1 text-xs sm:max-w-80" /><label className="flex items-center gap-2 text-xs text-muted-foreground"><span>View</span><select value={focus} onChange={(event) => setContext({ focus: event.target.value, page: 1 })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground">{FOCUS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="flex items-center gap-2 text-xs text-muted-foreground"><span>Sort</span><select value={sort} onChange={(event) => setContext({ sort: event.target.value, page: 1 })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground">{SORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
			{query.data && <Comparison rows={query.data.rows} a={search.a} b={search.b} onClear={() => setContext({ a: undefined, b: undefined })} />}
			{query.isLoading ? <TableSkeleton rows={9} cols={7} /> : query.isError ? <ErrorState message={query.error?.message} onRetry={() => query.refetch()} /> : !query.data?.rows.length ? <EmptyState title="No resources match this view" description="Change the view, search, or time range to widen the result." /> : (
				<div className="overflow-x-auto border-y border-border"><table className="w-full min-w-225 text-sm"><thead><tr className="border-b border-border text-left text-[10px] uppercase text-muted-foreground"><th className="w-12 px-3 py-2 text-center font-medium">Compare</th><th className="px-3 py-2 font-medium">Resource</th><th className="px-3 py-2 text-right font-medium">Sessions</th><th className="px-3 py-2 text-right font-medium">Completion</th><th className="px-3 py-2 text-right font-medium">Installs</th><th className="px-3 py-2 text-right font-medium">Cost / session</th><th className="px-3 py-2 text-right font-medium">Issues</th><th className="px-3 py-2 font-medium">State</th></tr></thead><tbody>{query.data.rows.map((row) => {
					const selected = row.agent_id === resource;
					const compared = row.agent_id === search.a || row.agent_id === search.b;
					return <Fragment key={row.agent_id}><tr className={cn("border-b border-border/50", selected && "bg-muted/20")}><td className="px-3 py-2 text-center"><input type="checkbox" checked={compared} disabled={comparisonFull && !compared} onChange={() => toggleComparison(row.agent_id)} aria-label={`Compare ${row.name}`} /></td><td className="px-3 py-2"><button type="button" onClick={() => setContext({ resource: selected ? undefined : row.agent_id })} className="text-left"><span className="font-medium text-foreground hover:underline">{row.name}</span><span className="ml-2 font-mono text-[10px] text-muted-foreground">{row.owner ?? "unregistered"}</span></button></td><td className="px-3 py-2 text-right"><span className="font-mono">{displayValue(row.sessions)}</span><span className="ml-2"><ChangeBadge value={row.change_pct} /></span></td><td className="px-3 py-2 text-right font-mono text-muted-foreground">{displayValue(row.tool_completion_pct, "%")}</td><td className="px-3 py-2 text-right font-mono text-muted-foreground">{displayValue(row.downloads)}</td><td className="px-3 py-2 text-right font-mono text-muted-foreground">{row.credits_per_session?.toFixed(4) ?? "–"}</td><td className="px-3 py-2 text-right font-mono">{row.open_issues ?? "–"}</td><td className={cn("px-3 py-2 text-xs", row.attention_reasons.length ? "text-warning" : "text-muted-foreground")}>{row.attention_reasons[0] ?? "Healthy"}</td></tr>{selected && <tr><td colSpan={8}><ResourceDetails resource={row} onClose={() => setContext({ resource: undefined })} /></td></tr>}</Fragment>;
				})}</tbody></table></div>
			)}
			{query.data && query.data.total > query.data.page_size && <footer className="flex items-center justify-between text-xs text-muted-foreground"><span>Showing {(page - 1) * query.data.page_size + 1}–{Math.min(page * query.data.page_size, query.data.total)} of {query.data.total}</span><div className="flex gap-1"><Button variant="outline" size="sm" className="h-8" disabled={page <= 1} onClick={() => setContext({ page: page - 1 })}>Previous</Button><Button variant="outline" size="sm" className="h-8" disabled={page * query.data.page_size >= query.data.total} onClick={() => setContext({ page: page + 1 })}>Next</Button></div></footer>}
		</div>
	);
}
