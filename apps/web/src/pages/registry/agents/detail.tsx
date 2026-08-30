// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Repository-style workspace for one agent: overview, full definition
// (prompt, model, components), version history with compare and controlled
// restore, change requests, review issues, activity, contributors, and
// insights - one stable canonical URL with deep-linkable subsections.
// Server-side authorization is the boundary; UI permission checks only decide
// what to render.

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
	ArrowDownToLine,
	AlertTriangle,
	CheckCircle2,
	CircleDot,
	Clock,
	FileCode2,
	GitPullRequest,
	Hammer,
	History,
	LayoutList,
	Loader2,
	Play,
	Puzzle,
	Sparkles,
	Tags,
	Users,
	XCircle,
	Archive,
	ArchiveRestore,
	Trash2,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from "react";

import {
	useRegistryItem,
	useAgentDownloads,
	useWhoami,
	useAgentVersions,
	useAgentVersionDetail,
	useInsightReports,
	useInsightSessionCount,
	useGenerateInsight,
	useInsightsStatus,
	useArchiveAgent,
	useDeleteAgent,
	useUnarchiveAgent,
	useResourceActivity,
	useRestoreAgentVersion,
	useReviewIssues,
} from "@/hooks/use-api";
import { getAccessToken, getUserRole, registry } from "@/lib/api";
import { hasMinRole } from "@/hooks/use-role-guard";
import type {
	AgentComponentReference,
	AgentComponentLink as ComponentLink,
	AgentDetail,
	AgentVersionSummary,
	InsightReportListItem,
	SuccessCriteria,
} from "@/lib/types";
import { PullCommand } from "@/components/registry/pull-command";
import { RegistryName } from "@/components/registry/registry-name";
import { ShareLinkButton } from "@/components/registry/share-link-button";
import { canonicalRouteParts, registryIdentity, registryItemPath, type QualifiedIdentity } from "@/lib/registry-name";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layouts/page-header";
import { DetailSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { compactNumber } from "@/lib/utils";

const FEATURE_LABELS: Record<string, string> = {
	skills: "Slash-command skills",
	superpowers: "Kiro superpowers",
	hook_bridge: "Hook bridge",
	mcp_servers: "MCP servers",
	rules: "Rules / system prompt",
	steering_files: "Steering files",
	otlp_telemetry: "OTLP telemetry",
};

const COMPONENT_TYPES = [
	{ value: "mcps", singular: "mcp", label: "MCPs" },
	{ value: "skills", singular: "skill", label: "Skills" },
	{ value: "hooks", singular: "hook", label: "Hooks" },
	{ value: "prompts", singular: "prompt", label: "Prompts" },
	{ value: "sandboxes", singular: "sandbox", label: "Sandboxes" },
] as const;

type ComponentGroupKey = (typeof COMPONENT_TYPES)[number]["value"];

const COMPONENT_GROUP_BY_TYPE: Record<string, ComponentGroupKey> = {
	mcp: "mcps",
	mcps: "mcps",
	skill: "skills",
	skills: "skills",
	hook: "hooks",
	hooks: "hooks",
	prompt: "prompts",
	prompts: "prompts",
	sandbox: "sandboxes",
	sandboxes: "sandboxes",
};

// Visibility is decided by the publish target (personal vs project vs public
// catalog) when a change is created; the workspace only reports it.
const VISIBILITY_LABELS: Record<string, string> = {
	public: "Public",
	team: "Project",
	private: "Personal",
};

function semverCompareDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i += 1) {
		const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return b.localeCompare(a);
}

function getLatestApprovedVersion(versions: AgentVersionSummary[]): string | undefined {
	return [...versions]
		.filter((v) => v.status === "approved")
		.sort((a, b) => semverCompareDesc(a.version, b.version))[0]?.version;
}

function normalizeVersionComponents(components?: AgentComponentReference[]): ComponentLink[] | undefined {
	if (!components) return undefined;
	return components.map((component) => ({
		component_type: component.component_type,
		component_id: component.component_id,
		component_name: component.component_name,
		mcp_name: component.mcp_name,
		name: component.name,
		resolved_version: component.resolved_version,
		status: component.status,
	}));
}

function getComponentName(component: ComponentLink): string {
	return component.mcp_name ?? component.component_name ?? component.name ?? component.component_id ?? component.mcp_id ?? "Unnamed";
}

function getComponentType(component: ComponentLink): string {
	return component.component_type ?? "mcp";
}

function getComponentGroup(component: ComponentLink): ComponentGroupKey {
	return COMPONENT_GROUP_BY_TYPE[getComponentType(component)] ?? "mcps";
}

function groupComponents(components: ComponentLink[]): Record<ComponentGroupKey, ComponentLink[]> {
	return components.reduce<Record<ComponentGroupKey, ComponentLink[]>>(
		(groups, component) => {
			groups[getComponentGroup(component)].push(component);
			return groups;
		},
		{ mcps: [], skills: [], hooks: [], prompts: [], sandboxes: [] },
	);
}

function VersionContentLoading() {
	return (
		<div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-muted-foreground">
			<Loader2 className="h-4 w-4 animate-spin" />
			Loading version contents...
		</div>
	);
}

function ArchivedComponentsBanner({ components }: { components: ComponentLink[] }) {
	const names = components.slice(0, 3).map(getComponentName).join(", ");
	const extra = components.length > 3 ? ` and ${components.length - 3} more` : "";

	return (
		<div className="flex items-start gap-3 rounded-md border border-dark-yellow/30 bg-light-yellow px-4 py-3 text-dark-yellow">
			<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
			<div className="space-y-1 text-sm">
				<p className="font-medium">
					This agent includes archived components: {names}{extra}.
				</p>
				<p className="text-xs text-dark-yellow/80">
					Users can still pull the agent, but installs will show archived component warnings.
				</p>
			</div>
		</div>
	);
}

function PromptSection({ prompt }: { prompt: string }) {
	const [expanded, setExpanded] = useState(false);
	const lineCount = prompt.split("\n").length;
	const isLong = lineCount > 12;

	return (
		<div className="space-y-2">
			<h3 className="text-sm font-semibold font-display">Agent Prompt</h3>
			<div className="relative">
				<pre
					className={`select-text rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm font-mono whitespace-pre-wrap wrap-break-word leading-relaxed text-foreground ${isLong && !expanded ? "max-h-70 overflow-hidden" : ""}`}
				>
					{prompt}
				</pre>
				{isLong && !expanded && (
					<div className="absolute inset-x-0 bottom-0 flex h-16 items-end justify-center rounded-b-md bg-gradient-to-t from-surface-sunken to-transparent pb-2">
						<button
							type="button"
							onClick={() => setExpanded(true)}
							className="rounded border border-border/50 bg-background/80 px-2 py-1 text-xs font-medium text-primary backdrop-blur-sm hover:text-primary/80"
						>
							Show full prompt
						</button>
					</div>
				)}
				{isLong && expanded && (
					<button
						type="button"
						onClick={() => setExpanded(false)}
						className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
					>
						Collapse
					</button>
				)}
			</div>
		</div>
	);
}

function SuccessCriteriaSection({ criteria }: { criteria: SuccessCriteria }) {
	return (
		<div className="space-y-3">
			<h3 className="text-sm font-semibold font-display">Success Criteria</h3>
			<div className="space-y-3 rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm">
				<div>
					<p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Purpose</p>
					<p className="whitespace-pre-wrap text-foreground">{criteria.intended_purpose}</p>
				</div>
				{(criteria.success_metrics?.length ?? 0) > 0 && (
					<div>
						<p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Metrics</p>
						<div className="space-y-2">
							{criteria.success_metrics.map((m, i) => (
								<div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-border/50 bg-background/50 px-3 py-2">
									<span className="font-medium text-foreground">{m.name}</span>
									<span className="text-xs text-muted-foreground">target: <span className="font-mono text-foreground">{m.target}</span></span>
									<span className="text-xs text-muted-foreground">via: <span className="text-foreground">{m.measurement}</span></span>
								</div>
							))}
						</div>
					</div>
				)}
				{criteria.evaluation_notes && (
					<div>
						<p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Evaluation Notes</p>
						<p className="whitespace-pre-wrap text-foreground">{criteria.evaluation_notes}</p>
					</div>
				)}
			</div>
		</div>
	);
}

function AgentVersionContents({ components }: { components: ComponentLink[] }) {
	const [activeTab, setActiveTab] = useState<ComponentGroupKey>("mcps");
	const groupedComponents = useMemo(() => groupComponents(components), [components]);

	return (
		<section className="space-y-4">
			<div>
				<h3 className="text-sm font-medium font-display">Components</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					MCPs, skills, hooks, prompts, and sandboxes linked to this agent version.
				</p>
			</div>

			{components.length === 0 ? (
				<EmptyState
					icon={Puzzle}
					title="No components linked"
					description="This version does not have any linked MCP servers or components."
				/>
			) : (
				<Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ComponentGroupKey)}>
					<TabsList>
						{COMPONENT_TYPES.map((componentType) => {
							const count = groupedComponents[componentType.value].length;
							return (
								<TabsTrigger key={componentType.value} value={componentType.value}>
									{componentType.label}
									{count > 0 && (
										<span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
											{count}
										</span>
									)}
								</TabsTrigger>
							);
						})}
					</TabsList>

					{COMPONENT_TYPES.map((componentType) => {
						const items = groupedComponents[componentType.value];
						return (
							<TabsContent key={componentType.value} value={componentType.value} className="mt-3">
								{items.length === 0 ? (
									<p className="py-6 text-center text-sm text-muted-foreground">
										No {componentType.label} linked to this version.
									</p>
								) : (
									<div className="space-y-2">
										{items.map((component, index) => {
											const componentName = getComponentName(component);
											const componentId = component.component_id ?? component.mcp_id;
											const row = (
												<div className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3 transition-colors hover:bg-accent/40">
													<div className="flex min-w-0 items-center gap-3">
														<Badge variant="outline" className="shrink-0 text-[10px]">
															{componentType.singular}
														</Badge>
														{component.status === "archived" && (
															<StatusBadge status="archived" className="shrink-0" />
														)}
														<span className="truncate text-sm font-medium">{componentName}</span>
														{component.resolved_version && (
															<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
																{component.resolved_version === "latest" ? "latest" : `v${component.resolved_version}`}
															</span>
														)}
													</div>
													{component.status && component.status !== "archived" && <StatusBadge status={component.status} />}
												</div>
											);

											return componentId ? (
												<Link
													key={`${componentType.value}-${componentId}-${index}`}
													to={
														component.status === "approved"
															? registryItemPath(component, componentType.value, componentId)
															: `/components/${componentId}?type=${componentType.value}`
													}
												>
													{row}
												</Link>
											) : (
												<div key={`${componentType.value}-${componentName}-${index}`}>{row}</div>
											);
										})}
									</div>
								)}
							</TabsContent>
						);
					})}
				</Tabs>
			)}
		</section>
	);
}

function AgentDeleteButton({ agentId, agentName, onSuccess }: { agentId: string; agentName: string; onSuccess: () => void }) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const deleteMutation = useDeleteAgent();

	function submit() {
		deleteMutation.mutate(agentId, {
			onSuccess: () => {
				setConfirmOpen(false);
				onSuccess();
			},
		});
	}

	return (
		<>
			<Button variant="destructive" size="sm" className="h-8" onClick={() => setConfirmOpen(true)} disabled={deleteMutation.isPending}>
				<Trash2 className="mr-1 h-3.5 w-3.5" />
				Delete
			</Button>

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete {agentName}?</DialogTitle>
					</DialogHeader>
					<p className="text-sm text-muted-foreground">
						This soft deletes the agent, hides it from registry lists, and frees the name for reuse.
					</p>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
						<Button variant="destructive" onClick={submit} disabled={deleteMutation.isPending}>
							{deleteMutation.isPending ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Deleting...</> : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function AgentArchiveButton({ agentId, agentName, status, onSuccess }: { agentId: string; agentName: string; status?: string; onSuccess: () => void }) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const archiveMutation = useArchiveAgent();
	const unarchiveMutation = useUnarchiveAgent();
	const isArchived = status === "archived";
	const isBusy = archiveMutation.isPending || unarchiveMutation.isPending;

	function submit() {
		const mutation = isArchived ? unarchiveMutation : archiveMutation;
		mutation.mutate(agentId, {
			onSuccess: () => {
				setConfirmOpen(false);
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
				onClick={() => setConfirmOpen(true)}
				disabled={isBusy}
			>
				{isArchived ? <ArchiveRestore className="mr-1 h-3.5 w-3.5" /> : <Archive className="mr-1 h-3.5 w-3.5" />}
				{isArchived ? "Restore" : "Archive"}
			</Button>

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{isArchived ? `Restore ${agentName}?` : `Archive ${agentName}?`}</DialogTitle>
					</DialogHeader>
					<p className="text-sm text-muted-foreground">
						{isArchived
							? "This makes the agent discoverable again."
							: "Archived agents stop appearing in registry lists. Direct pulls still work by ID."}
					</p>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
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

function InsightStatusBadge({ status }: { status: InsightReportListItem["status"] }) {
	switch (status) {
		case "completed":
			return (
				<span className="inline-flex items-center gap-1 rounded-full bg-light-green px-2 py-0.5 text-xs font-medium text-dark-green">
					<CheckCircle2 className="h-3 w-3" /> Completed
				</span>
			);
		case "running":
			return (
				<span className="inline-flex items-center gap-1 rounded-full bg-light-blue px-2 py-0.5 text-xs font-medium text-dark-blue">
					<Loader2 className="h-3 w-3 animate-spin" /> Running
				</span>
			);
		case "pending":
			return (
				<span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
					<Clock className="h-3 w-3" /> Queued
				</span>
			);
		case "failed":
			return (
				<span className="inline-flex items-center gap-1 rounded-full bg-light-red px-2 py-0.5 text-xs font-medium text-dark-red">
					<XCircle className="h-3 w-3" /> Failed
				</span>
			);
	}
}

function InsightsTab({ agentId, agentVersion }: { agentId: string; agentVersion?: string | null }) {
	const { data: reports, isLoading: reportsLoading } = useInsightReports(agentId);
	const { data: sessionCountData, isLoading: countLoading } = useInsightSessionCount(agentId, agentVersion);
	const { data: insightsStatus } = useInsightsStatus();
	const generateInsight = useGenerateInsight();

	const availableSessions = sessionCountData?.session_count ?? 0;
	const notConfigured = insightsStatus && !insightsStatus.available;
	const hasRunning = (reports ?? []).some((r) => r.status === "pending" || r.status === "running");

	return (
		<div className="space-y-6">
			{/* Status / Generate bar */}
			<div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
				<div className="space-y-1">
					<h3 className="flex items-center gap-2 text-sm font-semibold font-display">
						<Sparkles className="h-4 w-4 text-primary" />
						Agent Insights
					</h3>
					<p className="text-xs text-muted-foreground">
						{countLoading
							? "Checking sessions..."
							: `${availableSessions} session${availableSessions !== 1 ? "s" : ""} available for ${sessionCountData?.agent_version ?? agentVersion ?? "latest approved"} (last 14 days)`}
					</p>
				</div>
				<Button
					size="sm"
					className="gap-1.5"
					disabled={
						!!notConfigured ||
						(!countLoading && availableSessions === 0) ||
						generateInsight.isPending ||
						hasRunning
					}
					onClick={() => generateInsight.mutate({ agentId, agentVersion: agentVersion ?? undefined })}
				>
					{generateInsight.isPending ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Play className="h-3.5 w-3.5" />
					)}
					Generate
				</Button>
			</div>

			{notConfigured && (
				<p className="text-xs text-muted-foreground">
					Insights are not configured on this server. Contact your admin.
				</p>
			)}

			{/* Reports list */}
			{reportsLoading ? (
				<div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" /> Loading reports...
				</div>
			) : !reports || reports.length === 0 ? (
				<EmptyState
					icon={Sparkles}
					title="No insights yet"
					description="Generate your first insight report to see how this agent is performing."
				/>
			) : (
				<div className="space-y-3">
					<h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reports</h4>
					<div className="space-y-2">
						{reports.map((report) => (
							<Link
								key={report.id}
								to="/agents/$agentId/insights/$reportId"
								params={{ agentId, reportId: report.id }}
								className="flex items-center justify-between gap-4 rounded-md border border-border p-3 transition-colors hover:bg-muted/50"
							>
								<div className="flex min-w-0 items-center gap-3">
									<InsightStatusBadge status={report.status} />
									<span className="font-mono text-xs tabular-nums text-muted-foreground">
										{new Date(report.created_at).toLocaleDateString(undefined, {
											month: "short",
											day: "numeric",
											year: "numeric",
										})}
									</span>
									{report.agent_version && (
										<span className="text-xs text-muted-foreground">
											v{report.agent_version}
										</span>
									)}
									{report.sessions_analyzed > 0 && (
										<span className="text-xs text-muted-foreground">
											{report.sessions_analyzed} sessions analyzed
										</span>
									)}
									{(report.status === "pending" || report.status === "running") && report.progress_phase && (
										<span className="text-xs text-muted-foreground">
											{report.progress_phase.replace(/_/g, " ")}
										</span>
									)}
								</div>
								{report.status === "completed" && (
									<span className="text-xs text-primary">View →</span>
								)}
							</Link>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

export default function AgentDetailPage({ agentId }: { agentId?: string } = {}) {
	// Rendered from two routes: the canonical /agents/$namespace/$slug route
	// passes the resolved UUID as a prop; the legacy /agents/$agentId route
	// supplies it as a path param.
	const params = useParams({ strict: false }) as { agentId?: string };
	const id = agentId ?? params.agentId ?? "";
	const navigate = useNavigate();
	const {
		data: agent,
		isLoading,
		isError,
		error,
		refetch,
	} = useRegistryItem("agents", id);
	const { data: downloadData } = useAgentDownloads(id);

	const { data: whoami } = useWhoami();
	const restoreVersion = useRestoreAgentVersion();
	const { data: versionsData, isLoading: versionsLoading } = useAgentVersions(id);
	const { data: issuesData } = useReviewIssues(id);
	const { data: activityData } = useResourceActivity(id, 8);
	const versions = versionsData?.items ?? [];
	const latestApprovedVersion = useMemo(() => getLatestApprovedVersion(versions), [versions]);
	const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
	const { data: versionDetail, isLoading: isVersionDetailLoading } = useAgentVersionDetail(id, selectedVersion);
	const effectiveVersionForDetail = selectedVersion ?? latestApprovedVersion ?? (agent as AgentDetail | undefined)?.version ?? null;
	const { data: effectiveVersionDetail } = useAgentVersionDetail(id, effectiveVersionForDetail);
	const { view: requestedView, setView } = useWorkspaceView();

	// Co-authors
	const [coAuthors, setCoAuthors] = useState<CoAuthor[]>([]);
	useEffect(() => {
		const token = getAccessToken();
		const headers: Record<string, string> = {};
		if (token) headers["Authorization"] = `Bearer ${token}`;
		fetch(`/api/v1/agents/${id}/co-authors`, { headers })
			.then((r) => (r.ok ? r.json() : []))
			.then((data) => setCoAuthors(data))
			.catch(() => {});
	}, [id]);

	const storeSub = useCallback((cb: () => void) => {
		window.addEventListener("storage", cb);
		return () => window.removeEventListener("storage", cb);
	}, []);
	const isAdmin = useSyncExternalStore(
		storeSub,
		() => hasMinRole(getUserRole(), "operator"),
		() => false,
	);

	const a = agent as AgentDetail | undefined;
	const effectiveVersion = selectedVersion ?? latestApprovedVersion ?? a?.version;
	const selectedVersionSummary = versions.find((v) => v.version === effectiveVersion);
	const vd = versionDetail ?? effectiveVersionDetail;
	const isVersionContentLoading = !!selectedVersion && !versionDetail && isVersionDetailLoading;
	const baseComponents: ComponentLink[] = a?.component_links ?? a?.mcp_links ?? [];
	const versionComponents = selectedVersion ? normalizeVersionComponents(vd?.components) : undefined;
	const components: ComponentLink[] = selectedVersion ? (versionComponents ?? []) : baseComponents;
	const displayComponentCount = selectedVersion
		? (versionComponents?.length ?? selectedVersionSummary?.component_count ?? 0)
		: components.length;
	const versionDescription = vd?.description ?? selectedVersionSummary?.description ?? a?.description;
	const versionPrompt = vd?.prompt ?? (selectedVersion ? undefined : a?.prompt);
	const versionModelName = vd?.model_name ?? (selectedVersion ? undefined : a?.model_name);
	const versionSupportedIdes = vd?.supported_harnesses ?? selectedVersionSummary?.supported_harnesses ?? a?.supported_harnesses;
	const versionRequiredFeatures = vd?.required_capabilities ?? (selectedVersion ? undefined : a?.required_capabilities);
	const versionInferredIdes = vd?.inferred_supported_harnesses ?? (selectedVersion ? undefined : a?.inferred_supported_harnesses);
	const versionSuccessCriteria = (vd?.success_criteria ?? (selectedVersion ? undefined : a?.success_criteria)) as SuccessCriteria | null | undefined;
	const isOwner = !!(whoami?.id && a?.created_by && whoami.id === String(a.created_by));
	const canTransferOwnership = isOwner;
	const currentVisibility = a?.visibility ?? (a?.is_private ? "team" : "public");
	const canManageLifecycle = isAdmin || isOwner;
	const agentStatus = a?.status as string | undefined;
	const canEdit = (isAdmin || a?.user_permission === "owner" || a?.user_permission === "edit") && ["approved", "pending", "draft", "rejected"].includes(agentStatus ?? "");
	// Restore is a release operation; the server requires full ownership.
	const canRestore = a?.user_permission === "owner";
	const canOpenIssues = hasMinRole(getUserRole(), "reviewer") || isOwner;
	// Header/breadcrumb show the bare name; the pull command needs the canonical
	// `namespace/slug` the CLI resolves.
	const agentIdentity = registryIdentity(a as QualifiedIdentity | undefined, id.slice(0, 8));
	const agentName = agentIdentity.name;
	const agentRef = agentIdentity.qualified;
	// Canonical shareable path from the explicit columns only, and only when the
	// namespace/slug actually resolve server-side (legacy verbatim-username
	// namespaces do not).
	const canonicalParts = canonicalRouteParts(
		(a as QualifiedIdentity | undefined)?.namespace,
		(a as QualifiedIdentity | undefined)?.slug,
	);
	const canonicalAgentPath = canonicalParts
		? `/agents/${canonicalParts.namespace}/${canonicalParts.slug}`
		: undefined;
	const totalDownloads = downloadData?.total ?? a?.download_count;
	const uniqueUsers = downloadData?.unique_users;

	// Legacy /agents/<uuid> entry: once the payload reveals a canonical identity,
	// swap the address bar to the shareable URL - but ONLY for approved agents.
	// The canonical /registry/resolve route only returns approved-or-owned
	// agents, so redirecting a reviewer/admin/co-author viewing a pending agent
	// would strand them on a 404. Their UUID URL keeps working.
	const agentApproved = (a?.status as string | undefined) === "approved";
	useEffect(() => {
		if (agentId || !canonicalParts || !agentApproved) return;
		navigate({
			to: "/agents/$namespace/$slug",
			params: canonicalParts,
			search: (prev: Record<string, unknown>) => prev,
			replace: true,
		});
	}, [agentId, canonicalParts, agentApproved, navigate]);
	const archivedComponents = components.filter((component) => component.status === "archived");

	const versionRows: WorkspaceVersionRow[] = versions.map((v) => ({
		id: v.id,
		version: v.version,
		status: v.status,
		description: v.description,
		released_by: v.released_by,
		released_at: v.released_at,
		created_at: v.created_at,
		rejection_reason: v.rejection_reason,
		is_prerelease: v.is_prerelease,
	}));
	const openChanges = versionRows.filter((v) => v.status === "pending" || v.status === "draft").length;
	const openIssues = issuesData?.open_count ?? 0;

	const loadDiff = useCallback(
		async (base: string, head: string) => {
			const diff = await registry.getVersionDiff(id, base, head);
			return diff.yaml_diff ?? "";
		},
		[id],
	);

	const tabs: WorkspaceTab[] = [
		{ id: "overview", label: "Overview", icon: LayoutList },
		{ id: "source", label: "Source", icon: FileCode2, count: displayComponentCount },
		{ id: "versions", label: "Versions", icon: Tags, count: versions.length },
		{ id: "changes", label: "Changes", icon: GitPullRequest, count: openChanges, attention: openChanges > 0 },
		{ id: "issues", label: "Issues", icon: CircleDot, count: openIssues, attention: openIssues > 0 },
		{ id: "activity", label: "Activity", icon: History },
		{ id: "contributors", label: "Contributors", icon: Users },
		{ id: "insights", label: "Insights", icon: Sparkles, hidden: !canEdit },
	];

	// "review" is the changes tab drilled into one open change; a stale or
	// unauthorized ?view= deep link falls back to Overview.
	const view =
		requestedView === "review" || tabs.some((tab) => tab.id === requestedView && !tab.hidden)
			? requestedView
			: "overview";
	const activeTab = view === "review" ? "changes" : view;
	const openReview = () => setView("review");

	const openInBuilder = canEdit && typeof a?.namespace === "string" && typeof a?.slug === "string";

	return (
		<>
			<PageHeader
				title={isLoading ? "Agent" : agentName}
				breadcrumbs={[
					{ label: "Registry", href: "/" },
					{ label: "Resources", href: "/resources" },
					{ label: isLoading ? "..." : agentName },
				]}
				actionButtonsRight={
					a ? (
						<div className="flex items-center gap-1.5">
							{openInBuilder && (
								<Button asChild size="sm" variant="outline" className="h-7 gap-1.5 text-xs">
									<Link
										to="/agents/$namespace/$slug/edit"
										params={{ namespace: a.namespace as string, slug: a.slug as string }}
									>
										<Hammer className="h-3.5 w-3.5" />
										Open in Builder
									</Link>
								</Button>
							)}
							{openChanges > 0 && (
								<Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={openReview}>
									<GitPullRequest className="h-3.5 w-3.5" />
									View change
								</Button>
							)}
							<ShareLinkButton path={canonicalAgentPath ?? `/agents/${id}`} />
						</div>
					) : undefined
				}
			/>

			<div className="w-full space-y-5 p-6 lg:p-8">
				{isLoading ? (
					<DetailSkeleton />
				) : isError ? (
					<ErrorState message={error?.message} onRetry={() => refetch()} />
				) : !a ? (
					<ErrorState message="Agent not found" />
				) : (
					<div className="animate-in space-y-5">
						{canEdit && archivedComponents.length > 0 && (
							<ArchivedComponentsBanner components={archivedComponents} />
						)}

						{/* Resource header */}
						<div className="space-y-2">
							<div className="flex flex-wrap items-start gap-3">
								<RegistryName
									item={a as QualifiedIdentity}
									as="h1"
									nameClassName="text-2xl font-display font-bold tracking-tight"
									handleClassName="text-sm text-muted-foreground"
								/>
								<Badge variant="outline" className="text-xs">agent</Badge>
								{a.status && <StatusBadge status={a.status} />}
								<Badge variant="outline" className="text-xs">
									{VISIBILITY_LABELS[currentVisibility] ?? currentVisibility}
								</Badge>
								{(latestApprovedVersion ?? a.version) && (
									<Badge variant="secondary" className="font-mono text-xs">
										v{latestApprovedVersion ?? a.version}
									</Badge>
								)}
							</div>
							{versionDescription && (
								<p className="max-w-2xl text-sm leading-relaxed text-foreground/80">{versionDescription}</p>
							)}
							<p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
								{a.owner && <span>by {a.owner}</span>}
								{versionModelName && <span className="font-mono">{versionModelName}</span>}
								{totalDownloads != null && (
									<span className="inline-flex items-center gap-1">
										<ArrowDownToLine className="h-3 w-3" />
										{compactNumber(totalDownloads)}
									</span>
								)}
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

									{/* Pull command (mobile only; desktop has it in the rail) */}
									<div className="lg:hidden">
										<PullCommand
											agentName={agentRef}
											currentVersion={effectiveVersion}
											latestVersion={latestApprovedVersion ?? a.version}
										/>
									</div>

									{versionPrompt && <PromptSection prompt={versionPrompt} />}

									{versionSuccessCriteria?.intended_purpose && (
										<SuccessCriteriaSection criteria={versionSuccessCriteria} />
									)}

									{!versionPrompt && !versionSuccessCriteria?.intended_purpose && (
										<p className="text-sm text-muted-foreground">
											No additional details provided for this agent.
										</p>
									)}

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
									<PullCommand
										agentName={agentRef}
										currentVersion={effectiveVersion}
										latestVersion={latestApprovedVersion ?? a.version}
									/>

									<div className="space-y-3 rounded-md border border-border p-4">
										<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
											Current version
										</h3>
										<div className="space-y-2 text-sm">
											<div className="flex items-center justify-between">
												<span className="text-muted-foreground">Active</span>
												<span className="font-mono font-medium">
													{latestApprovedVersion ?? a.version ? `v${latestApprovedVersion ?? a.version}` : "–"}
												</span>
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
											{totalDownloads != null && (
												<div className="flex items-center justify-between text-sm">
													<span className="inline-flex items-center gap-2 text-muted-foreground">
														<ArrowDownToLine className="h-3.5 w-3.5" />
														Downloads
													</span>
													<span className="font-mono font-medium">
														{compactNumber(totalDownloads)}
													</span>
												</div>
											)}
											{uniqueUsers != null && uniqueUsers > 0 && (
												<div className="flex items-center justify-between text-sm">
													<span className="inline-flex items-center gap-2 text-muted-foreground">
														<Users className="h-3.5 w-3.5" />
														Unique users
													</span>
													<span className="font-mono font-medium">
														{compactNumber(uniqueUsers)}
													</span>
												</div>
											)}
											<div className="flex items-center justify-between text-sm">
												<span className="inline-flex items-center gap-2 text-muted-foreground">
													<Puzzle className="h-3.5 w-3.5" />
													Components
												</span>
												<span className="font-mono font-medium">
													{displayComponentCount}
												</span>
											</div>
											{versionModelName && (
												<div className="flex items-center justify-between text-sm">
													<span className="text-muted-foreground">Model</span>
													<span className="max-w-35 truncate font-mono text-xs">
														{versionModelName}
													</span>
												</div>
											)}
										</div>
									</div>

									<div className="space-y-3 rounded-md border border-border p-4">
										<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
											Harness compatibility
										</h3>
										<HarnessBadges
											supportedHarnesses={versionSupportedIdes}
											inferredSupportedHarnesses={versionInferredIdes}
											max={7}
										/>
										{versionRequiredFeatures && versionRequiredFeatures.length > 0 && (
											<div className="space-y-1">
												<p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
													Required features
												</p>
												<div className="flex flex-wrap gap-1">
													{versionRequiredFeatures.map((f: string) => (
														<span key={f} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
															{FEATURE_LABELS[f] ?? f}
														</span>
													))}
												</div>
											</div>
										)}
									</div>

									{a.owner && (
										<div className="space-y-2 rounded-md border border-border p-4">
											<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Publisher
											</h3>
											<p className="text-sm">{a.owner}</p>
										</div>
									)}

									{(a?.user_permission === "owner" || coAuthors.length > 0 || canManageLifecycle) && (
										<div className="space-y-4 rounded-md border border-border p-4">
											<h3 className="font-display text-xs font-semibold uppercase tracking-wider text-muted-foreground">
												Ownership & lifecycle
											</h3>

											{(a?.user_permission === "owner" || coAuthors.length > 0) && (
												<CoAuthorInput
													entityType="agents"
													entityId={id}
													coAuthors={coAuthors}
													onChange={setCoAuthors}
													canManage={a?.user_permission === "owner"}
													canTransferOwnership={canTransferOwnership}
													onTransferOwnership={() => refetch()}
												/>
											)}

											{canManageLifecycle && (agentStatus === "approved" || agentStatus === "archived") && (
												<div className="space-y-2 border-t border-border pt-3">
													<p className="text-sm font-medium">Lifecycle</p>
													<div className="flex flex-wrap gap-2">
														<AgentArchiveButton agentId={id} agentName={agentName} status={agentStatus} onSuccess={() => refetch()} />
														{agentStatus === "approved" && (
															<AgentDeleteButton agentId={id} agentName={agentName} onSuccess={() => navigate({ to: "/resources" })} />
														)}
													</div>
												</div>
											)}
										</div>
									)}
								</aside>
							</div>
						)}

						{view === "source" && (
							<div className="max-w-4xl space-y-6">
								<div className="flex items-center gap-2">
									<span className="text-xs text-muted-foreground">Definition at</span>
									<PickerSelect
										value={effectiveVersion ?? ""}
										onValueChange={(v) => setSelectedVersion(v === latestApprovedVersion ? null : v)}
										options={versions
											.filter((v) => v.status === "approved")
											.sort((x, y) => semverCompareDesc(x.version, y.version))
											.map((v) => ({
												value: v.version,
												label: `v${v.version}${v.version === latestApprovedVersion ? " (active)" : ""}`,
											}))}
										placeholder="Version"
										ariaLabel="Definition version"
										className="w-40"
										inputClassName="h-7 px-2 text-xs"
									/>
									{selectedVersion && selectedVersion !== latestApprovedVersion && (
										<span className="inline-flex items-center gap-1 text-xs text-warning">
											<AlertTriangle className="h-3 w-3" />
											Viewing a historical version
										</span>
									)}
								</div>

								{isVersionContentLoading ? (
									<VersionContentLoading />
								) : (
									<>
										{versionPrompt && <PromptSection prompt={versionPrompt} />}
										{versionModelName && (
											<div className="space-y-1">
												<h3 className="text-sm font-semibold font-display">Model</h3>
												<p className="font-mono text-sm text-muted-foreground">{versionModelName}</p>
											</div>
										)}
										{versionSuccessCriteria?.intended_purpose && (
											<SuccessCriteriaSection criteria={versionSuccessCriteria} />
										)}
										<AgentVersionContents components={components} />
									</>
								)}
							</div>
						)}

						{view === "versions" && (
							<VersionsPanel
								rows={versionRows}
								isLoading={versionsLoading}
								activeVersion={latestApprovedVersion ?? a.version}
								onOpenChange={openReview}
								canRestore={canRestore}
								restoreBusy={restoreVersion.isPending}
								onRestore={(version, reason) => restoreVersion.mutate({ agentId: id, version, reason })}
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
									canPropose={openInBuilder}
									proposeLabel="Open in Builder"
									onPropose={() =>
										navigate({
											to: "/agents/$namespace/$slug/edit",
											params: { namespace: a.namespace as string, slug: a.slug as string },
										})
									}
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

						{view === "insights" && canEdit && (
							<div className="max-w-4xl">
								<InsightsTab agentId={id} agentVersion={effectiveVersion} />
							</div>
						)}
					</div>
				)}
			</div>
		</>
	);
}
