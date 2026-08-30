// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Tenant management for the deployment operator: server-side search,
// filtering, sorting, and pagination over organization lifecycle metadata,
// plus suspension, reinstatement, and deletion with slug-echo confirmation.
// Deliberately metadata-only; organization content stays inside the tenant.

import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	Building2,
	MoreHorizontal,
	Search,
} from "lucide-react";
import {
	useOperatorDeleteOrg,
	useOperatorOrgs,
	useOperatorReinstateOrg,
	useOperatorSuspendOrg,
} from "@/hooks/use-admin-api";
import type { OperatorOrg, OperatorOrgParams } from "@/lib/api";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PickerSelect } from "@/components/ui/picker-select";
import {
	Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";

const PAGE_SIZE = 50;

type SortKey = NonNullable<OperatorOrgParams["sort"]>;

const columns: { key: SortKey; label: string; align?: "right" }[] = [
	{ key: "name", label: "Organization" },
	{ key: "members", label: "Members", align: "right" },
	{ key: "projects", label: "Projects", align: "right" },
	{ key: "activity", label: "Sessions (30d)", align: "right" },
	{ key: "created", label: "Created" },
];

function formatDate(ts: string) {
	try {
		return new Date(ts).toLocaleDateString();
	} catch {
		return ts;
	}
}

type LifecycleAction = "suspend" | "reinstate" | "delete";

const actionCopy: Record<LifecycleAction, { title: string; body: string; button: string }> = {
	suspend: {
		title: "Suspend organization",
		body: "Members are locked out of every organization route until it is reinstated. No data is deleted.",
		button: "Suspend",
	},
	reinstate: {
		title: "Reinstate organization",
		body: "Members regain access to the organization immediately.",
		button: "Reinstate",
	},
	delete: {
		title: "Delete organization",
		body: "Deletion is permanent and only possible for suspended organizations that no longer own projects or resources. Tenant content is never bulk-destroyed.",
		button: "Delete permanently",
	},
};

function LifecycleDialog({
	org,
	action,
	onClose,
}: {
	org: OperatorOrg;
	action: LifecycleAction;
	onClose: () => void;
}) {
	const [confirm, setConfirm] = useState("");
	const suspend = useOperatorSuspendOrg();
	const reinstate = useOperatorReinstateOrg();
	const remove = useOperatorDeleteOrg();
	const mutation = action === "suspend" ? suspend : action === "reinstate" ? reinstate : remove;
	const copy = actionCopy[action];

	function run() {
		mutation.mutate(
			{ id: org.id, confirm },
			{ onSuccess: () => onClose() },
		);
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{copy.title}</DialogTitle>
					<DialogDescription>
						{copy.body}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<p className="text-[13px] text-muted-foreground">
						Type <span className="font-mono font-medium text-foreground">{org.slug}</span> to
						confirm this action on {org.name}.
					</p>
					<Input
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						placeholder={org.slug}
						autoFocus
						className="h-9 font-mono text-sm"
					/>
				</div>
				<DialogFooter>
					<Button variant="outline" size="sm" onClick={onClose} disabled={mutation.isPending}>
						Cancel
					</Button>
					<Button
						variant={action === "reinstate" ? "default" : "destructive"}
						size="sm"
						disabled={confirm !== org.slug || mutation.isPending}
						onClick={run}
					>
						{mutation.isPending ? "Working..." : copy.button}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export default function OperatorOrganizationsPage() {
	const search = useSearch({ from: "/operator/organizations" });
	const navigate = useNavigate({ from: "/operator/organizations" });
	const [qDraft, setQDraft] = useState(search.q ?? "");
	const [dialog, setDialog] = useState<{ org: OperatorOrg; action: LifecycleAction } | null>(null);

	const sort = search.sort ?? "created";
	const order = search.order ?? "desc";
	const page = search.page ?? 1;

	const params = useMemo<OperatorOrgParams>(
		() => ({
			q: search.q || undefined,
			status: search.status,
			sort,
			order,
			limit: PAGE_SIZE,
			offset: (page - 1) * PAGE_SIZE,
		}),
		[search.q, search.status, sort, order, page],
	);
	const orgs = useOperatorOrgs(params);

	function setSearch(patch: Partial<typeof search>) {
		navigate({
			search: (prev) => ({ ...prev, page: undefined, ...patch }),
			replace: true,
		});
	}

	function toggleSort(key: SortKey) {
		if (sort === key) {
			setSearch({ sort: key, order: order === "desc" ? "asc" : "desc" });
		} else {
			setSearch({ sort: key, order: key === "name" ? "asc" : "desc" });
		}
	}

	const data = orgs.data;
	const items = data?.items ?? [];
	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const activityUnavailable = data?.activity === "unavailable";

	return (
		<>
			<PageHeader title="Organizations" breadcrumbs={[{ label: "Operator" }, { label: "Organizations" }]} />
			<div className="mx-auto w-full max-w-6xl space-y-4 p-6">
				<header>
					<h1 className="text-lg font-semibold tracking-tight">Organizations</h1>
					<p className="mt-1 text-[13px] text-muted-foreground">
						Every tenant hosted by this deployment. Lifecycle metadata only; tenant content stays
						inside the organization boundary.
					</p>
				</header>

				<div className="flex flex-wrap items-center gap-3">
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							setSearch({ q: qDraft.trim() || undefined });
						}}
					>
						<div className="relative">
							<Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								value={qDraft}
								onChange={(e) => setQDraft(e.target.value)}
								placeholder="Search name or slug"
								className="h-9 w-65 pl-8 text-xs"
							/>
						</div>
						<Button type="submit" variant="outline" size="sm" className="h-9">
							Search
						</Button>
					</form>
					<PickerSelect
						value={search.status ?? "all"}
						onValueChange={(v) =>
							setSearch({ status: v === "all" ? undefined : (v as "active" | "suspended") })
						}
						placeholder="Status"
						className="w-37.5"
						inputClassName="h-9 text-xs"
						options={[
							{ value: "all", label: "All statuses" },
							{ value: "active", label: "Active" },
							{ value: "suspended", label: "Suspended" },
						]}
					/>
					{activityUnavailable && (
						<Badge variant="outline" className="text-[10px] text-muted-foreground">
							Session activity unavailable
						</Badge>
					)}
				</div>

				{orgs.isLoading && <TableSkeleton rows={10} cols={6} />}
				{orgs.isError && (
					<ErrorState message="Failed to load organizations." onRetry={() => orgs.refetch()} />
				)}
				{data && total === 0 && (
					<EmptyState
						icon={Building2}
						title={search.q || search.status ? "No matching organizations" : "No organizations yet"}
						description={
							search.q || search.status
								? "Adjust the search or status filter."
								: "Tenants appear here as soon as the first organization is created."
						}
					/>
				)}
				{data && total > 0 && (
					<>
						<div className="rounded-md border">
							<Table>
								<TableHeader>
									<TableRow>
										{columns.map((col) => (
											<TableHead
												key={col.key}
												className={col.align === "right" ? "text-right" : undefined}
											>
												<button
													type="button"
													onClick={() => toggleSort(col.key)}
													className="inline-flex items-center gap-1 text-xs hover:text-foreground"
												>
													{col.label}
													{sort === col.key ? (
														order === "desc" ? (
															<ArrowDown className="h-3 w-3" />
														) : (
															<ArrowUp className="h-3 w-3" />
														)
													) : (
														<ArrowUpDown className="h-3 w-3 opacity-40" />
													)}
												</button>
											</TableHead>
										))}
										<TableHead className="text-xs">Owner</TableHead>
										<TableHead className="w-10" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{items.map((org) => (
										<TableRow key={org.id}>
											<TableCell>
												<div className="flex items-center gap-2">
													<div className="min-w-0">
														<p className="truncate text-[13px] font-medium">{org.name}</p>
														<p className="truncate font-mono text-[11px] text-muted-foreground">
															{org.slug}
														</p>
													</div>
													{org.suspended_at && (
														<Badge variant="destructive" className="text-[10px]">
															Suspended
														</Badge>
													)}
												</div>
											</TableCell>
											<TableCell className="text-right text-[13px]">{org.member_count}</TableCell>
											<TableCell className="text-right text-[13px]">{org.project_count}</TableCell>
											<TableCell className="text-right text-[13px]">
												{org.sessions_30d === null ? (
													<span className="text-muted-foreground">-</span>
												) : (
													org.sessions_30d
												)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{formatDate(org.created_at)}
											</TableCell>
											<TableCell className="max-w-45 truncate text-xs text-muted-foreground">
												{org.owner_email ?? "-"}
											</TableCell>
											<TableCell>
												<DropdownMenu>
													<DropdownMenuTrigger asChild>
														<Button variant="ghost" size="icon" className="h-7 w-7">
															<MoreHorizontal className="h-4 w-4" />
															<span className="sr-only">Actions for {org.slug}</span>
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														{org.suspended_at ? (
															<>
																<DropdownMenuItem
																	onClick={() => setDialog({ org, action: "reinstate" })}
																>
																	Reinstate
																</DropdownMenuItem>
																<DropdownMenuItem
																	className="text-destructive focus:text-destructive"
																	onClick={() => setDialog({ org, action: "delete" })}
																>
																	Delete
																</DropdownMenuItem>
															</>
														) : (
															<DropdownMenuItem
																className="text-destructive focus:text-destructive"
																onClick={() => setDialog({ org, action: "suspend" })}
															>
																Suspend
															</DropdownMenuItem>
														)}
													</DropdownMenuContent>
												</DropdownMenu>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>

						<div className="flex items-center justify-between">
							<p className="text-xs text-muted-foreground">
								Showing {(page - 1) * PAGE_SIZE + 1}-{(page - 1) * PAGE_SIZE + items.length} of {total}
							</p>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={page <= 1}
									onClick={() => navigate({ search: (prev) => ({ ...prev, page: page - 1 <= 1 ? undefined : page - 1 }), replace: true })}
								>
									Previous
								</Button>
								<span className="text-xs text-muted-foreground">
									Page {page} of {pageCount}
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={page >= pageCount}
									onClick={() => navigate({ search: (prev) => ({ ...prev, page: page + 1 }), replace: true })}
								>
									Next
								</Button>
							</div>
						</div>
					</>
				)}
			</div>
			{dialog && (
				<LifecycleDialog
					org={dialog.org}
					action={dialog.action}
					onClose={() => setDialog(null)}
				/>
			)}
		</>
	);
}
