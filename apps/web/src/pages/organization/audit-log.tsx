// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, Clock3, Eye, ScrollText, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { NotFoundState } from "@/components/shared/not-found-state";
import {
	ActivityFeedView,
	formatActivityTime,
	useActivityFeed,
	type ActivityFilterField,
	type ActivitySortOption,
} from "@/components/organization/activity-feed";
import { useOrgAuditLog } from "@/hooks/use-orgs-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useAdministeredOrg } from "@/pages/organization/shell";
import type { AuditLogEntry } from "@/lib/types";

const AUDIT_FILTERS: ActivityFilterField[] = [
	{ key: "q", label: "Search", placeholder: "Search request, action, resource, or detail...", width: "w-80" },
	{
		key: "outcome",
		label: "Result",
		width: "w-36",
		options: [
			{ value: "success", label: "Success" },
			{ value: "denied", label: "Denied" },
			{ value: "client_error", label: "Client error" },
			{ value: "not_found", label: "Not found" },
			{ value: "error", label: "Error" },
		],
	},
	{ key: "actor", label: "Actor email", placeholder: "actor@example.com", width: "w-56" },
	{ key: "action", label: "Action", placeholder: "agent.install or get./api/...", width: "w-56", advanced: true },
	{
		key: "resource_type",
		label: "Resource type",
		width: "w-44",
		advanced: true,
		options: [
			{ value: "organization", label: "Organization" },
			{ value: "project", label: "Project" },
			{ value: "member", label: "Member" },
			{ value: "invitation", label: "Invitation" },
			{ value: "agent", label: "Agent" },
			{ value: "mcp", label: "MCP server" },
			{ value: "skill", label: "Skill" },
			{ value: "hook", label: "Hook" },
			{ value: "prompt", label: "Prompt" },
		],
	},
	{ key: "resource", label: "Resource", placeholder: "name, id, or path", width: "w-56", advanced: true },
	{ key: "project", label: "Project", placeholder: "project slug", width: "w-44", advanced: true },
	{ key: "request_id", label: "Request ID", placeholder: "request id", width: "w-56", advanced: true },
	{ key: "ip_address", label: "IP address", placeholder: "203.0.113.10", width: "w-40", advanced: true },
	{
		key: "http_method",
		label: "Method",
		width: "w-32",
		advanced: true,
		options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => ({ value: method, label: method })),
	},
	{ key: "status_code", label: "Status", placeholder: "200", width: "w-28", advanced: true },
	{
		key: "sensitivity",
		label: "Sensitivity",
		width: "w-40",
		advanced: true,
		options: [
			{ value: "standard", label: "Standard" },
			{ value: "admin", label: "Admin" },
			{ value: "normal", label: "Normal" },
			{ value: "phi_adjacent", label: "PHI-adjacent" },
		],
	},
	{
		key: "source",
		label: "Source",
		width: "w-32",
		advanced: true,
		options: [
			{ value: "server", label: "Server" },
			{ value: "api", label: "API" },
			{ value: "cli", label: "CLI" },
		],
	},
	{ key: "start_date", label: "From", type: "date", width: "w-40", advanced: true },
	{ key: "end_date", label: "To", type: "date", width: "w-40", advanced: true },
];

const AUDIT_SORT_OPTIONS: ActivitySortOption[] = [
	{ value: "newest", label: "Newest first" },
	{ value: "oldest", label: "Oldest first" },
	{ value: "slowest", label: "Slowest first" },
	{ value: "status_desc", label: "Highest status" },
];

function outcomeBadge(outcome: string) {
	if (outcome === "success") {
		return <Badge className="border-success/30 bg-success/15 text-[10px] text-success">success</Badge>;
	}
	if (outcome === "denied" || outcome === "error") {
		return (
			<Badge variant="destructive" className="text-[10px]">
				{outcome}
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="text-[10px]">
			{outcome || "recorded"}
		</Badge>
	);
}

function actionLabel(entry: AuditLogEntry) {
	if (entry.resource_type && entry.action && !entry.action.includes("/api/")) return entry.action;
	return `${entry.http_method || "HTTP"} ${entry.http_path || entry.action || "request"}`.trim();
}

function isDestructive(entry: AuditLogEntry) {
	const action = `${entry.action} ${entry.http_method}`.toLowerCase();
	return action.includes("delete") || action.includes("revoke") || action.includes("transfer") || action.includes("remove");
}

function isSensitive(entry: AuditLogEntry) {
	return entry.sensitivity !== "" && entry.sensitivity !== "standard" && entry.sensitivity !== "normal";
}

function resourceLabel(entry: AuditLogEntry) {
	return entry.resource_name || entry.resource_id || entry.http_path || "-";
}

function detailLine(entry: AuditLogEntry) {
	return entry.detail || entry.http_path || entry.request_id || "No detail recorded";
}

const AUDIT_HEAD = (
	<TableRow>
		<TableHead className="w-42 text-[11px]">Time</TableHead>
		<TableHead className="min-w-72 text-[11px]">Event</TableHead>
		<TableHead className="min-w-56 text-[11px]">Actor</TableHead>
		<TableHead className="min-w-56 text-[11px]">Resource</TableHead>
		<TableHead className="w-34 text-[11px]">Result</TableHead>
		<TableHead className="w-24 text-right text-[11px]">Details</TableHead>
	</TableRow>
);

function auditRow(entry: AuditLogEntry, onOpen: (entry: AuditLogEntry) => void) {
	const destructive = isDestructive(entry);
	const sensitive = isSensitive(entry);
	return (
		<TableRow className={cn("text-xs", destructive && "border-l-2 border-l-destructive", sensitive && !destructive && "border-l-2 border-l-warning")}>
			<TableCell className="whitespace-nowrap align-top font-mono text-[11px] text-muted-foreground">
				{formatActivityTime(entry.timestamp)}
				<div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/80">
					<Clock3 className="h-3 w-3" />
					{Number.isFinite(entry.duration_ms) ? `${entry.duration_ms} ms` : "-"}
				</div>
			</TableCell>
			<TableCell className="align-top">
				<div className="flex min-w-0 items-center gap-2">
					{destructive ? <Trash2 className="h-3.5 w-3.5 shrink-0 text-destructive" /> : sensitive ? <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warning" /> : <ScrollText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
					<span className="truncate font-medium text-foreground">{actionLabel(entry)}</span>
				</div>
				<div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{detailLine(entry)}</div>
				{(destructive || sensitive) && (
					<div className="mt-1 flex flex-wrap gap-1">
						{destructive && (
							<Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] text-destructive">
								<AlertTriangle className="h-3 w-3" /> Destructive
							</Badge>
						)}
						{sensitive && (
							<Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] text-warning">
								<ShieldAlert className="h-3 w-3" /> Sensitive
							</Badge>
						)}
					</div>
				)}
			</TableCell>
			<TableCell className="max-w-60 align-top">
				<div className="truncate">{entry.actor_email || <span className="italic text-muted-foreground">anonymous</span>}</div>
				<div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{entry.actor_role || entry.actor_id || "system"}</div>
			</TableCell>
			<TableCell className="max-w-64 align-top">
				<div className="truncate font-medium">{resourceLabel(entry)}</div>
				<div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{entry.resource_type || "request"}</div>
			</TableCell>
			<TableCell className="align-top">
				{outcomeBadge(entry.outcome)}
				<div className="mt-1 font-mono text-[11px] text-muted-foreground">HTTP {entry.status_code || "-"}</div>
			</TableCell>
			<TableCell className="align-top text-right">
				<Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onOpen(entry)}>
					<Eye className="h-3.5 w-3.5" />
					<span className="sr-only">Open audit event details</span>
				</Button>
			</TableCell>
		</TableRow>
	);
}

function DetailField({ label, value }: { label: string; value?: string | number | null }) {
	const shown = value === undefined || value === null || value === "" ? "-" : value;
	return (
		<div className="min-w-0 border-t border-border/60 py-2">
			<div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
			<div className="mt-1 wrap-break-word font-mono text-xs text-foreground">{shown}</div>
		</div>
	);
}

function AuditDetailDialog({ entry, onOpenChange }: { entry: AuditLogEntry | null; onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog open={!!entry} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-3xl">
				{entry && (
					<>
						<DialogHeader>
							<DialogTitle className="font-display text-base">{actionLabel(entry)}</DialogTitle>
							<DialogDescription>
								{formatActivityTime(entry.timestamp)} by {entry.actor_email || "anonymous"}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-x-4 sm:grid-cols-2">
							<DetailField label="Event ID" value={entry.event_id} />
							<DetailField label="Request ID" value={entry.request_id} />
							<DetailField label="Actor" value={entry.actor_email || entry.actor_id || "anonymous"} />
							<DetailField label="Actor role" value={entry.actor_role} />
							<DetailField label="Resource type" value={entry.resource_type} />
							<DetailField label="Resource" value={resourceLabel(entry)} />
							<DetailField label="HTTP request" value={`${entry.http_method || "-"} ${entry.http_path || ""}`.trim()} />
							<DetailField label="Status / outcome" value={`${entry.status_code || "-"} / ${entry.outcome || "recorded"}`} />
							<DetailField label="IP address" value={entry.ip_address} />
							<DetailField label="Source" value={entry.source} />
							<DetailField label="Sensitivity" value={entry.sensitivity} />
							<DetailField label="Duration" value={Number.isFinite(entry.duration_ms) ? `${entry.duration_ms} ms` : "-"} />
							<DetailField label="Chain hash" value={entry.chain_hash} />
							<DetailField label="User agent" value={entry.user_agent} />
						</div>
						<div className="border-t border-border/60 pt-3">
							<div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Detail</div>
							<pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-muted/20 p-3 whitespace-pre-wrap wrap-break-word font-mono text-xs">{entry.detail || "No detail recorded"}</pre>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

export default function OrganizationAuditLogPage() {
	const org = useAdministeredOrg();
	const canRead = hasPermission(org, PERMISSIONS.orgAuditRead);
	const [selected, setSelected] = useState<AuditLogEntry | null>(null);
	const feed = useActivityFeed(AUDIT_FILTERS, AUDIT_SORT_OPTIONS);
	const query = useOrgAuditLog(canRead ? org?.slug : undefined, feed.params);

	if (!org || !canRead) return <NotFoundState />;

	return (
		<>
		<ActivityFeedView<AuditLogEntry>
			filters={AUDIT_FILTERS}
			feed={feed}
			query={query}
			sortOptions={AUDIT_SORT_OPTIONS}
			head={AUDIT_HEAD}
			getKey={(entry) => entry.event_id}
			renderRow={(entry) => auditRow(entry, setSelected)}
			empty={{
				icon: ScrollText,
				title: "No audit entries",
				description: "Organization activity will appear here as it is recorded.",
			}}
			noResults={{
				title: "No audit events match these filters",
				description: "Clear filters or broaden the time range to continue investigating.",
			}}
		/>
		<AuditDetailDialog entry={selected} onOpenChange={(open) => !open && setSelected(null)} />
		</>
	);
}
