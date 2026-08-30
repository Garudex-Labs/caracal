// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The project's resource tree: one server-paginated, visibility-filtered view
// over everything the active project contains - agents and all five component
// types. The URL is the single source of truth (type, search, filters, sort,
// page), so views are shareable and survive reloads; filtering, sorting, and
// pagination all run in SQL behind /api/v1/resources, pinned to the active
// project scope.

import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
	ArchiveRestore,
	ArrowUpDown,
	Blocks,
	Bot,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ListFilter,
	Lock,
	Plus,
	Search,
	SearchX,
	Trash2,
	X,
} from "lucide-react";
import { ConfirmActionDialog } from "@/components/organization/confirm-action-dialog";
import { PageHeader } from "@/components/layouts/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { StatusBadge } from "@/components/registry/status-badge";
import { AddResourceSheet } from "@/components/registry/add-resource-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	useDeletedAgents,
	usePurgeDeletedAgent,
	useProjectResources,
	useRestoreDeletedAgent,
} from "@/hooks/use-api";
import { getUserRole } from "@/lib/api";
import { compactNumber } from "@/lib/utils";
import type { ProjectResource } from "@/lib/types";
import { RESOURCE_PAGE_SIZES, type ResourcesSearch } from "@/routes/_authed/resources";

const TYPE_LABELS: Record<string, string> = {
	agents: "Agents",
	mcps: "MCPs",
	skills: "Skills",
	hooks: "Hooks",
	prompts: "Prompts",
	sandboxes: "Sandboxes",
};
const TYPES = Object.keys(TYPE_LABELS);

const SORT_LABELS: Record<string, string> = {
	updated: "Recently updated",
	created: "Recently created",
	name: "Name A–Z",
	name_desc: "Name Z–A",
	downloads: "Most installed",
};

function singularType(type: string): string {
	if (type === "sandboxes") return "sandbox";
	return type.replace(/s$/, "");
}

const SCOPES = ["project", "private"] as const;
const STATUSES = ["draft", "pending", "approved", "rejected", "archived"] as const;
const DATE_PRESETS: Record<string, { label: string; days: number }> = {
	"7d": { label: "Last 7 days", days: 7 },
	"30d": { label: "Last 30 days", days: 30 },
	"90d": { label: "Last 90 days", days: 90 },
};

// Hour-stable cutoff so the derived query key doesn't change every render.
function presetCutoff(preset?: string): string | undefined {
	const entry = preset ? DATE_PRESETS[preset] : undefined;
	if (!entry) return undefined;
	const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
	return new Date(hour - entry.days * 86_400_000).toISOString();
}

function pageItems(current: number, totalPages: number): (number | "gap")[] {
	if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
	const wanted = [...new Set([1, current - 1, current, current + 1, totalPages])]
		.filter((candidate) => candidate >= 1 && candidate <= totalPages)
		.sort((a, b) => a - b);
	const out: (number | "gap")[] = [];
	let previous = 0;
	for (const candidate of wanted) {
		if (candidate - previous > 1) out.push("gap");
		out.push(candidate);
		previous = candidate;
	}
	return out;
}

function resourcePath(item: ProjectResource): string {
	if (item.resource_type === "agents") return `/agents/${item.namespace}/${item.slug}`;
	return `/components/${item.resource_type}/${item.namespace}/${item.slug}`;
}

function ScopeBadge({ item }: { item: ProjectResource }) {
	if (item.ownership_scope === "private" || item.visibility === "private") {
		return (
			<Badge variant="outline" className="gap-1 border-warning/30 text-[10px] text-warning">
				<Lock className="h-2.5 w-2.5" />
				private
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="text-[10px] text-muted-foreground">
			project
		</Badge>
	);
}

function timeLabel(value?: string | null): string {
	if (!value) return "";
	return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fullTimeLabel(value?: string | null): string {
	if (!value) return "Not scheduled";
	return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function remainingLabel(value?: string | null): string {
	if (!value) return "No purge date";
	const ms = new Date(value).getTime() - Date.now();
	if (ms <= 0) return "Eligible now";
	const hours = Math.ceil(ms / (60 * 60 * 1000));
	if (hours < 48) return `${hours}h remaining`;
	const days = Math.ceil(hours / 24);
	return `${days}d remaining`;
}

// Soft-deleted agents are invisible to the resources listing, so restoring
// them lives here as contextual agent behavior rather than a separate page.
function DeletedAgentsSection() {
	const [expanded, setExpanded] = useState(false);
	const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);
	const { data: deleted = [] } = useDeletedAgents();
	const restore = useRestoreDeletedAgent();
	const purge = usePurgeDeletedAgent();
	if (deleted.length === 0) return null;
	return (
		<section className="overflow-hidden rounded-md border border-border">
			<button
				type="button"
				onClick={() => setExpanded((prev) => !prev)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-accent/40"
			>
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
				)}
				<Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
				Deleted agents
				<span className="tabular-nums text-muted-foreground">{deleted.length}</span>
			</button>
			{expanded && (
				<div className="divide-y divide-border border-t border-border">
					{deleted.map((agent) => {
						const restoreExpired = typeof agent.scheduled_purge_at === "string" && new Date(agent.scheduled_purge_at).getTime() <= Date.now();
						return (
							<div key={agent.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm font-medium">{agent.name}</span>
									<span className="block text-[11px] text-muted-foreground">
										Deleted {fullTimeLabel(agent.deleted_at)} · purges {fullTimeLabel(agent.scheduled_purge_at)} · {remainingLabel(agent.scheduled_purge_at)}
									</span>
								</span>
								<div className="flex shrink-0 gap-2">
									<Button
										variant="outline"
										size="sm"
										className="h-7 text-xs"
										disabled={restore.isPending || restoreExpired}
										onClick={() => restore.mutate({ id: agent.id })}
									>
										<ArchiveRestore className="mr-1 h-3 w-3" />
										Restore
									</Button>
									<Button
										variant="destructive"
										size="sm"
										className="h-7 text-xs"
										disabled={purge.isPending}
										onClick={() => setPurgeTarget({ id: agent.id, name: agent.name })}
									>
										<Trash2 className="mr-1 h-3 w-3" />
										Delete permanently
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			)}
			<ConfirmActionDialog
				open={!!purgeTarget}
				onOpenChange={(open) => !open && setPurgeTarget(null)}
				title={`Permanently delete ${purgeTarget?.name ?? "agent"}?`}
				description="This bypasses the recoverable deleted state and removes the agent immediately."
				impact={["The agent, its versions, component links, download records, and insight data are deleted.", "This action cannot be undone from Caracal."]}
				confirmationText="permanently delete"
				confirmLabel="Delete permanently"
				pending={purge.isPending}
				onConfirm={() => {
					if (!purgeTarget) return;
					purge.mutate(purgeTarget.id, { onSuccess: () => setPurgeTarget(null) });
				}}
			/>
		</section>
	);
}

export default function ResourcesPage() {
	const navigate = useNavigate();
	const search = useSearch({ from: "/_authed/resources" });
	const authed = !!getUserRole();

	const type = search.type && TYPES.includes(search.type) ? search.type : undefined;
	const sort = search.sort && SORT_LABELS[search.sort] ? search.sort : "updated";
	const page = search.page ?? 1;
	const per = search.per ?? RESOURCE_PAGE_SIZES[0];

	// Every filter change resets to page 1; page navigation goes through goPage.
	const patch = (updates: Partial<ResourcesSearch>, replace = false) =>
		navigate({
			to: "/resources",
			replace,
			search: (prev: ResourcesSearch): ResourcesSearch => ({ ...prev, page: undefined, ...updates }),
		});

	const goPage = (next: number) =>
		navigate({
			to: "/resources",
			search: (prev: ResourcesSearch): ResourcesSearch => ({ ...prev, page: next > 1 ? next : undefined }),
		});

	const [searchInput, setSearchInput] = useState(search.q ?? "");
	const [ownerInput, setOwnerInput] = useState(search.owner ?? "");
	const [createOpen, setCreateOpen] = useState(false);
	useEffect(() => setSearchInput(search.q ?? ""), [search.q]);
	useEffect(() => setOwnerInput(search.owner ?? ""), [search.owner]);

	// Debounce free-text search into the URL (replace, so typing doesn't spam history).
	useEffect(() => {
		const q = searchInput.trim();
		if (q === (search.q ?? "")) return;
		const handle = setTimeout(() => void patch({ q: q || undefined }, true), 300);
		return () => clearTimeout(handle);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchInput]);

	const { data, isLoading, isFetching } = useProjectResources({
		type,
		search: search.q,
		mine: search.mine,
		include_unpublished: search.wip,
		scope: search.scope,
		status: search.status,
		owner: search.owner,
		updated_after: presetCutoff(search.updated),
		created_after: presetCutoff(search.created),
		sort,
		page,
		page_size: per,
	});

	const items = data?.items ?? [];
	const counts = data?.counts ?? {};
	const total = data?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / per));
	const allCount = TYPES.reduce((sum, entry) => sum + (counts[entry] ?? 0), 0);

	// Snap back when the result set shrinks under the current page.
	useEffect(() => {
		if (data && page > 1 && page > totalPages) {
			void navigate({
				to: "/resources",
				replace: true,
				search: (prev: ResourcesSearch): ResourcesSearch => ({ ...prev, page: totalPages > 1 ? totalPages : undefined }),
			});
		}
	}, [data, page, totalPages, navigate]);

	const filterCount =
		[search.scope, search.status, search.owner, search.updated, search.created].filter(Boolean).length +
		(search.mine ? 1 : 0) +
		(search.wip ? 1 : 0);
	const clearFilters = () =>
		void patch({
			scope: undefined,
			status: undefined,
			owner: undefined,
			updated: undefined,
			created: undefined,
			mine: undefined,
			wip: undefined,
		});

	const rangeStart = total === 0 ? 0 : (page - 1) * per + 1;
	const rangeEnd = Math.min(page * per, total);

	return (
		<>
			<PageHeader title="Resources" breadcrumbs={[{ label: "Resources" }]} />
			<div className="mx-auto w-full max-w-6xl space-y-3 p-6">
				<div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Resource filters">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" aria-label="Resource type">
								<span className="font-medium">{type ? TYPE_LABELS[type] : "All types"}</span>
								<span className="tabular-nums text-muted-foreground">{type ? counts[type] ?? 0 : allCount}</span>
								<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-44">
							<DropdownMenuRadioGroup
								value={type ?? "all"}
								onValueChange={(value) => void patch({ type: value === "all" ? undefined : value })}
							>
								<DropdownMenuRadioItem value="all" className="text-xs">
									<span className="flex-1">All types</span>
									<span className="tabular-nums text-muted-foreground">{allCount}</span>
								</DropdownMenuRadioItem>
								<DropdownMenuSeparator />
								{TYPES.map((entry) => (
									<DropdownMenuRadioItem key={entry} value={entry} className="text-xs">
										<span className="flex-1">{TYPE_LABELS[entry]}</span>
										<span className="tabular-nums text-muted-foreground">{counts[entry] ?? 0}</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<div className="relative min-w-0 flex-1 sm:max-w-72">
						<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
							placeholder="Search name, slug, or owner…"
							aria-label="Search resources"
							className="h-8 pl-7 pr-7 text-xs"
						/>
						{searchInput && (
							<button
								type="button"
								onClick={() => setSearchInput("")}
								aria-label="Clear search"
								className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								<X className="h-3 w-3" />
							</button>
						)}
					</div>
					<div className="ml-auto flex items-center gap-1.5">
						{filterCount > 0 && (
							<Button
								variant="ghost"
								size="sm"
								className="h-8 gap-1 px-2 text-xs text-muted-foreground"
								onClick={clearFilters}
							>
								<X className="h-3 w-3" />
								Clear
							</Button>
						)}
						<Popover>
							<PopoverTrigger asChild>
								<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs">
									<ListFilter className="h-3.5 w-3.5" />
									Filters
									{filterCount > 0 && (
										<span className="rounded-sm bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground">
											{filterCount}
										</span>
									)}
								</Button>
							</PopoverTrigger>
							<PopoverContent align="end" className="w-72 space-y-3 p-3">
								<div className="grid grid-cols-2 gap-2">
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Scope</Label>
										<Select
											value={search.scope ?? "any"}
											onValueChange={(value) => void patch({ scope: value === "any" ? undefined : value })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by scope">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any scope
												</SelectItem>
												{SCOPES.map((scope) => (
													<SelectItem key={scope} value={scope} className="text-xs capitalize">
														{scope}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Status</Label>
										<Select
											value={search.status ?? "any"}
											onValueChange={(value) => void patch({ status: value === "any" ? undefined : value })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by status">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any status
												</SelectItem>
												{STATUSES.map((status) => (
													<SelectItem key={status} value={status} className="text-xs capitalize">
														{status}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Updated</Label>
										<Select
											value={search.updated ?? "any"}
											onValueChange={(value) => void patch({ updated: value === "any" ? undefined : value })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by updated date">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any time
												</SelectItem>
												{Object.entries(DATE_PRESETS).map(([value, preset]) => (
													<SelectItem key={value} value={value} className="text-xs">
														{preset.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Created</Label>
										<Select
											value={search.created ?? "any"}
											onValueChange={(value) => void patch({ created: value === "any" ? undefined : value })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by created date">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any time
												</SelectItem>
												{Object.entries(DATE_PRESETS).map(([value, preset]) => (
													<SelectItem key={value} value={value} className="text-xs">
														{preset.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								</div>
								<div className="space-y-1">
									<Label htmlFor="resources-owner" className="text-[11px] text-muted-foreground">
										Owner
									</Label>
									<Input
										id="resources-owner"
										value={ownerInput}
										onChange={(e) => setOwnerInput(e.target.value)}
										onBlur={() => {
											const owner = ownerInput.trim();
											if (owner !== (search.owner ?? "")) void patch({ owner: owner || undefined });
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") e.currentTarget.blur();
										}}
										placeholder="Exact username"
										className="h-7 text-xs"
									/>
								</div>
								{authed && (
									<div className="space-y-1.5">
										<label className="flex cursor-pointer items-center gap-2 text-xs">
											<Checkbox
												checked={!!search.mine}
												onCheckedChange={(checked) => void patch({ mine: checked === true ? true : undefined })}
											/>
											Created by me
										</label>
										<label className="flex cursor-pointer items-center gap-2 text-xs">
											<Checkbox
												checked={!!search.wip}
												onCheckedChange={(checked) => void patch({ wip: checked === true ? true : undefined })}
											/>
											Include work in progress
										</label>
									</div>
								)}
								<div className="flex items-center justify-between border-t border-border pt-2">
									<Button
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-xs text-muted-foreground"
										onClick={clearFilters}
										disabled={filterCount === 0}
									>
										Reset filters
									</Button>
									<span className="text-[11px] tabular-nums text-muted-foreground">
										{total} result{total === 1 ? "" : "s"}
									</span>
								</div>
							</PopoverContent>
						</Popover>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" aria-label="Sort resources">
									<ArrowUpDown className="h-3.5 w-3.5" />
									<span className="hidden sm:inline">{SORT_LABELS[sort]}</span>
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-44">
								<DropdownMenuRadioGroup
									value={sort}
									onValueChange={(value) => void patch({ sort: value === "updated" ? undefined : value })}
								>
									{Object.entries(SORT_LABELS).map(([value, label]) => (
										<DropdownMenuRadioItem key={value} value={value} className="text-xs">
											{label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
						{authed && (
							<Button size="sm" className="h-8 gap-1.5 px-2.5 text-xs" onClick={() => setCreateOpen(true)}>
								<Plus className="h-3.5 w-3.5" />
								Add Component
							</Button>
						)}
					</div>
				</div>

				{isLoading ? (
					<TableSkeleton rows={8} />
				) : items.length === 0 ? (
					search.q ? (
						<EmptyState
							icon={SearchX}
							title={`No matches for “${search.q}”`}
							description="Try a different name, slug, or owner, or clear the search."
							actionLabel="Clear search"
							onAction={() => setSearchInput("")}
						/>
					) : filterCount > 0 ? (
						<EmptyState
							icon={ListFilter}
							title="No resources match the active filters"
							description="Loosen or reset the filters to see more of this project."
							actionLabel="Reset filters"
							onAction={clearFilters}
						/>
					) : type ? (
						<EmptyState
							icon={type === "agents" ? Bot : Blocks}
							title={`No ${TYPE_LABELS[type].toLowerCase()} yet`}
							description="Nothing of this type has been published in this project."
							actionLabel="Show all types"
							onAction={() => void patch({ type: undefined })}
						/>
					) : (
						<EmptyState
							icon={Blocks}
							title="No resources yet"
							description="This project has no published agents or components yet."
						/>
					)
				) : (
					<div className="overflow-hidden rounded-md border border-border">
						{/* Fixed-height viewport: the box stays the same size at any page size; rows scroll inside. */}
						<div className="h-135 overflow-y-auto">
							<table className={`w-full text-sm transition-opacity ${isFetching ? "opacity-60" : ""}`}>
								<thead className="sticky top-0 z-1 bg-background shadow-[inset_0_-1px_0_0_var(--color-border)]">
									<tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
									<th scope="col" className="px-3 py-2 font-medium">
										Resource
									</th>
									<th scope="col" className="px-3 py-2 font-medium">
										Type
									</th>
									<th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
										Version
									</th>
									<th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">
										Status
									</th>
									<th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
										Scope
									</th>
									<th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">
										Owner
									</th>
									<th scope="col" className="hidden px-3 py-2 text-right font-medium xl:table-cell">
										Installs
									</th>
									<th scope="col" className="px-3 py-2 text-right font-medium">
										Updated
									</th>
								</tr>
							</thead>
							<tbody>
								{items.map((item) => (
									<tr
										key={`${item.resource_type}-${item.id}`}
										onClick={() => navigate({ to: resourcePath(item) })}
										className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-accent/40"
									>
										<td className="max-w-0 px-3 py-2">
											<Link
												to={resourcePath(item)}
												onClick={(e) => e.stopPropagation()}
												className="block truncate font-medium underline-offset-2 hover:underline"
											>
												{item.name}
											</Link>
											<span className="block truncate text-[11px] text-muted-foreground">
												{item.qualified_name}
												{item.description ? ` - ${item.description}` : ""}
											</span>
										</td>
										<td className="px-3 py-2">
											<Badge variant="outline" className="text-[10px]">
												{singularType(item.resource_type)}
											</Badge>
										</td>
										<td className="hidden px-3 py-2 font-mono text-xs text-muted-foreground md:table-cell">
											{item.version ? `v${item.version}` : "–"}
										</td>
										<td className="hidden px-3 py-2 lg:table-cell">
											{item.status ? (
												<StatusBadge status={item.status} className="px-1.5 py-0 text-[10px]" />
											) : (
												<span className="text-xs text-muted-foreground">–</span>
											)}
										</td>
										<td className="hidden px-3 py-2 md:table-cell">
											<ScopeBadge item={item} />
										</td>
										<td className="hidden max-w-32 truncate px-3 py-2 text-xs text-muted-foreground lg:table-cell">
											{item.owner ?? "–"}
										</td>
										<td className="hidden px-3 py-2 text-right text-xs tabular-nums text-muted-foreground xl:table-cell">
											{item.downloads != null ? compactNumber(item.downloads) : "–"}
										</td>
										<td className="px-3 py-2 text-right text-xs text-muted-foreground">
											{timeLabel(item.updated_at)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						</div>
						<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1.5">
							<span className="text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
								Showing {rangeStart}–{rangeEnd} of {total}
							</span>
							<div className="flex items-center gap-2">
								<Select
									value={String(per)}
									onValueChange={(value) =>
										void patch({ per: Number(value) === RESOURCE_PAGE_SIZES[0] ? undefined : Number(value) })
									}
								>
									<SelectTrigger className="h-6 w-24 text-[11px]" aria-label="Rows per page">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{RESOURCE_PAGE_SIZES.map((size) => (
											<SelectItem key={size} value={String(size)} className="text-xs">
												{size} / page
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<nav aria-label="Pagination" className="flex items-center gap-0.5">
									<Button
										variant="ghost"
										size="sm"
										className="h-6 gap-0.5 px-1.5 text-[11px]"
										disabled={page <= 1}
										onClick={() => goPage(page - 1)}
									>
										<ChevronLeft className="h-3 w-3" />
										Prev
									</Button>
									{pageItems(page, totalPages).map((entry, index) =>
										entry === "gap" ? (
											<span key={`gap-${index}`} className="px-1 text-[11px] text-muted-foreground">
												…
											</span>
										) : (
											<Button
												key={entry}
												variant={entry === page ? "secondary" : "ghost"}
												size="sm"
												className="h-6 min-w-6 px-1.5 text-[11px] tabular-nums"
												aria-label={`Page ${entry}`}
												aria-current={entry === page ? "page" : undefined}
												onClick={() => goPage(entry)}
											>
												{entry}
											</Button>
										),
									)}
									<Button
										variant="ghost"
										size="sm"
										className="h-6 gap-0.5 px-1.5 text-[11px]"
										disabled={page >= totalPages}
										onClick={() => goPage(page + 1)}
									>
										Next
										<ChevronRight className="h-3 w-3" />
									</Button>
								</nav>
							</div>
						</div>
					</div>
				)}
				{authed && (!type || type === "agents") && <DeletedAgentsSection />}
			</div>
			{createOpen && <AddResourceSheet open={createOpen} onOpenChange={setCreateOpen} />}
		</>
	);
}
