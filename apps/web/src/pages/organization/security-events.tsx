// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Fragment, useState } from "react";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { NotFoundState } from "@/components/shared/not-found-state";
import {
	ActivityFeedView,
	formatActivityTime,
	useActivityFeed,
	type ActivityFilterField,
	type ActivitySortOption,
} from "@/components/organization/activity-feed";
import { useOrgSecurityEvents } from "@/hooks/use-orgs-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useAdministeredOrg } from "@/pages/organization/shell";
import type { SecurityEvent } from "@/lib/types";

const SECURITY_FILTERS: ActivityFilterField[] = [
	{ key: "q", label: "Search", placeholder: "Search event, actor, target, IP, or detail...", width: "w-80" },
	{
		key: "severity",
		label: "Severity",
		width: "w-36",
		options: [
			{ value: "info", label: "Info" },
			{ value: "warning", label: "Warning" },
			{ value: "high", label: "High" },
			{ value: "critical", label: "Critical" },
		],
	},
	{
		key: "outcome",
		label: "Outcome",
		width: "w-36",
		options: [
			{ value: "success", label: "Success" },
			{ value: "denied", label: "Denied" },
			{ value: "blocked", label: "Blocked" },
			{ value: "throttled", label: "Throttled" },
			{ value: "failure", label: "Failure" },
			{ value: "error", label: "Error" },
		],
	},
	{
		key: "category",
		label: "Category",
		width: "w-40",
		advanced: true,
		options: [
			{ value: "auth", label: "Authentication" },
			{ value: "organization", label: "Organization" },
			{ value: "membership", label: "Membership" },
			{ value: "project", label: "Project" },
			{ value: "invitation", label: "Invitation" },
			{ value: "settings", label: "Security settings" },
		],
	},
	{
		key: "event_type",
		label: "Event type",
		width: "w-56",
		advanced: true,
		options: [
			{ value: "org.created", label: "Organization created" },
			{ value: "org.renamed", label: "Organization renamed" },
			{ value: "org.deleted", label: "Organization deleted" },
			{ value: "org.membership.changed", label: "Membership changed" },
			{ value: "org.ownership.transferred", label: "Ownership transferred" },
			{ value: "org.project.created", label: "Project created" },
			{ value: "org.project.deleted", label: "Project deleted" },
			{ value: "org.project.membership.changed", label: "Project membership changed" },
			{ value: "org.project.retention.changed", label: "Retention changed" },
			{ value: "org.invitation.created", label: "Invitation created" },
			{ value: "org.invitation.revoked", label: "Invitation revoked" },
			{ value: "org.invitation.accepted", label: "Invitation accepted" },
		],
	},
	{ key: "actor", label: "Actor email", placeholder: "actor@example.com", width: "w-56", advanced: true },
	{
		key: "target",
		label: "Project, resource, or affected user",
		placeholder: "project, resource, user, or target id",
		width: "w-72",
		advanced: true,
	},
	{
		key: "target_type",
		label: "Scope",
		width: "w-40",
		advanced: true,
		options: [
			{ value: "organization", label: "Organization" },
			{ value: "project", label: "Project" },
			{ value: "user", label: "User" },
			{ value: "resource", label: "Resource" },
			{ value: "endpoint", label: "Endpoint" },
		],
	},
	{ key: "source_ip", label: "Source IP", placeholder: "127.0.0.1", width: "w-40", advanced: true },
	{ key: "start_date", label: "From date", width: "w-40", advanced: true, type: "date" },
	{ key: "end_date", label: "To date", width: "w-40", advanced: true, type: "date" },
];

const SECURITY_SORT_OPTIONS: ActivitySortOption[] = [
	{ value: "newest", label: "Newest first" },
	{ value: "oldest", label: "Oldest first" },
	{ value: "event_type", label: "Event type" },
	{ value: "outcome", label: "Outcome" },
];

const SECURITY_HEAD = (
	<TableRow>
		<TableHead className="w-40 text-[11px]">Time</TableHead>
		<TableHead className="w-32 text-[11px]">Priority</TableHead>
		<TableHead className="min-w-72 text-[11px]">Event</TableHead>
		<TableHead className="min-w-48 text-[11px]">Actor</TableHead>
		<TableHead className="min-w-54 text-[11px]">Scope</TableHead>
		<TableHead className="w-28 text-[11px]">Result</TableHead>
		<TableHead className="w-14 text-[11px]" aria-label="Event details" />
	</TableRow>
);

type SecurityEventPriority = "informational" | "suspicious" | "blocked" | "failed" | "critical";

function eventPriority(event: SecurityEvent): SecurityEventPriority {
	const severity = event.severity.toLowerCase();
	const outcome = event.outcome.toLowerCase();
	const type = event.event_type.toLowerCase();
	if (severity === "critical" || severity === "high") return "critical";
	if (["blocked", "denied", "throttled"].includes(outcome)) return "blocked";
	if (["failure", "failed", "error"].includes(outcome)) return "failed";
	if (severity === "warning" || type.includes("failed") || type.includes("revoked")) return "suspicious";
	return "informational";
}

function priorityBadge(event: SecurityEvent) {
	const priority = eventPriority(event);
	const classes: Record<SecurityEventPriority, string> = {
		informational: "border-info/30 bg-info/10 text-info",
		suspicious: "border-warning/35 bg-warning/10 text-warning",
		blocked: "border-warning/45 bg-warning/15 text-warning",
		failed: "border-destructive/35 bg-destructive/10 text-destructive",
		critical: "border-destructive/60 bg-destructive/15 text-destructive",
	};
	return <Badge className={cn("text-[10px] uppercase", classes[priority])}>{priority}</Badge>;
}

function outcomeBadge(outcome: string) {
	if (outcome === "success") return <Badge className="border-success/30 bg-success/10 text-[10px] text-success">success</Badge>;
	if (["denied", "blocked", "throttled"].includes(outcome)) return <Badge className="border-warning/35 bg-warning/10 text-[10px] text-warning">{outcome}</Badge>;
	if (["failure", "failed", "error"].includes(outcome)) return <Badge variant="destructive" className="text-[10px]">{outcome}</Badge>;
	return <Badge variant="outline" className="text-[10px]">{outcome || "recorded"}</Badge>;
}

function formatEventType(type: string) {
	return type.replace(/^org\./, "").replaceAll(".", " ").replaceAll("_", " ");
}

function compactId(value: string) {
	if (!value) return "-";
	return value.length > 24 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function securityRow(event: SecurityEvent, expanded: boolean, toggle: () => void) {
	const actor = event.actor_email || "system";
	const scope = event.target_type || "organization";
	return (
		<Fragment>
			<TableRow className="text-xs data-[state=open]:bg-muted/25" data-state={expanded ? "open" : undefined}>
				<TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
					{formatActivityTime(event.timestamp)}
				</TableCell>
				<TableCell>{priorityBadge(event)}</TableCell>
				<TableCell className="max-w-sm">
					<div className="truncate font-medium capitalize">{formatEventType(event.event_type)}</div>
					<div className="truncate text-[11px] text-muted-foreground">{event.detail || event.event_type}</div>
				</TableCell>
				<TableCell className="max-w-56">
					<div className={cn("truncate", !event.actor_email && "italic text-muted-foreground")}>{actor}</div>
					<div className="truncate text-[11px] text-muted-foreground">{event.actor_role || "no role"}</div>
				</TableCell>
				<TableCell className="max-w-60">
					<div className="truncate capitalize">{scope}</div>
					<div className="truncate font-mono text-[11px] text-muted-foreground">{compactId(event.target_id)}</div>
				</TableCell>
				<TableCell>{outcomeBadge(event.outcome)}</TableCell>
				<TableCell>
					<Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggle} aria-expanded={expanded} aria-label="Toggle event details">
						<ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
					</Button>
				</TableCell>
			</TableRow>
			{expanded && (
				<TableRow className="bg-muted/15 text-xs hover:bg-muted/15">
					<TableCell colSpan={7} className="p-0">
						<div className="grid gap-x-8 gap-y-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
							<DetailTerm label="Event ID" value={event.event_id} mono />
							<DetailTerm label="Type" value={event.event_type} mono />
							<DetailTerm label="Severity" value={event.severity || "info"} />
							<DetailTerm label="Actor ID" value={event.actor_id || "system"} mono />
							<DetailTerm label="Source IP" value={event.source_ip || "not recorded"} mono />
							<DetailTerm label="User agent" value={event.user_agent || "not recorded"} />
							<DetailTerm label="Target type" value={event.target_type || "organization"} />
							<DetailTerm label="Target ID" value={event.target_id || "not recorded"} mono />
							<DetailTerm label="Detail" value={event.detail || "No additional context recorded."} wide />
						</div>
					</TableCell>
				</TableRow>
			)}
		</Fragment>
	);
}

function DetailTerm({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
	return (
		<div className={cn("min-w-0", wide && "sm:col-span-2 lg:col-span-3")}>
			<div className="text-[10px] uppercase text-muted-foreground">{label}</div>
			<div className={cn("mt-1 wrap-break-word", mono && "font-mono text-[11px]")}>{value}</div>
		</div>
	);
}

export default function OrganizationSecurityEventsPage() {
	const org = useAdministeredOrg();
	const canRead = hasPermission(org, PERMISSIONS.orgSecurityRead);
	const feed = useActivityFeed(SECURITY_FILTERS, SECURITY_SORT_OPTIONS);
	const query = useOrgSecurityEvents(canRead ? org?.slug : undefined, feed.params);
	const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

	if (!org || !canRead) return <NotFoundState />;

	return (
		<ActivityFeedView<SecurityEvent>
			filters={SECURITY_FILTERS}
			feed={feed}
			query={query}
			sortOptions={SECURITY_SORT_OPTIONS}
			head={SECURITY_HEAD}
			getKey={(event) => event.event_id}
			renderRow={(event) =>
				securityRow(event, expandedEvent === event.event_id, () =>
					setExpandedEvent((current) => (current === event.event_id ? null : event.event_id)),
				)
			}
			empty={{
				icon: ShieldAlert,
				title: "No security events",
				description: "Organization security activity will appear here when it is recorded.",
			}}
			noResults={{
				title: "No matching security events",
				description: "Adjust the search, time range, or investigation filters to widen the result set.",
			}}
		/>
	);
}
