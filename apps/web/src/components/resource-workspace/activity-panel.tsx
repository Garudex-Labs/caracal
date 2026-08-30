// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Immutable lifecycle timeline for one resource: creation, changes opened,
// versions published, rejections, restores, and the issue conversation - each
// event attributed and linked to the object it concerns.

import { useState } from "react";
import {
	CircleDot,
	CheckCircle2,
	GitPullRequest,
	GitMerge,
	History,
	MessageSquare,
	PackagePlus,
	XCircle,
	RotateCcw,
	type LucideIcon,
} from "lucide-react";
import { useResourceActivity } from "@/hooks/use-api";
import type { ResourceActivityEvent, ResourceActivityEventType } from "@/lib/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PickerSelect } from "@/components/ui/picker-select";

const EVENT_META: Record<
	ResourceActivityEventType,
	{ icon: LucideIcon; label: string; tone: string }
> = {
	resource_created: { icon: PackagePlus, label: "created this resource", tone: "text-muted-foreground" },
	change_opened: { icon: GitPullRequest, label: "opened a change", tone: "text-info" },
	version_published: { icon: GitMerge, label: "published version", tone: "text-success" },
	change_rejected: { icon: XCircle, label: "rejected change", tone: "text-destructive" },
	version_restored: { icon: RotateCcw, label: "restored a previous version as", tone: "text-warning" },
	issue_opened: { icon: CircleDot, label: "opened issue", tone: "text-warning" },
	issue_comment: { icon: MessageSquare, label: "commented on issue", tone: "text-muted-foreground" },
	issue_resolved: { icon: CheckCircle2, label: "resolved issue", tone: "text-success" },
};

const FILTERS = [
	{ value: "all", label: "All activity" },
	{ value: "versions", label: "Versions & changes" },
	{ value: "issues", label: "Issues & discussion" },
];

const VERSION_EVENTS = new Set<ResourceActivityEventType>([
	"resource_created",
	"change_opened",
	"version_published",
	"change_rejected",
	"version_restored",
]);

function actorName(actor: ResourceActivityEvent["actor"]): string {
	return actor?.username || actor?.name || "unknown";
}

export function eventTime(value?: string | null): string {
	if (!value) return "";
	const date = new Date(value);
	const deltaMs = Date.now() - date.getTime();
	const days = Math.floor(deltaMs / 86_400_000);
	if (days < 1) {
		const hours = Math.floor(deltaMs / 3_600_000);
		if (hours < 1) {
			const minutes = Math.max(0, Math.floor(deltaMs / 60_000));
			return `${minutes}m ago`;
		}
		return `${hours}h ago`;
	}
	if (days < 30) return `${days}d ago`;
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function EventRow({ event, onOpenChange }: { event: ResourceActivityEvent; onOpenChange?: () => void }) {
	const meta = EVENT_META[event.type] ?? EVENT_META.change_opened;
	const Icon = meta.icon;
	return (
		<li className="relative flex gap-3 pb-5 last:pb-0">
			<span className="absolute top-5 bottom-0 left-2.25 w-px bg-border group-last:hidden" aria-hidden />
			<span className={`z-10 mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border border-border bg-background ${meta.tone}`}>
				<Icon className="h-3 w-3" />
			</span>
			<div className="min-w-0 flex-1 text-sm">
				<p className="leading-snug">
					<span className="font-medium">{actorName(event.actor)}</span>{" "}
					<span className="text-muted-foreground">{meta.label}</span>
					{event.version && (
						<>
							{" "}
							{event.type === "change_opened" && onOpenChange ? (
								<button
									type="button"
									onClick={onOpenChange}
									className="font-mono text-[13px] text-primary hover:underline"
								>
									v{event.version}
								</button>
							) : (
								<span className="font-mono text-[13px]">v{event.version}</span>
							)}
						</>
					)}
				</p>
				{event.detail && (
					<p className="mt-0.5 truncate text-xs text-muted-foreground">{event.detail}</p>
				)}
				<p className="mt-0.5 text-[11px] text-muted-foreground/70">{eventTime(event.at)}</p>
			</div>
		</li>
	);
}

export function ActivityPanel({
	subjectId,
	onOpenChange,
	limit = 100,
	compact = false,
}: {
	subjectId: string;
	/** Open the in-context review surface for this resource's pending change. */
	onOpenChange?: () => void;
	limit?: number;
	compact?: boolean;
}) {
	const { data, isLoading } = useResourceActivity(subjectId, limit);
	const [filter, setFilter] = useState("all");

	const events = (data?.events ?? []).filter((event) => {
		if (filter === "versions") return VERSION_EVENTS.has(event.type);
		if (filter === "issues") return !VERSION_EVENTS.has(event.type) || event.type === "resource_created";
		return true;
	});

	if (isLoading) {
		return <p className="py-4 text-xs text-muted-foreground">Loading activity…</p>;
	}
	if (!data || data.events.length === 0) {
		return (
			<EmptyState
				icon={History}
				title="No recorded activity"
				description="Lifecycle events appear here as versions, changes, and issues accumulate."
			/>
		);
	}

	return (
		<div className="space-y-3">
			{!compact && (
				<div className="flex items-center justify-between">
					<p className="text-xs text-muted-foreground">
						{data.total} event{data.total !== 1 ? "s" : ""}
						{data.total > limit ? ` - showing latest ${limit}` : ""}
					</p>
					<PickerSelect
						value={filter}
						onValueChange={setFilter}
						options={FILTERS}
						ariaLabel="Filter activity"
						className="w-44"
						inputClassName="h-7 px-2 text-xs"
					/>
				</div>
			)}
			<ol className="group">
				{events.map((event, i) => (
					<EventRow key={`${event.type}-${event.at}-${i}`} event={event} onOpenChange={onOpenChange} />
				))}
			</ol>
		</div>
	);
}
