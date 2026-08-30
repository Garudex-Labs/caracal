// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Repository-style workspace for one component: overview, source definition,
// version history with compare and controlled restore, change requests,
// review issues, activity, and contributors - one stable canonical URL with
// deep-linkable subsections. Server-side authorization is the boundary; UI
// permission checks only decide what to render.

import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import {
	Archive,
	ArchiveRestore,
	ArrowDownToLine,
	ArrowLeft,
	AlertTriangle,
	CircleDot,
	FileCode2,
	GitPullRequest,
	History,
	LayoutList,
	Loader2,
	Pencil,
	Tags,
	Users,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
	useRegistryItem,
	useRegistryMetrics,
	useComponentVersions,
	useComponentVersionDetail,
	useComponentArchive,
	useComponentUnarchive,
	useResourceActivity,
	useRestoreComponentVersion,
	useReviewIssues,
	useWhoami,
} from "@/hooks/use-api";
import { getAccessToken, getUserRole, registry } from "@/lib/api";
import { hasMinRole } from "@/hooks/use-role-guard";
import type { RegistryType } from "@/lib/api";
import type { RegistryItem, ComponentVersionSummary } from "@/lib/types";
import { compactNumber } from "@/lib/utils";
import { canonicalRouteParts, registryIdentity } from "@/lib/registry-name";
import { buildComponentYaml, simpleUnifiedDiff } from "@/lib/resource-diff";
import { ComponentEditForm } from "@/components/registry/component-edit-form";
import { ComponentInstallCommand } from "@/components/registry/component-install-command";
import { OwnerSubmissionActions } from "@/components/registry/owner-submission-actions";
import { RegistryName } from "@/components/registry/registry-name";
import { ShareLinkButton } from "@/components/registry/share-link-button";
import { StatusBadge } from "@/components/registry/status-badge";
import { HarnessBadges } from "@/components/registry/harness-badges";
import { CoAuthorInput, type CoAuthor } from "@/components/registry/co-author-input";
import { ReviewIssuesPanel } from "@/components/review/review-issues";
import { ActivityPanel } from "@/components/resource-workspace/activity-panel";
import { ChangeReviewPanel } from "@/components/resource-workspace/change-review-panel";
import { ChangesPanel } from "@/components/resource-workspace/changes-panel";
import { ContributorsPanel } from "@/components/resource-workspace/contributors-panel";
import { VersionsPanel, type WorkspaceVersionRow } from "@/components/resource-workspace/versions-panel";
import { WorkspaceTabBar, useWorkspaceView, type WorkspaceTab } from "@/components/resource-workspace/workspace-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PickerSelect } from "@/components/ui/picker-select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/layouts/page-header";
import { DetailSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";

// Visibility is decided by the publish target (personal vs project vs public
// catalog) when a change is created; the workspace only reports it.
const VISIBILITY_LABELS: Record<string, string> = {
	public: "Public",
	team: "Project",
	private: "Personal",
};

function formatArchiveDate(item: RegistryItem) {
	const value = item.updated_at ?? item.created_at;
	return value
		? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
		: null;
}

function ArchivedComponentBanner({ item, type, canRestore }: { item: RegistryItem; type: string; canRestore: boolean }) {
	const date = formatArchiveDate(item);

	return (
		<div className="flex items-start justify-between gap-4 rounded-md border border-dark-yellow/30 bg-light-yellow px-4 py-3 text-dark-yellow">
			<div className="flex items-start gap-3">
				<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
				<div className="space-y-1 text-sm">
					<p className="font-medium">
						This {type} was archived{date ? ` on ${date}` : ""}. It is hidden from registry lists.
					</p>
					<p className="text-xs text-dark-yellow/80">
						Installs still work by direct reference, but users will see an archived component warning.
						{canRestore ? " Restore it from the overview panel when it should be discoverable again." : ""}
					</p>
				</div>
			</div>
			<Archive className="mt-0.5 h-4 w-4 shrink-0" />
		</div>
	);
}

export default function ComponentDetailPage({
	componentId,
	componentType,
}: {
	componentId?: string;
	componentType?: RegistryType;
} = {}) {
	// Rendered from two routes: the canonical /components/$type/$namespace/$slug
	// route passes the resolved UUID and type as props; the legacy
	// /components/$componentId route supplies the id as a path param and the
	// type as a query param.
	const params = useParams({ strict: false }) as { componentId?: string };
	const search = useSearch({ strict: false }) as { type?: string };
	const id = componentId ?? params.componentId ?? "";
	const type = (componentType ?? search.type ?? "mcps") as RegistryType;
	const navigate = useNavigate();
	const singularType = type === "sandboxes" ? "sandbox" : type.replace(/s$/, "");
	const { data: item, isLoading, isError, error, refetch } = useRegistryItem(type, id);
	const { data: rawMetrics } = useRegistryMetrics(type, id);
	const { data: versionsData, isLoading: versionsLoading } = useComponentVersions(type, id);
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
	const { data: versionDetail } = useComponentVersionDetail(type, id, selectedVersion);
	const { data: whoami } = useWhoami();
	const { data: issuesData } = useReviewIssues(id);
	const { data: activityData } = useResourceActivity(id, 8);
	const restoreVersion = useRestoreComponentVersion();
	const { view: requestedView, setView } = useWorkspaceView();

	const storeSub = useCallback((cb: () => void) => {
		window.addEventListener("storage", cb);
		return () => window.removeEventListener("storage", cb);
	}, []);
	const isAuthenticated = useSyncExternalStore(
		storeSub,
		() => !!getAccessToken(),
		() => false,
	);
	const canEdit = isAuthenticated && (item?.user_permission === "owner");
	// The version-release form applies to released components; drafts, pending
	// submissions, and rejections are authored through OwnerSubmissionActions.
	const canRelease = canEdit && ["approved", "archived"].includes(String(item?.status ?? ""));
	const canTransferOwnership = !!(whoami?.id && item?.submitted_by && whoami.id === String(item.submitted_by));
	const canOpenIssues = hasMinRole(getUserRole(), "reviewer") || canEdit;
	const currentVisibility = (item?.visibility as string | undefined) ?? (item?.is_private ? "team" : "public");

	// Co-authors
	const [coAuthors, setCoAuthors] = useState<CoAuthor[]>([]);
	useEffect(() => {
		const token = getAccessToken();
		const headers: Record<string, string> = {};
		if (token) headers["Authorization"] = `Bearer ${token}`;
		fetch(`/api/v1/${type}/${id}/co-authors`, { headers })
			.then((r) => (r.ok ? r.json() : []))
			.then((data) => setCoAuthors(data))
			.catch(() => {});
	}, [type, id]);

	const versions = versionsData?.items ?? [];
	const latestApprovedVersion = versions.find((v) => v.status === "approved")?.version;
	const activeVersion = latestApprovedVersion ?? (item?.version as string | undefined);
	const effectiveVersion = selectedVersion ?? activeVersion;
	// Overlay version-specific fields when a historical version is selected. The
	// merged record stays a RegistryItem by construction; created_at nullability
	// is the only declared mismatch.
	const effectiveItem: RegistryItem | undefined = item
		? versionDetail && selectedVersion
			? ({ ...item, ...versionDetail } as RegistryItem)
			: item
		: undefined;

	const versionRows: WorkspaceVersionRow[] = versions.map((v: ComponentVersionSummary) => ({
		id: v.id,
		version: v.version,
		status: v.status,
		description: v.description,
		changelog: v.changelog,
		released_by: v.released_by,
		released_at: v.released_at,
		created_at: v.created_at,
		rejection_reason: v.rejection_reason,
	}));
	const openChanges = versionRows.filter((v) => v.status === "pending" || v.status === "draft").length;
	const openIssues = issuesData?.open_count ?? 0;

	// Header/breadcrumb show the bare name; the install command needs the
	// canonical `namespace/slug` the CLI resolves.
	const identity = registryIdentity(item, id.slice(0, 8));
	const componentName = identity.name;
	const componentRef = identity.qualified;
	// Canonical shareable path from the explicit columns only, and only when the
	// namespace/slug actually resolve server-side (legacy verbatim-username
	// namespaces do not).
	const canonicalParts = canonicalRouteParts(item?.namespace, item?.slug);
	const canonicalComponentPath = canonicalParts
		? `/components/${type}/${canonicalParts.namespace}/${canonicalParts.slug}`
		: undefined;

	// Legacy /components/<uuid>?type= entry: swap the address bar to the
	// shareable URL only for approved components. /registry/resolve returns
	// approved-or-owned only, so redirecting a reviewer/admin viewing a pending
	// component would strand them on a 404; their UUID URL keeps working.
	const componentApproved = (item?.status as string | undefined) === "approved";
	useEffect(() => {
		if (componentId || !canonicalParts || !componentApproved) return;
		navigate({
			to: "/components/$type/$namespace/$slug",
			params: { type, ...canonicalParts },
			search: (prev: Record<string, unknown>) => {
				// `type` is carried by the canonical path segment, not the query.
				const { type: _type, ...rest } = prev;
				return rest;
			},
			replace: true,
		});
	}, [componentId, type, canonicalParts, componentApproved, navigate]);

	const loadDiff = useCallback(
		async (base: string, head: string) => {
			const [a, b] = await Promise.all([
				registry.getComponentVersion(type, id, base),
				registry.getComponentVersion(type, id, head),
			]);
			return simpleUnifiedDiff(buildComponentYaml(a), buildComponentYaml(b), `v${base}`, `v${head}`);
		},
		[type, id],
	);

	const metricsEntries: [string, string][] = rawMetrics && typeof rawMetrics === "object"
		? Object.entries(rawMetrics as Record<string, unknown>)
				.map(([k, v]) => [k, typeof v === "number" ? v.toLocaleString() : String(v ?? "")])
		: [];

	const tabs: WorkspaceTab[] = [
		{ id: "overview", label: "Overview", icon: LayoutList },
		{ id: "source", label: "Source", icon: FileCode2 },
		{ id: "versions", label: "Versions", icon: Tags, count: versions.length },
		{ id: "changes", label: "Changes", icon: GitPullRequest, count: openChanges, attention: openChanges > 0 },
		{ id: "issues", label: "Issues", icon: CircleDot, count: openIssues, attention: openIssues > 0 },
		{ id: "activity", label: "Activity", icon: History },
		{ id: "contributors", label: "Contributors", icon: Users },
		{ id: "edit", label: "Edit", icon: Pencil, hidden: !canRelease },
	];

	// "review" is the changes tab drilled into one open change; a stale or
	// unauthorized ?view= deep link falls back to Overview.
	const view =
		requestedView === "review" || tabs.some((tab) => tab.id === requestedView && !tab.hidden)
			? requestedView
			: "overview";
	const activeTab = view === "review" ? "changes" : view;
	const openReview = () => setView("review");

	return (
		<>
			<PageHeader
				title={isLoading ? "Component" : componentName}
				breadcrumbs={[
					{ label: "Registry", href: "/" },
					{ label: "Resources", href: "/resources" },
					{ label: isLoading ? "..." : componentName },
				]}
				actionButtonsLeft={
					<Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-muted-foreground" asChild>
						<Link to="/resources">
							<ArrowLeft className="h-3.5 w-3.5" />
							<span className="text-xs">Back</span>
						</Link>
					</Button>
				}
				actionButtonsRight={
					item ? (
						<div className="flex items-center gap-1.5">
							{canEdit && <OwnerSubmissionActions type={type} item={item} onChanged={() => refetch()} />}
							{openChanges > 0 && (
								<Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={openReview}>
									<GitPullRequest className="h-3.5 w-3.5" />
									View change
								</Button>
							)}
							<ShareLinkButton path={canonicalComponentPath ?? `/components/${id}?type=${type}`} />
						</div>
					) : undefined
				}
			/>
			<div className="w-full space-y-5 p-6">
				{isLoading ? (
					<DetailSkeleton />
				) : isError ? (
					<ErrorState message={error?.message} onRetry={() => refetch()} />
				) : !item ? (
					<ErrorState message="Component not found" />
				) : (
					<div className="animate-in space-y-5">
						{item.status === "archived" && (
							<ArchivedComponentBanner item={item} type={singularType} canRestore={canEdit} />
						)}

						{/* Resource header */}
						<div className="space-y-2">
							<div className="flex flex-wrap items-start gap-3">
								<RegistryName
									item={item}
									as="h1"
									nameClassName="text-2xl font-display font-bold tracking-tight"
									handleClassName="text-sm text-muted-foreground"
								/>
								<Badge variant="outline" className="text-xs">{singularType}</Badge>
								{item.status && <StatusBadge status={item.status} />}
								<Badge variant="outline" className="text-xs">
									{VISIBILITY_LABELS[currentVisibility] ?? currentVisibility}
								</Badge>
								{activeVersion && (
									<Badge variant="secondary" className="font-mono text-xs">v{activeVersion}</Badge>
								)}
							</div>
							{item.description && (
								<p className="max-w-2xl text-sm leading-relaxed text-foreground/80">{String(item.description)}</p>
							)}
							<p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
								{!!item.owner && <span>by {String(item.owner)}</span>}
								{item.created_at && <span>created {new Date(item.created_at).toLocaleDateString()}</span>}
							</p>
						</div>

						<WorkspaceTabBar tabs={tabs} active={activeTab} onSelect={setView} />

						{view === "overview" && (
							<div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_320px]">
								<div className="min-w-0 space-y-6">
									{openIssues > 0 && (
										<button
											type="button"
											onClick={() => setView("issues")}
											className="flex w-full items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-left text-sm text-warning hover:bg-warning/10"
										>
											<CircleDot className="h-4 w-4 shrink-0" />
											{openIssues} unresolved review issue{openIssues !== 1 ? "s" : ""} - outstanding work before
											the next merge.
										</button>
									)}
									<ComponentMetadata item={item} />
									{(activityData?.events.length ?? 0) > 0 && (
										<section className="space-y-3">
											<div className="flex items-center justify-between">
												<h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
													Recent activity
												</h3>
												<Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setView("activity")}>
													Full history
												</Button>
											</div>
											<ActivityPanel subjectId={id} onOpenChange={openReview} limit={8} compact />
										</section>
									)}
								</div>

								{/* Context rail */}
								<aside className="hidden space-y-5 lg:block">
									{(singularType === "mcp" || singularType === "skill" || singularType === "hook") && (
										<ComponentInstallCommand componentType={singularType} componentName={componentRef} />
									)}

									<div className="space-y-3 rounded-md border border-border p-4">
										<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
											Current version
										</h3>
										<div className="space-y-2 text-sm">
											<div className="flex items-center justify-between">
												<span className="text-muted-foreground">Active</span>
												<span className="font-mono font-medium">{activeVersion ? `v${activeVersion}` : "–"}</span>
											</div>
											<div className="flex items-center justify-between">
												<span className="text-muted-foreground">Versions</span>
												<span className="font-mono font-medium">{versions.length}</span>
											</div>
											<div className="flex items-center justify-between">
												<span className="text-muted-foreground">Open changes</span>
												<span className="font-mono font-medium">{openChanges}</span>
											</div>
											<div className="flex items-center justify-between">
												<span className="text-muted-foreground">Open issues</span>
												<span className={`font-mono font-medium ${openIssues > 0 ? "text-warning" : ""}`}>{openIssues}</span>
											</div>
										</div>
									</div>

									<div className="space-y-4 rounded-md border border-border p-4">
										<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
											Stats
										</h3>
										<div className="space-y-3">
											{(item as Record<string, unknown>).download_count != null && (item as Record<string, unknown>).download_count !== 0 && (
												<div className="flex items-center justify-between text-sm">
													<span className="inline-flex items-center gap-2 text-muted-foreground">
														<ArrowDownToLine className="h-3.5 w-3.5" />
														Downloads
													</span>
													<span className="font-mono font-medium">
														{compactNumber((item as Record<string, unknown>).download_count as number)}
													</span>
												</div>
											)}
											{metricsEntries.map(([key, val]) => (
												<div key={key} className="flex items-center justify-between text-sm">
													<span className="text-muted-foreground capitalize">{key.replace(/_/g, " ")}</span>
													<span className="font-mono font-medium">{val}</span>
												</div>
											))}
										</div>
									</div>

									{Array.isArray(item.supported_harnesses) && (item.supported_harnesses as string[]).length > 0 && (
										<div className="space-y-3 rounded-md border border-border p-4">
											<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Harness compatibility
											</h3>
											<HarnessBadges supportedHarnesses={item.supported_harnesses as string[]} max={7} />
										</div>
									)}

									{(canEdit || coAuthors.length > 0) && (
										<div className="space-y-4 rounded-md border border-border p-4">
											<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Ownership & lifecycle
											</h3>

											<CoAuthorInput
												entityType={type}
												entityId={id}
												coAuthors={coAuthors}
												onChange={setCoAuthors}
												canManage={canEdit}
												canTransferOwnership={canTransferOwnership}
												onTransferOwnership={() => refetch()}
											/>

											{canEdit && (
												<div className="space-y-2 border-t border-border pt-3">
													<p className="text-sm font-medium">Lifecycle</p>
													<ComponentArchiveButton type={type} item={item} onSuccess={() => refetch()} />
												</div>
											)}
										</div>
									)}
								</aside>
							</div>
						)}

						{view === "source" && (
							<div className="max-w-4xl space-y-4">
								<div className="flex items-center gap-2">
									<span className="text-xs text-muted-foreground">Definition at</span>
									<PickerSelect
										value={effectiveVersion ?? ""}
										onValueChange={(v) => setSelectedVersion(v === activeVersion ? null : v)}
										options={versions
											.filter((v) => v.status === "approved")
											.map((v) => ({
												value: v.version,
												label: `v${v.version}${v.version === activeVersion ? " (active)" : ""}`,
											}))}
										placeholder="Version"
										ariaLabel="Definition version"
										className="w-40"
										inputClassName="h-7 px-2 text-xs"
									/>
									{selectedVersion && selectedVersion !== activeVersion && (
										<span className="inline-flex items-center gap-1 text-xs text-warning">
											<AlertTriangle className="h-3 w-3" />
											Viewing a historical version
										</span>
									)}
								</div>
								<ComponentMetadata item={effectiveItem ?? item} />
							</div>
						)}

						{view === "versions" && (
							<VersionsPanel
								rows={versionRows}
								isLoading={versionsLoading}
								activeVersion={activeVersion}
								onOpenChange={openReview}
								canRestore={canEdit}
								restoreBusy={restoreVersion.isPending}
								onRestore={(version, reason) => restoreVersion.mutate({ type, listingId: id, version, reason })}
								loadDiff={loadDiff}
							/>
						)}

						{view === "changes" && (
							<div className="max-w-4xl">
								<ChangesPanel
									rows={versionRows}
									isLoading={versionsLoading}
									onOpenChange={openReview}
									openIssueCount={openIssues}
									canPropose={canRelease}
									proposeLabel="New change"
									onPropose={() => setView("edit")}
								/>
							</div>
						)}

						{view === "review" && (
							<ChangeReviewPanel subjectId={id} onBack={() => setView("changes")} />
						)}

						{view === "issues" && (
							<div className="max-w-3xl">
								<ReviewIssuesPanel subjectId={id} canOpenIssues={canOpenIssues} />
							</div>
						)}

						{view === "activity" && (
							<div className="max-w-3xl">
								<ActivityPanel subjectId={id} onOpenChange={openReview} />
							</div>
						)}

						{view === "contributors" && (
							<div className="max-w-4xl">
								<ContributorsPanel subjectId={id} />
							</div>
						)}

						{view === "edit" && canRelease && (
							<div className="w-full">
								<ComponentEditForm
									listingId={id}
									type={type}
									currentVersion={effectiveVersion ?? "1.0.0"}
									item={effectiveItem ?? item}
									onSuccess={() => refetch()}
								/>
							</div>
						)}
					</div>
				)}
			</div>
		</>
	);
}

function ComponentArchiveButton({
	type,
	item,
	onSuccess,
}: {
	type: RegistryType;
	item: RegistryItem;
	onSuccess: () => void;
}) {
	const [open, setOpen] = useState(false);
	const archiveMutation = useComponentArchive(type);
	const unarchiveMutation = useComponentUnarchive(type);
	const isArchived = item.status === "archived";
	const isBusy = archiveMutation.isPending || unarchiveMutation.isPending;

	function submit() {
		const mutation = isArchived ? unarchiveMutation : archiveMutation;
		mutation.mutate(item.id, {
			onSuccess: () => {
				setOpen(false);
				onSuccess();
			},
		});
	}

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className={isArchived ? "h-8" : "h-8 border-dark-yellow/40 bg-light-yellow text-dark-yellow hover:bg-light-yellow/80"}
				onClick={() => setOpen(true)}
				disabled={isBusy}
			>
				{isArchived ? <ArchiveRestore className="mr-1 h-3.5 w-3.5" /> : <Archive className="mr-1 h-3.5 w-3.5" />}
				{isArchived ? "Restore" : "Archive"}
			</Button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{isArchived ? `Restore ${item.name}?` : `Archive ${item.name}?`}</DialogTitle>
					</DialogHeader>
					<p className="text-sm text-muted-foreground">
						{isArchived
							? "This makes the component discoverable again and removes archived install warnings."
							: "Archived components stop appearing in registry lists and insight suggestions. Direct installs and agent pulls still work, but users will see a warning."}
					</p>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
						<Button
							variant={isArchived ? "default" : "outline"}
							className={isArchived ? undefined : "border-dark-yellow/40 bg-light-yellow text-dark-yellow hover:bg-light-yellow/80"}
							onClick={submit}
							disabled={isBusy}
						>
							{isBusy ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Saving...</> : isArchived ? "Restore" : "Archive"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function ComponentMetadata({ item }: { item: RegistryItem }) {
	const fields: { label: string; value: string; mono?: boolean; href?: string }[] = [];
	if ("git_url" in item && item.git_url != null) fields.push({ label: "Source", value: String(item.git_url), href: String(item.git_url) });
	if ("command" in item && item.command != null) fields.push({ label: "Command", value: String(item.command), mono: true });
	if ("url" in item && item.url != null) fields.push({ label: "URL", value: String(item.url), href: String(item.url) });
	if ("transport" in item && item.transport != null) fields.push({ label: "Transport", value: String(item.transport) });
	if ("framework" in item && item.framework != null) fields.push({ label: "Framework", value: String(item.framework) });
	if ("docker_image" in item && item.docker_image != null) fields.push({ label: "Docker Image", value: String(item.docker_image), mono: true });
	if ("hook_type" in item && item.hook_type != null) fields.push({ label: "Hook Type", value: String(item.hook_type) });
	if ("trigger_event" in item && item.trigger_event != null) fields.push({ label: "Trigger Event", value: String(item.trigger_event) });
	if ("runtime" in item && item.runtime != null) fields.push({ label: "Runtime", value: String(item.runtime) });
	if ("runtime_type" in item && item.runtime_type != null) fields.push({ label: "Runtime", value: String(item.runtime_type) });
	if ("image" in item && item.image != null) fields.push({ label: "Image / Artifact", value: String(item.image), mono: true });
	if ("network_policy" in item && item.network_policy != null) fields.push({ label: "Network Policy", value: String(item.network_policy) });
	if ("entrypoint" in item && item.entrypoint != null) fields.push({ label: "Entrypoint", value: String(item.entrypoint), mono: true });
	if ("source_url" in item && item.source_url != null) fields.push({ label: "Source URL", value: String(item.source_url), href: String(item.source_url) });
	if ("sandbox_path" in item && item.sandbox_path != null) fields.push({ label: "Sandbox Path", value: String(item.sandbox_path), mono: true });

	const setupInstructions = "setup_instructions" in item && item.setup_instructions ? String(item.setup_instructions) : null;
	const changelog = "changelog" in item && item.changelog ? String(item.changelog) : null;
	const skillMd = "skill_md_content" in item && item.skill_md_content ? String(item.skill_md_content) : null;
	const promptTemplate = "template" in item && item.template ? String(item.template) : null;
	const promptText = "prompt_text" in item && item.prompt_text ? String(item.prompt_text) : null;
	const markdownContent = skillMd || promptTemplate || promptText;
	const envVars = "environment_variables" in item && Array.isArray(item.environment_variables) ? item.environment_variables as { name: string; description?: string; required?: boolean }[] : [];
	const resourceLimits = "resource_limits" in item && item.resource_limits ? JSON.stringify(item.resource_limits, null, 2) : null;
	const runtimeConfig = "runtime_config" in item && item.runtime_config ? JSON.stringify(item.runtime_config, null, 2) : null;

	const hasContent = fields.length > 0 || markdownContent || setupInstructions || changelog || envVars.length > 0 || resourceLimits || runtimeConfig;

	if (!hasContent) {
		return (
			<div className="rounded-md border border-dashed border-border p-8 text-center">
				<p className="text-sm text-muted-foreground">No additional details available for this component.</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{fields.length > 0 && (
				<div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
					{fields.map((f) => (
						<div key={f.label} className="space-y-1 rounded-md border border-border p-3">
							<span className="text-xs text-muted-foreground">{f.label}</span>
							{f.href ? (
								<p><a href={f.href} className="break-all text-sm text-primary hover:underline" target="_blank" rel="noopener noreferrer">{f.value}</a></p>
							) : (
								<p className={f.mono ? "font-mono text-sm" : "text-sm"}>{f.value}</p>
							)}
						</div>
					))}
				</div>
			)}
			{resourceLimits && resourceLimits !== "{}" && (
				<div className="space-y-2">
					<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resource Limits</h3>
					<pre className="overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{resourceLimits}</pre>
				</div>
			)}
			{runtimeConfig && runtimeConfig !== "{}" && (
				<div className="space-y-2">
					<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Runtime Config</h3>
					<pre className="overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{runtimeConfig}</pre>
				</div>
			)}
			{envVars.length > 0 && (
				<div className="space-y-2">
					<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Environment Variables</h3>
					<div className="divide-y divide-border rounded-md border border-border">
						{envVars.map((ev) => (
							<div key={ev.name} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
								<code className="shrink-0 pt-0.5 font-mono text-xs">{ev.name}</code>
								<div className="flex min-w-0 flex-wrap items-start justify-end gap-2 text-right">
									{ev.description && <span className="min-w-0 text-xs leading-relaxed wrap-break-word text-muted-foreground">{ev.description}</span>}
									{ev.required && <Badge variant="secondary" className="shrink-0 text-[10px]">required</Badge>}
								</div>
							</div>
						))}
					</div>
				</div>
			)}
			{setupInstructions && (
				<div className="space-y-2">
					<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Setup Instructions</h3>
					<div className="max-h-100 overflow-y-auto rounded-md border border-border bg-muted/20 p-4">
						<div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed text-foreground/90">
							<ReactMarkdown remarkPlugins={[remarkGfm]}>{setupInstructions}</ReactMarkdown>
						</div>
					</div>
				</div>
			)}
			{markdownContent && (
				<div className="space-y-2">
					<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						{skillMd ? "Skill File" : "Prompt Template"}
					</h3>
					<div className="max-h-90 overflow-y-auto rounded-md border border-border bg-muted/20 p-4">
						<div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed text-foreground/90">
							<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownContent}</ReactMarkdown>
						</div>
					</div>
				</div>
			)}
			{changelog && (
				<div className="space-y-2">
					<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Changelog</h3>
					<div className="max-h-75 overflow-y-auto rounded-md border border-border bg-muted/20 p-4">
						<div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed text-foreground/90">
							<ReactMarkdown remarkPlugins={[remarkGfm]}>{changelog}</ReactMarkdown>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
