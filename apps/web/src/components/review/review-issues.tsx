// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The actionable half of a change review: focused issues anchored to the exact
// context they concern, each with discussion and an explicit open/resolved
// lifecycle. Rendered on the change page next to the diff.

import { useState } from "react";
import { CircleDot, CheckCircle2, CornerDownRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
	useCommentReviewIssue,
	useCreateReviewIssue,
	useReviewIssues,
	useSetReviewIssueStatus,
} from "@/hooks/use-api";
import type { ReviewIssue } from "@/lib/types";

function actorName(actor: ReviewIssue["author"]): string {
	return actor?.username || actor?.name || "unknown";
}

function timeLabel(value?: string | null): string {
	if (!value) return "";
	return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function IssueRow({
	issue,
	onSetStatus,
	onComment,
	busy,
}: {
	issue: ReviewIssue;
	onSetStatus: (status: "open" | "resolved") => void;
	onComment: (body: string) => void;
	busy: boolean;
}) {
	const [expanded, setExpanded] = useState(issue.status === "open");
	const [reply, setReply] = useState("");
	const open = issue.status === "open";

	return (
		<div className="border border-border rounded-md">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="flex w-full items-start gap-2 px-3 py-2 text-left"
			>
				{open ? (
					<CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
				) : (
					<CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
				)}
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{issue.title}</span>
					<span className="block text-[11px] text-muted-foreground">
						{actorName(issue.author)} · {timeLabel(issue.created_at)}
						{issue.context ? (
							<>
								{" · "}
								<span className="font-mono">{issue.context}</span>
							</>
						) : null}
					</span>
				</span>
				{issue.comments.length > 0 && (
					<Badge variant="outline" className="text-[10px]">
						{issue.comments.length}
					</Badge>
				)}
			</button>
			{expanded && (
				<div className="space-y-2 border-t border-border px-3 py-2.5">
					{issue.body && <p className="whitespace-pre-wrap text-xs text-foreground/90">{issue.body}</p>}
					{issue.comments.map((comment) => (
						<div key={comment.id} className="flex items-start gap-1.5 text-xs">
							<CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
							<div className="min-w-0">
								<span className="font-medium">{actorName(comment.author)}</span>{" "}
								<span className="text-muted-foreground">{timeLabel(comment.created_at)}</span>
								<p className="whitespace-pre-wrap text-foreground/90">{comment.body}</p>
							</div>
						</div>
					))}
					{!open && issue.resolved_by && (
						<p className="text-[11px] text-muted-foreground">
							Resolved by {actorName(issue.resolved_by)} {timeLabel(issue.resolved_at)}
						</p>
					)}
					<div className="flex items-center gap-1.5 pt-0.5">
						<Input
							value={reply}
							onChange={(e) => setReply(e.target.value)}
							placeholder="Reply…"
							className="h-7 flex-1 text-xs"
							onKeyDown={(e) => {
								if (e.key === "Enter" && reply.trim()) {
									onComment(reply.trim());
									setReply("");
								}
							}}
						/>
						<Button
							size="sm"
							variant="outline"
							className="h-7 px-2 text-xs"
							disabled={busy}
							onClick={() => onSetStatus(open ? "resolved" : "open")}
						>
							{open ? "Resolve" : "Reopen"}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

export function ReviewIssuesPanel({
	subjectId,
	versionId,
	canOpenIssues,
}: {
	subjectId: string;
	versionId?: string;
	canOpenIssues: boolean;
}) {
	const { data, isLoading } = useReviewIssues(subjectId);
	const createIssue = useCreateReviewIssue(subjectId);
	const setStatus = useSetReviewIssueStatus(subjectId);
	const comment = useCommentReviewIssue(subjectId);

	const [creating, setCreating] = useState(false);
	const [title, setTitle] = useState("");
	const [context, setContext] = useState("");
	const [body, setBody] = useState("");

	const issues = data?.issues ?? [];
	const openCount = data?.open_count ?? 0;

	const submit = () => {
		if (!title.trim()) return;
		createIssue.mutate(
			{
				title: title.trim(),
				body: body.trim() || undefined,
				context: context.trim() || undefined,
				version_id: versionId,
			},
			{
				onSuccess: () => {
					setTitle("");
					setContext("");
					setBody("");
					setCreating(false);
				},
				onError: (e) => toast.error(e instanceof Error ? e.message : "Could not open issue"),
			},
		);
	};

	return (
		<section aria-label="Review issues" className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					Issues{openCount > 0 ? ` - ${openCount} open` : ""}
				</h3>
				{canOpenIssues && !creating && (
					<Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setCreating(true)}>
						<Plus className="mr-1 h-3 w-3" />
						New issue
					</Button>
				)}
			</div>
			{creating && (
				<div className="space-y-1.5 rounded-md border border-border p-2.5">
					<Input
						autoFocus
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="What needs to change?"
						className="h-7 text-xs"
					/>
					<Input
						value={context}
						onChange={(e) => setContext(e.target.value)}
						placeholder="Context (optional): field, component, or diff location"
						className="h-7 font-mono text-xs"
					/>
					<Textarea
						value={body}
						onChange={(e) => setBody(e.target.value)}
						placeholder="Details (optional)"
						className="min-h-14 text-xs"
					/>
					<div className="flex justify-end gap-1.5">
						<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCreating(false)}>
							Cancel
						</Button>
						<Button
							size="sm"
							className="h-7 text-xs"
							disabled={!title.trim() || createIssue.isPending}
							onClick={submit}
						>
							Open issue
						</Button>
					</div>
				</div>
			)}
			{isLoading ? (
				<p className="text-xs text-muted-foreground">Loading issues…</p>
			) : issues.length === 0 ? (
				<p className="text-xs text-muted-foreground">No issues raised on this change.</p>
			) : (
				<div className="space-y-1.5">
					{issues.map((issue) => (
						<IssueRow
							key={issue.id}
							issue={issue}
							busy={setStatus.isPending}
							onSetStatus={(status) =>
								setStatus.mutate(
									{ issueId: issue.id, status },
									{ onError: (e) => toast.error(e instanceof Error ? e.message : "Not allowed") },
								)
							}
							onComment={(text) => comment.mutate({ issueId: issue.id, body: text })}
						/>
					))}
				</div>
			)}
		</section>
	);
}
