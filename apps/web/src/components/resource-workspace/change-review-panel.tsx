// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// In-context review surface for a resource's open change: the diff is the
// primary object, with review actions for those holding review authority and
// the issue thread anchoring feedback to the exact change. Rendered inside the
// resource workspace (?view=review) so the change never leaves the resource
// it belongs to; inbox notifications deep-link straight here.

import { ArrowLeft, GitPullRequest } from "lucide-react";
import { ChangeReviewBody } from "@/components/review/review-diff-sheet";
import { ReviewIssuesPanel } from "@/components/review/review-issues";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { DetailSkeleton } from "@/components/shared/skeleton-layouts";
import { Button } from "@/components/ui/button";
import { useReviewAction, useReviewDetail, useWhoami } from "@/hooks/use-api";
import { apiErrorStatus, getUserRole, getUserUsername } from "@/lib/api";
import { hasMinRole } from "@/hooks/use-role-guard";

export function ChangeReviewPanel({
	subjectId,
	onBack,
}: {
	/** The resource id; a pending change is keyed by the resource it belongs to. */
	subjectId: string;
	/** Return to the resource's change history. */
	onBack: () => void;
}) {
	const { data, isLoading, isError, error, refetch } = useReviewDetail(subjectId);
	const reviewAction = useReviewAction();
	useWhoami();

	const role = getUserRole();
	const username = getUserUsername();
	const status = apiErrorStatus(error);

	if (isLoading) {
		return <DetailSkeleton />;
	}
	if (isError && status === 404) {
		return (
			<EmptyState
				icon={GitPullRequest}
				title="No open change to review"
				description="This change was already decided or withdrawn. Its outcome lives in the change history."
				actionLabel="View change history"
				onAction={onBack}
			/>
		);
	}
	if (isError || !data) {
		return <ErrorState message={error?.message} onRetry={() => refetch()} />;
	}

	const item = data;
	// Server-side capability scope is authoritative; this only decides whether
	// to render action buttons. The submitter reviews nothing of their own.
	const isOwnChange = !!username && item.submitted_by === username;
	const canAct = hasMinRole(role, "reviewer") && !isOwnChange;
	const canOpenIssues = hasMinRole(role, "reviewer") || isOwnChange;

	return (
		<div className="space-y-4">
			<Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={onBack}>
				<ArrowLeft className="h-3.5 w-3.5" />
				All changes
			</Button>
			<div className="h-[70vh] min-h-96 overflow-hidden rounded-md border border-border">
				<ChangeReviewBody
					standalone
					showActions={canAct}
					item={item}
					onOpenChange={onBack}
					onApprove={(id, type, category) =>
						reviewAction.mutate({ id, type, action: "approve", category }, { onSuccess: onBack })
					}
					onReject={(id, reason, type) =>
						reviewAction.mutate({ id, type, action: "reject", reason }, { onSuccess: onBack })
					}
				/>
			</div>
			<div className="max-w-3xl">
				<ReviewIssuesPanel subjectId={subjectId} canOpenIssues={canOpenIssues} />
			</div>
		</div>
	);
}
