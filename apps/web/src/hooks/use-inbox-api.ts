// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { inbox } from "@/lib/api";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import type { InboxFilters, InboxState } from "@/lib/types";

const INBOX_KEY = ["inbox"] as const;

export function useInbox(filters: InboxFilters = {}) {
	const { currentOrg } = useCurrentOrg();
	const { currentProject } = useCurrentProject();
	return useQuery({
		queryKey: [...INBOX_KEY, currentOrg?.slug, currentProject?.slug, "list", filters],
		queryFn: () => inbox.list(filters),
		enabled: !!currentOrg && !!currentProject,
		retry: false,
	});
}

/**
 * Badge counts, and optionally the sidebar's per-facet breakdown.
 *
 * `facetState` is part of the key, not just the request. The sidebar's per-kind
 * numbers describe one bucket, so a cached Inbox response must not be handed to
 * a view showing Done.
 */
export function useInboxCounts(
	enabled = true,
	opts: { facets?: boolean; facetState?: InboxState } = {},
) {
	const { currentOrg } = useCurrentOrg();
	const { currentProject } = useCurrentProject();
	return useQuery({
		queryKey: [...INBOX_KEY, currentOrg?.slug, currentProject?.slug, "count", opts.facets ?? false, opts.facetState ?? null],
		queryFn: () => inbox.counts(opts),
		// The badge should feel live without hammering the API. A minute is
		// short enough that a review assignment does not sit unseen for long.
		// Polling was chosen over SSE deliberately: server-sent events would
		// need a connection story for the multi-replica ECS/Fargate topology,
		// and a badge does not justify one.
		refetchInterval: 60_000,
		refetchOnWindowFocus: true,
		enabled: enabled && !!currentOrg && !!currentProject,
		retry: false,
	});
}

export function useInboxItem(id: string | null) {
	const { currentOrg } = useCurrentOrg();
	const { currentProject } = useCurrentProject();
	return useQuery({
		queryKey: [...INBOX_KEY, currentOrg?.slug, currentProject?.slug, "detail", id],
		queryFn: () => inbox.detail(id as string),
		enabled: Boolean(id) && !!currentOrg && !!currentProject,
		retry: false,
	});
}

/**
 * Every mutation invalidates the whole inbox namespace rather than patching
 * one row: marking an item read changes the badge counts and can change which
 * filtered lists it belongs to, and a partial update would leave those stale.
 */
function useInboxMutation<TArgs>(
	fn: (args: TArgs) => Promise<unknown>,
	errorMessage: string,
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: INBOX_KEY });
		},
		// Without this the row simply does not change and the click reads as a
		// no-op, which is indistinguishable from a broken button.
		onError: () => {
			toast.error(errorMessage);
		},
	});
}

export function useMarkRead() {
	return useInboxMutation(
		(id: string) => inbox.read(id),
		"Could not mark that as read. Please try again.",
	);
}

export function useMarkUnread() {
	return useInboxMutation(
		(id: string) => inbox.unread(id),
		"Could not mark that as unread. Please try again.",
	);
}

export function useMarkDone() {
	return useInboxMutation(
		(id: string) => inbox.done(id),
		"Could not resolve that item. Please try again.",
	);
}

export function useDismissItem() {
	return useInboxMutation(
		(id: string) => inbox.dismiss(id),
		"Could not dismiss that item. Please try again.",
	);
}

export function useReopenItem() {
	return useInboxMutation(
		(id: string) => inbox.reopen(id),
		"Could not reopen that item. Please try again.",
	);
}

export function useReadAll() {
	return useInboxMutation(
		(filters: InboxFilters) => inbox.readAll(filters),
		"Could not mark those as read. Please try again.",
	);
}

export type BulkAction = "read" | "unread" | "done" | "dismiss" | "reopen";

const BULK_FNS: Record<BulkAction, (id: string) => Promise<unknown>> = {
	read: inbox.read,
	unread: inbox.unread,
	done: inbox.done,
	dismiss: inbox.dismiss,
	reopen: inbox.reopen,
};

/**
 * Apply one action to a checkbox selection.
 *
 * The API is per-item by design - every transition appends its own history row
 * - so a selection of N is N requests. `allSettled` rather than `all`: one
 * failure must not discard the transitions that did land, and the count of
 * failures is surfaced instead of a success toast over a partial result.
 */
export function useBulkAction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ ids, action }: { ids: string[]; action: BulkAction }) => {
			const results = await Promise.allSettled(ids.map((id) => BULK_FNS[action](id)));
			return {
				total: ids.length,
				failed: results.filter((r) => r.status === "rejected").length,
			};
		},
		onSuccess: ({ total, failed }) => {
			qc.invalidateQueries({ queryKey: INBOX_KEY });
			if (failed > 0) {
				toast.error(`${failed} of ${total} could not be updated.`);
			}
		},
		onError: () => {
			toast.error("Could not update the selection. Please try again.");
		},
	});
}
