// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Attribution roster for one resource: who contributed, through which
// mechanisms (changes, published versions, reviews, issues, discussion), and
// when they were last active. Accountability and maintainability, not a
// leaderboard.

import { Users, Crown } from "lucide-react";
import { useResourceContributors } from "@/hooks/use-api";
import { EmptyState } from "@/components/shared/empty-state";
import { eventTime } from "./activity-panel";
import type { ResourceContributor } from "@/lib/types";

function contributorName(user: ResourceContributor["user"]): string {
	return user?.username || user?.name || "unknown";
}

const COLUMNS: { key: keyof ResourceContributor; label: string }[] = [
	{ key: "changes_opened", label: "Changes" },
	{ key: "versions_published", label: "Published" },
	{ key: "reviews", label: "Reviews" },
	{ key: "issues_opened", label: "Issues" },
	{ key: "issues_resolved", label: "Resolved" },
	{ key: "comments", label: "Comments" },
];

export function ContributorsPanel({ subjectId }: { subjectId: string }) {
	const { data, isLoading } = useResourceContributors(subjectId);

	if (isLoading) {
		return <p className="py-4 text-xs text-muted-foreground">Loading contributors…</p>;
	}
	const contributors = data?.contributors ?? [];
	if (contributors.length === 0) {
		return (
			<EmptyState
				icon={Users}
				title="No contributors yet"
				description="Everyone who opens changes, reviews, or resolves issues on this resource appears here."
			/>
		);
	}

	return (
		<div className="overflow-x-auto rounded-md border border-border">
			<table className="w-full border-collapse text-sm">
				<thead>
					<tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
						<th className="px-3 py-2 font-medium">Contributor</th>
						{COLUMNS.map((col) => (
							<th key={col.key} className="px-3 py-2 text-right font-medium">
								{col.label}
							</th>
						))}
						<th className="px-3 py-2 text-right font-medium">Last activity</th>
					</tr>
				</thead>
				<tbody>
					{contributors.map((contributor) => (
						<tr
							key={contributor.user?.id ?? contributorName(contributor.user)}
							className="border-b border-border/60 last:border-b-0 hover:bg-muted/30"
						>
							<td className="px-3 py-2">
								<span className="inline-flex items-center gap-1.5 font-medium">
									{contributorName(contributor.user)}
									{contributor.is_creator && (
										<span
											title="Resource creator"
											className="inline-flex items-center gap-1 rounded border border-border px-1 py-0.5 text-[10px] font-normal text-muted-foreground"
										>
											<Crown className="h-2.5 w-2.5" />
											creator
										</span>
									)}
								</span>
							</td>
							{COLUMNS.map((col) => {
								const value = contributor[col.key] as number;
								return (
									<td
										key={col.key}
										className={`px-3 py-2 text-right font-mono text-xs tabular-nums ${value === 0 ? "text-muted-foreground/40" : ""}`}
									>
										{value}
									</td>
								);
							})}
							<td className="px-3 py-2 text-right text-xs text-muted-foreground">
								{eventTime(contributor.last_activity_at)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
