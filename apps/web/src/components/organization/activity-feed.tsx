// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Shared state + presentation for the organization audit and security feeds.
// `useActivityFeed` owns the sort/filter/cursor state and mirrors it into the
// URL (shareable, survives reload); `ActivityFeedView` renders the toolbar,
// table, and cursor pager. Filtering and sorting run at the data layer - these
// only forward controls and render the returned page.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PickerSelect } from "@/components/ui/picker-select";
import { Table, TableBody, TableHeader } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { useDebouncedValue } from "@/components/organization/list-controls";
import { CONTROL_CLASS_NAME } from "@/pages/organization/shell";
import { cn } from "@/lib/utils";
import {
	activityRequestParams,
	activityStateFromSearch,
	activityStateToSearch,
	advance,
	canGoBack,
	currentCursor,
	goBack,
	initialCursorStack,
	pageNumber,
	type ActivityFilters,
	type ActivitySort,
	type CursorStack,
} from "@/lib/activity-log";
import type { ActivityPage } from "@/lib/types";

export interface ActivityFilterField {
	/** API query-parameter name (also the URL key). */
	key: string;
	label: string;
	/** Options make a dropdown; omit for a free-text input (e.g. actor email). */
	options?: { value: string; label: string }[];
	placeholder?: string;
	width?: string;
}

export interface ActivityFeedControls {
	params: Record<string, string>;
	sort: ActivitySort;
	filterValues: ActivityFilters;
	page: number;
	canGoBack: boolean;
	changeFilter: (key: string, value: string) => void;
	changeSort: (value: string) => void;
	clearAll: () => void;
	goNext: (nextCursor: string) => void;
	goPrev: () => void;
}

/**
 * Owns the pagination state for one feed and derives the request params. Kept
 * separate from the query hook so the page calls the data hook at the top level
 * rather than inside a callback.
 */
export function useActivityFeed(filterFields: ActivityFilterField[]): ActivityFeedControls {
	const filterKeys = useMemo(() => filterFields.map((field) => field.key), [filterFields]);
	const [sort, setSort] = useState<ActivitySort>(
		() => activityStateFromSearch(new URLSearchParams(window.location.search), filterKeys).sort,
	);
	const [filterValues, setFilterValues] = useState<ActivityFilters>(
		() => activityStateFromSearch(new URLSearchParams(window.location.search), filterKeys).filters,
	);
	const [stack, setStack] = useState<CursorStack>(() => {
		const cursor = new URLSearchParams(window.location.search).get("cursor");
		return cursor ? [null, cursor] : initialCursorStack;
	});

	const requestFilters = useDebouncedValue(filterValues, 300);
	const params = activityRequestParams({ sort, filters: requestFilters, cursor: currentCursor(stack) });

	useEffect(() => {
		const qs = activityStateToSearch({ sort, filters: filterValues, cursor: currentCursor(stack) }).toString();
		const path = window.location.pathname;
		window.history.replaceState(null, "", qs ? `${path}?${qs}` : path);
	}, [sort, filterValues, stack]);

	return {
		params,
		sort,
		filterValues,
		page: pageNumber(stack),
		canGoBack: canGoBack(stack),
		// A filter or sort change resets to the first page but keeps other filters.
		changeFilter: (key, value) => {
			setFilterValues((prev) => {
				const next = { ...prev };
				if (value) next[key] = value;
				else delete next[key];
				return next;
			});
			setStack(initialCursorStack);
		},
		changeSort: (value) => {
			setSort(value === "asc" ? "asc" : "desc");
			setStack(initialCursorStack);
		},
		clearAll: () => {
			setFilterValues({});
			setStack(initialCursorStack);
		},
		goNext: (nextCursor) => setStack((prev) => advance(prev, nextCursor)),
		goPrev: () => setStack((prev) => goBack(prev)),
	};
}

interface ActivityFeedQuery<T> {
	data?: ActivityPage<T>;
	isLoading: boolean;
	isFetching: boolean;
	isError: boolean;
	error: unknown;
	refetch: () => void;
}

interface ActivityFeedViewProps<T> {
	filters: ActivityFilterField[];
	feed: ActivityFeedControls;
	query: ActivityFeedQuery<T>;
	head: ReactNode;
	getKey: (row: T) => string;
	renderRow: (row: T) => ReactNode;
	empty: { icon: LucideIcon; title: string; description: string };
}

const SORT_OPTIONS = [
	{ value: "desc", label: "Newest first" },
	{ value: "asc", label: "Oldest first" },
];

/** Renders a ClickHouse "YYYY-MM-DD HH:MM:SS.mmm" UTC timestamp in local time. */
export function formatActivityTime(ts: string): string {
	const date = new Date(ts.includes("Z") || ts.includes("+") ? ts : `${ts.replace(" ", "T")}Z`);
	if (Number.isNaN(date.getTime())) return ts;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export function ActivityFeedView<T>({
	filters,
	feed,
	query,
	head,
	getKey,
	renderRow,
	empty,
}: ActivityFeedViewProps<T>) {
	const events = query.data?.events ?? [];
	const hasMore = query.data?.has_more ?? false;
	const nextCursor = query.data?.next_cursor ?? null;
	const activeFilters = Object.keys(feed.filterValues).length;

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				{filters.map((field) =>
					field.options ? (
						<PickerSelect
							key={field.key}
							value={feed.filterValues[field.key] ?? ""}
							onValueChange={(value) => feed.changeFilter(field.key, value)}
							options={[{ value: "", label: `All ${field.label.toLowerCase()}` }, ...field.options]}
							className={field.width ?? "w-40"}
							inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
							ariaLabel={field.label}
						/>
					) : (
						<Input
							key={field.key}
							value={feed.filterValues[field.key] ?? ""}
							onChange={(event) => feed.changeFilter(field.key, event.target.value)}
							placeholder={field.placeholder ?? field.label}
							className={cn("h-8 text-sm", field.width ?? "w-52", CONTROL_CLASS_NAME)}
							aria-label={field.label}
						/>
					),
				)}
				<PickerSelect
					value={feed.sort}
					onValueChange={feed.changeSort}
					options={SORT_OPTIONS}
					className="w-36"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Sort order"
				/>
				{activeFilters > 0 && (
					<Button variant="ghost" size="sm" onClick={feed.clearAll}>
						Clear
					</Button>
				)}
			</div>
			{query.isLoading ? (
				<TableSkeleton rows={6} cols={5} />
			) : query.isError ? (
				<ErrorState error={query.error} onRetry={() => query.refetch()} />
			) : events.length === 0 ? (
				<EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
			) : (
				<>
					<div className={cn("overflow-x-auto rounded-md border border-border", query.isFetching && "opacity-60")}>
						<Table>
							<TableHeader>{head}</TableHeader>
							<TableBody>
								{events.map((row) => (
									<Fragment key={getKey(row)}>{renderRow(row)}</Fragment>
								))}
							</TableBody>
						</Table>
					</div>
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span>
							Page {feed.page} · {events.length} result{events.length === 1 ? "" : "s"}
							{hasMore ? " (more available)" : ""}
						</span>
						<div className="flex gap-2">
							<Button variant="outline" size="sm" disabled={!feed.canGoBack} onClick={feed.goPrev}>
								<ChevronLeft className="mr-1 h-3.5 w-3.5" />
								Previous
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={!hasMore || !nextCursor}
								onClick={() => nextCursor && feed.goNext(nextCursor)}
							>
								Next
								<ChevronRight className="ml-1 h-3.5 w-3.5" />
							</Button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
