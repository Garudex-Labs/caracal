// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The change-request view of a resource's versions: open work first (pending
// drafts under review), then decided history (merged and rejected changes),
// with the unresolved-issue count surfaced where the decision happens.

import { CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, Hammer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { eventTime } from "./activity-panel";
import type { WorkspaceVersionRow } from "./versions-panel";

function ChangeRow({
	row,
	onOpenChange,
	openIssueCount,
}: {
	row: WorkspaceVersionRow;
	onOpenChange?: () => void;
	openIssueCount?: number;
}) {
	const icon =
		row.status === "approved" ? (
			<GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-success" />
		) : row.status === "rejected" ? (
			<GitPullRequestClosed className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
		) : (
			<GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-info" />
		);
	const stateLabel =
		row.status === "approved"
			? "merged"
			: row.status === "rejected"
				? "rejected"
				: row.status === "draft"
					? "draft"
					: "in review";
	const isOpen = row.status === "pending" || row.status === "draft";

	const body = (
		<div className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-muted/30">
			{icon}
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
					<span className="font-mono font-medium">v{row.version}</span>
					<Badge variant="outline" className="text-[10px]">
						{stateLabel}
					</Badge>
					{isOpen && (openIssueCount ?? 0) > 0 && (
						<span className="inline-flex items-center gap-1 text-[11px] text-warning">
							<CircleDot className="h-3 w-3" />
							{openIssueCount} open issue{openIssueCount !== 1 ? "s" : ""}
						</span>
					)}
				</div>
				{row.description && (
					<p className="mt-0.5 truncate text-xs text-muted-foreground">{row.description}</p>
				)}
				{row.status === "rejected" && row.rejection_reason && (
					<p className="mt-0.5 truncate text-xs text-destructive/90">{row.rejection_reason}</p>
				)}
			</div>
			<span className="shrink-0 text-[11px] text-muted-foreground">
				{eventTime(row.released_at ?? row.created_at)}
			</span>
		</div>
	);

	return isOpen && onOpenChange ? (
		<button type="button" onClick={onOpenChange} className="block w-full text-left">
			{body}
		</button>
	) : (
		body
	);
}

export function ChangesPanel({
	rows,
	isLoading,
	onOpenChange,
	openIssueCount,
	canPropose,
	proposeLabel = "Propose change",
	onPropose,
}: {
	rows: WorkspaceVersionRow[];
	isLoading?: boolean;
	/** Open the in-context review surface for this resource's pending change. */
	onOpenChange?: () => void;
	openIssueCount?: number;
	canPropose?: boolean;
	proposeLabel?: string;
	onPropose?: () => void;
}) {
	if (isLoading) {
		return <p className="py-4 text-xs text-muted-foreground">Loading changes…</p>;
	}

	const open = rows.filter((row) => row.status === "pending" || row.status === "draft");
	const decided = rows.filter((row) => row.status === "approved" || row.status === "rejected");

	return (
		<div className="space-y-5">
			<section className="space-y-2">
				<div className="flex items-center justify-between">
					<h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						Open changes{open.length > 0 ? ` - ${open.length}` : ""}
					</h3>
					{canPropose && onPropose && (
						<Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" onClick={onPropose}>
							<Hammer className="h-3.5 w-3.5" />
							{proposeLabel}
						</Button>
					)}
				</div>
				{open.length === 0 ? (
					<p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
						No changes waiting for review.
					</p>
				) : (
					<div className="space-y-2">
						{open.map((row) => (
							<ChangeRow key={row.id} row={row} onOpenChange={onOpenChange} openIssueCount={openIssueCount} />
						))}
					</div>
				)}
			</section>

			{decided.length > 0 ? (
				<section className="space-y-2">
					<h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						Decided
					</h3>
					<div className="space-y-2">
						{decided.map((row) => (
							<ChangeRow key={row.id} row={row} />
						))}
					</div>
				</section>
			) : (
				open.length === 0 && (
					<EmptyState
						icon={GitPullRequest}
						title="No change history"
						description="Every proposed version of this resource appears here with its review outcome."
					/>
				)
			)}
		</div>
	);
}
