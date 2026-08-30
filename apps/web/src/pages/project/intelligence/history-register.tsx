// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Link, useSearch } from "@tanstack/react-router";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { Button } from "@/components/ui/button";
import { useIntelligenceHistory } from "@/hooks/use-intelligence-workspace";
import type { HistoryCategory, IntelligenceHistoryEvent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useIntelligenceWorkspace } from "./layout";
import { AgentLink, PartialDataNotice, SourceHealth } from "./shared";

const CATEGORIES: { value: HistoryCategory; label: string }[] = [
	{ value: "all", label: "All events" },
	{ value: "usage", label: "Usage" },
	{ value: "cost", label: "Cost" },
	{ value: "change", label: "Changes" },
	{ value: "quality", label: "Quality" },
];

const SEVERITY_TEXT: Record<string, string> = {
	critical: "text-destructive",
	warning: "text-warning",
	info: "text-muted-foreground",
};

function EventActions({ event }: { event: IntelligenceHistoryEvent }) {
	const agentId = event.agent_id ?? undefined;
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
			{event.qualified_name && <AgentLink qualified={event.qualified_name} label="Open resource" />}
			{agentId && (event.kind === "change_submitted" || event.kind === "change_rejected") && (
				<Link to="/agents/$agentId" params={{ agentId }} search={{ view: "changes" }} className="text-foreground hover:underline">Open change</Link>
			)}
			{agentId && event.category === "quality" && (
				<Link to="/intelligence" search={(current: Record<string, unknown>) => ({ ...current, resource: agentId, signal: undefined })} className="text-foreground hover:underline">Inspect signals</Link>
			)}
		</div>
	);
}

function EventRow({ event }: { event: IntelligenceHistoryEvent }) {
	return (
		<li className="grid gap-2 py-3 sm:grid-cols-[120px_80px_minmax(0,1fr)_auto] sm:gap-4">
			<time className="font-mono text-[11px] text-muted-foreground">{new Date(event.occurred_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
			<div><p className={cn("text-[10px] font-medium uppercase", SEVERITY_TEXT[event.severity])}>{event.category}</p><p className="mt-0.5 text-[10px] capitalize text-muted-foreground">{event.classification}</p></div>
			<div className="min-w-0">
				<h2 className="text-sm font-medium text-foreground">{event.title}</h2>
				<p className="mt-0.5 text-xs leading-5 text-muted-foreground">{event.detail}</p>
				{event.evidence.length > 0 && <details className="mt-1.5 text-[11px]"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">Evidence</summary><dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">{event.evidence.map((item) => <div key={item.label} className="flex gap-1"><dt className="text-muted-foreground">{item.label}</dt><dd className="font-mono text-foreground">{item.value}{item.unit === "%" ? "%" : item.unit ? ` ${item.unit}` : ""}</dd></div>)}</dl></details>}
			</div>
			<div className="sm:text-right"><EventActions event={event} /></div>
		</li>
	);
}

export default function HistoryRegisterPage() {
	const { org, project, projectName, range, resource, setContext } = useIntelligenceWorkspace();
	const search = useSearch({ strict: false }) as { category?: HistoryCategory; page?: number };
	const category = CATEGORIES.some((item) => item.value === search.category) ? search.category! : "all";
	const page = search.page ?? 1;
	const query = useIntelligenceHistory(org, project, range, { resource, category, page, pageSize: 30 });
	return (
		<div className="space-y-5">
			<header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4"><div><h1 className="font-display text-xl text-foreground">Project history</h1><p className="mt-1 text-sm text-muted-foreground">Material changes and outcomes in {projectName}, ordered by time.</p></div>{query.data && <SourceHealth sources={query.data.sources} generatedAt={query.data.generated_at} />}</header>
			{query.data && <PartialDataNotice sources={query.data.sources} />}
			<div className="flex flex-wrap items-center gap-3 border-b border-border pb-3"><label className="flex items-center gap-2 text-xs text-muted-foreground"><span>Event type</span><select value={category} onChange={(event) => setContext({ category: event.target.value, page: 1 })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground">{CATEGORIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>{resource && <div className="ml-auto flex items-center gap-2 text-xs"><span className="text-muted-foreground">Resource scope active</span><button type="button" onClick={() => setContext({ resource: undefined, page: 1 })} className="text-foreground hover:underline">Clear</button></div>}</div>
			{query.isLoading ? <TableSkeleton rows={8} cols={3} /> : query.isError ? <ErrorState message={query.error?.message} onRetry={() => query.refetch()} /> : !query.data?.events.length ? <EmptyState title="No significant events in this period" description="Widen the range or clear the active filter to see more project history." /> : <ol className="divide-y divide-border border-y border-border">{query.data.events.map((event) => <EventRow key={event.id} event={event} />)}</ol>}
			{query.data && (query.data.page > 1 || query.data.has_more) && <footer className="flex items-center justify-between text-xs text-muted-foreground"><span>{query.data.total} significant events</span><div className="flex gap-1"><Button variant="outline" size="sm" className="h-8" disabled={page <= 1} onClick={() => setContext({ page: page - 1 })}>Previous</Button><Button variant="outline" size="sm" className="h-8" disabled={!query.data.has_more} onClick={() => setContext({ page: page + 1 })}>Next</Button></div></footer>}
		</div>
	);
}
