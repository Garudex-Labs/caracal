// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { NotFoundState } from "@/components/shared/not-found-state";
import {
	ActivityFeedView,
	formatActivityTime,
	useActivityFeed,
	type ActivityFilterField,
} from "@/components/organization/activity-feed";
import { useOrgAuditLog } from "@/hooks/use-orgs-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { useAdministeredOrg } from "@/pages/organization/shell";
import type { AuditLogEntry } from "@/lib/types";

const AUDIT_FILTERS: ActivityFilterField[] = [
	{ key: "q", label: "Search", placeholder: "Search request, action, or detail…", width: "w-72" },
	{
		key: "outcome",
		label: "Outcomes",
		width: "w-36",
		options: [
			{ value: "success", label: "Success" },
			{ value: "denied", label: "Denied" },
			{ value: "not_found", label: "Not found" },
			{ value: "error", label: "Error" },
		],
	},
	{ key: "actor", label: "Actor email", placeholder: "actor@example.com", width: "w-56" },
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

const AUDIT_HEAD = (
	<TableRow>
		<TableHead className="w-37.5 text-[11px]">Time</TableHead>
		<TableHead className="text-[11px]">Actor</TableHead>
		<TableHead className="text-[11px]">Request</TableHead>
		<TableHead className="w-27.5 text-[11px]">Outcome</TableHead>
		<TableHead className="w-16 text-[11px]">Status</TableHead>
	</TableRow>
);

function auditRow(entry: AuditLogEntry) {
	return (
		<TableRow className="text-xs">
			<TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
				{formatActivityTime(entry.timestamp)}
			</TableCell>
			<TableCell className="max-w-45 truncate">
				{entry.actor_email || <span className="italic text-muted-foreground">anonymous</span>}
			</TableCell>
			<TableCell className="max-w-80 truncate font-mono text-[11px] text-muted-foreground">
				<span className="text-foreground">{entry.http_method}</span> {entry.http_path}
			</TableCell>
			<TableCell>{outcomeBadge(entry.outcome)}</TableCell>
			<TableCell className="font-mono text-[11px] text-muted-foreground">{entry.status_code || "-"}</TableCell>
		</TableRow>
	);
}

export default function OrganizationAuditLogPage() {
	const org = useAdministeredOrg();
	const canRead = hasPermission(org, PERMISSIONS.orgAuditRead);
	const feed = useActivityFeed(AUDIT_FILTERS);
	const query = useOrgAuditLog(canRead ? org?.slug : undefined, feed.params);

	if (!org || !canRead) return <NotFoundState />;

	return (
		<ActivityFeedView<AuditLogEntry>
			filters={AUDIT_FILTERS}
			feed={feed}
			query={query}
			head={AUDIT_HEAD}
			getKey={(entry) => entry.event_id}
			renderRow={auditRow}
			empty={{
				icon: ScrollText,
				title: "No audit entries",
				description: "Organization activity will appear here as it is recorded.",
			}}
		/>
	);
}
