// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { ShieldAlert } from "lucide-react";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { NotFoundState } from "@/components/shared/not-found-state";
import {
	ActivityFeedView,
	formatActivityTime,
	useActivityFeed,
	type ActivityFilterField,
} from "@/components/organization/activity-feed";
import { useOrgSecurityEvents } from "@/hooks/use-orgs-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { useAdministeredOrg } from "@/pages/organization/shell";
import type { SecurityEvent } from "@/lib/types";

const SECURITY_FILTERS: ActivityFilterField[] = [
	{ key: "q", label: "Search", placeholder: "Search event, actor, or detail…", width: "w-72" },
	{
		key: "event_type",
		label: "Events",
		width: "w-56",
		options: [
			{ value: "org.created", label: "Organization created" },
			{ value: "org.renamed", label: "Organization renamed" },
			{ value: "org.deleted", label: "Organization deleted" },
			{ value: "org.membership.changed", label: "Membership changed" },
			{ value: "org.ownership.transferred", label: "Ownership transferred" },
			{ value: "org.project.created", label: "Project created" },
			{ value: "org.project.deleted", label: "Project deleted" },
			{ value: "org.project.membership.changed", label: "Project membership changed" },
			{ value: "org.invitation.created", label: "Invitation created" },
			{ value: "org.invitation.revoked", label: "Invitation revoked" },
			{ value: "org.invitation.accepted", label: "Invitation accepted" },
		],
	},
	{ key: "actor", label: "Actor email", placeholder: "actor@example.com", width: "w-56" },
];

const SECURITY_HEAD = (
	<TableRow>
		<TableHead className="w-37.5 text-[11px]">Time</TableHead>
		<TableHead className="text-[11px]">Event</TableHead>
		<TableHead className="text-[11px]">Actor</TableHead>
		<TableHead className="text-[11px]">Detail</TableHead>
	</TableRow>
);

function securityRow(event: SecurityEvent) {
	return (
		<TableRow className="text-xs">
			<TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
				{formatActivityTime(event.timestamp)}
			</TableCell>
			<TableCell className="font-mono text-[11px]">{event.event_type}</TableCell>
			<TableCell className="max-w-45 truncate">
				{event.actor_email || <span className="italic text-muted-foreground">system</span>}
			</TableCell>
			<TableCell className="max-w-90 truncate text-muted-foreground">{event.detail || "-"}</TableCell>
		</TableRow>
	);
}

export default function OrganizationSecurityEventsPage() {
	const org = useAdministeredOrg();
	const canRead = hasPermission(org, PERMISSIONS.orgSecurityRead);
	const feed = useActivityFeed(SECURITY_FILTERS);
	const query = useOrgSecurityEvents(canRead ? org?.slug : undefined, feed.params);

	if (!org || !canRead) return <NotFoundState />;

	return (
		<ActivityFeedView<SecurityEvent>
			filters={SECURITY_FILTERS}
			feed={feed}
			query={query}
			head={SECURITY_HEAD}
			getKey={(event) => event.event_id}
			renderRow={securityRow}
			empty={{
				icon: ShieldAlert,
				title: "No security events",
				description: "Membership, invitation, and organization changes will appear here.",
			}}
		/>
	);
}
