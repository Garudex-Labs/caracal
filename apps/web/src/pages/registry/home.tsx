// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
	ArrowRight,
	Bot,
	FolderKanban,
	GitPullRequest,
	Inbox,
	ListTree,
	Plus,
	Radar,
	Workflow,
	type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { AddResourceSheet } from "@/components/registry/add-resource-sheet";
import { Button } from "@/components/ui/button";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import { useOrgProjects, useOrgs } from "@/hooks/use-orgs-api";
import {
	useIntelligenceBriefing,
	useIntelligenceHistory,
} from "@/hooks/use-intelligence-workspace";
import { useProjectResources } from "@/hooks/use-registry-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import type {
	IntelligenceHistoryEvent,
	IntelligenceSignal,
	ProjectResource,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const RESOURCE_LABELS: Record<ProjectResource["resource_type"], string> = {
	agents: "Agent",
	mcps: "MCP server",
	skills: "Skill",
	hooks: "Hook",
	prompts: "Prompt",
};

const SEVERITY_CLASS: Record<string, string> = {
	critical: "text-destructive",
	warning: "text-warning",
	info: "text-muted-foreground",
};

const EVENT_CLASS: Record<string, string> = {
	change: "text-primary-accent",
	quality: "text-warning",
	usage: "text-success",
	cost: "text-muted-foreground",
};

function resourcePath(resource: ProjectResource): string {
	if (resource.resource_type === "agents") {
		return `/agents/${resource.namespace}/${resource.slug}`;
	}
	return `/components/${resource.resource_type}/${resource.namespace}/${resource.slug}`;
}

function relativeTime(value?: string | null): string {
	if (!value) return "Date unavailable";
	const timestamp = new Date(value).getTime();
	if (!Number.isFinite(timestamp)) return "Date unavailable";
	const elapsed = Date.now() - timestamp;
	const minutes = Math.max(0, Math.floor(elapsed / 60_000));
	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function SectionHeader({
	title,
	description,
	action,
}: {
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<header className="mb-3 flex items-end justify-between gap-4">
			<div className="min-w-0">
				<h2 className="text-sm font-semibold text-foreground">{title}</h2>
				<p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
			</div>
			{action}
		</header>
	);
}

function InlineLoading({ rows = 3 }: { rows?: number }) {
	return (
		<div className="divide-y divide-border border-y border-border" aria-label="Loading">
			{Array.from({ length: rows }, (_, index) => (
				<div key={index} className="space-y-2 py-3">
					<div className="h-3 w-2/5 animate-pulse rounded-sm bg-muted" />
					<div className="h-2.5 w-4/5 animate-pulse rounded-sm bg-muted/70" />
				</div>
			))}
		</div>
	);
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
	return (
		<div className="flex items-center justify-between gap-4 border-y border-destructive/30 py-4 text-sm">
			<p className="text-destructive">{message}</p>
			<Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={onRetry}>
				Retry
			</Button>
		</div>
	);
}

function ProjectState({
	loading,
	error,
	onRetry,
	hasData,
	sessions,
	resources,
	attention,
}: {
	loading: boolean;
	error: boolean;
	onRetry: () => void;
	hasData: boolean;
	sessions: number | null;
	resources: number | null;
	attention: number;
}) {
	if (loading) return <InlineLoading rows={1} />;
	if (error) return <InlineError message="Project activity is unavailable." onRetry={onRetry} />;
	if (!hasData) {
		return (
			<p className="border-y border-border py-4 text-sm text-muted-foreground">
				No project activity has been recorded yet. Add a resource or connect a supported harness to begin.
			</p>
		);
	}
	return (
		<dl className="grid border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
			<div className="py-3 sm:pr-5">
				<dt className="text-[10px] font-medium uppercase text-muted-foreground">Last 7 days</dt>
				<dd className="mt-1 text-sm text-foreground">
					{sessions === null ? "Session data unavailable" : `${sessions.toLocaleString()} captured sessions`}
				</dd>
			</div>
			<div className="border-t border-border py-3 sm:border-t-0 sm:px-5">
				<dt className="text-[10px] font-medium uppercase text-muted-foreground">Project resources</dt>
				<dd className="mt-1 text-sm text-foreground">
					{resources === null ? "Resource count unavailable" : `${resources.toLocaleString()} available resources`}
				</dd>
			</div>
			<div className="border-t border-border py-3 sm:border-t-0 sm:pl-5">
				<dt className="text-[10px] font-medium uppercase text-muted-foreground">Needs attention</dt>
				<dd className={cn("mt-1 text-sm", attention > 0 ? "text-warning" : "text-foreground")}>
					{attention > 0 ? `${attention} material ${attention === 1 ? "change" : "changes"}` : "No material changes"}
				</dd>
			</div>
		</dl>
	);
}

function SignalRow({ signal }: { signal: IntelligenceSignal }) {
	return (
		<li className="grid gap-2 border-b border-border py-3 last:border-b-0 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
			<p className={cn("text-[10px] font-medium uppercase", SEVERITY_CLASS[signal.severity])}>
				{signal.severity}
			</p>
			<div className="min-w-0">
				<p className="text-sm font-medium text-foreground">{signal.title}</p>
				<p className="mt-0.5 text-xs leading-5 text-muted-foreground">{signal.impact}</p>
				{signal.qualified_name && (
					<p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
						{signal.qualified_name}
					</p>
				)}
			</div>
			<Link
				to="/intelligence"
				search={{ signal: signal.id, ...(signal.agent_id ? { resource: signal.agent_id } : {}) }}
				className="text-xs font-medium text-primary-accent hover:underline sm:pt-0.5"
			>
				Inspect
			</Link>
		</li>
	);
}

function AttentionSection({
	loading,
	error,
	signals,
	onRetry,
}: {
	loading: boolean;
	error: boolean;
	signals: IntelligenceSignal[];
	onRetry: () => void;
}) {
	return (
		<section aria-labelledby="attention-heading">
			<SectionHeader
				title="Needs attention"
				description="Evidence-backed project changes that may require a decision."
				action={
					<Link to="/intelligence" className="shrink-0 text-xs text-primary-accent hover:underline">
						Open Intelligence
					</Link>
				}
			/>
			{loading ? (
				<InlineLoading />
			) : error ? (
				<InlineError message="Attention items could not be loaded." onRetry={onRetry} />
			) : signals.length === 0 ? (
				<p className="border-y border-border py-5 text-sm text-muted-foreground">
					No material changes currently require attention.
				</p>
			) : (
				<ul className="border-y border-border">
					{signals.slice(0, 4).map((signal) => <SignalRow key={signal.id} signal={signal} />)}
				</ul>
			)}
		</section>
	);
}

function EventRow({ event }: { event: IntelligenceHistoryEvent }) {
	return (
		<li className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
			<p className={cn("text-[10px] font-medium uppercase", EVENT_CLASS[event.category])}>{event.category}</p>
			<div className="min-w-0">
				<p className="text-sm font-medium text-foreground">{event.title}</p>
				<p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{event.detail}</p>
				{event.version && <p className="mt-1 font-mono text-[10px] text-muted-foreground">Version {event.version}</p>}
			</div>
			<time className="text-[11px] text-muted-foreground sm:whitespace-nowrap">{relativeTime(event.occurred_at)}</time>
		</li>
	);
}

function ActivitySection({
	loading,
	error,
	events,
	onRetry,
}: {
	loading: boolean;
	error: boolean;
	events: IntelligenceHistoryEvent[];
	onRetry: () => void;
}) {
	return (
		<section aria-labelledby="activity-heading">
			<SectionHeader
				title="Recent activity"
				description="Releases, reviews, quality events, and material usage changes in this project."
				action={
					<Link to="/intelligence/history" className="shrink-0 text-xs text-primary-accent hover:underline">
						View history
					</Link>
				}
			/>
			{loading ? (
				<InlineLoading rows={4} />
			) : error ? (
				<InlineError message="Recent project activity is unavailable." onRetry={onRetry} />
			) : events.length === 0 ? (
				<p className="border-y border-border py-5 text-sm text-muted-foreground">
					No releases, reviews, or material changes were recorded in the last 7 days.
				</p>
			) : (
				<ol className="border-y border-border">
					{events.slice(0, 6).map((event) => <EventRow key={event.id} event={event} />)}
				</ol>
			)}
		</section>
	);
}

function ResourceRow({ resource }: { resource: ProjectResource }) {
	return (
		<li>
			<Link
				to={resourcePath(resource)}
				className="group grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_6rem_5rem] sm:items-center sm:gap-3"
			>
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-foreground group-hover:text-primary-accent">{resource.name}</p>
					<p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{resource.qualified_name}</p>
				</div>
				<p className="text-[11px] text-muted-foreground">{RESOURCE_LABELS[resource.resource_type]}</p>
				<p className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground sm:block sm:text-right">
					<span className="font-mono">{resource.version ? `v${resource.version}` : "No version"}</span>
					<span className="sm:mt-0.5 sm:block">{relativeTime(resource.updated_at)}</span>
				</p>
			</Link>
		</li>
	);
}

function ResourcesSection({
	loading,
	error,
	resources,
	onRetry,
}: {
	loading: boolean;
	error: boolean;
	resources: ProjectResource[];
	onRetry: () => void;
}) {
	return (
		<section aria-labelledby="resources-heading">
			<SectionHeader
				title="Recently updated resources"
				description="The latest Agents and Components available in this project."
				action={
					<Link to="/resources" className="shrink-0 text-xs text-primary-accent hover:underline">
						All resources
					</Link>
				}
			/>
			{loading ? (
				<InlineLoading rows={5} />
			) : error ? (
				<InlineError message="Project resources could not be loaded." onRetry={onRetry} />
			) : resources.length === 0 ? (
				<p className="border-y border-border py-5 text-sm text-muted-foreground">
					This project has no resources yet. Add an Agent or Component to establish its first resource.
				</p>
			) : (
				<ul className="border-y border-border">
					{resources.slice(0, 6).map((resource) => (
						<ResourceRow key={`${resource.resource_type}:${resource.id}`} resource={resource} />
					))}
				</ul>
			)}
		</section>
	);
}

function ActionLink({
	to,
	search,
	icon: Icon,
	title,
	description,
}: {
	to: "/agents/new" | "/resources" | "/inbox" | "/traces" | "/intelligence";
	search?: Record<string, unknown>;
	icon: LucideIcon;
	title: string;
	description: string;
}) {
	return (
		<Link
			to={to}
			search={search}
			className="group grid min-h-16 grid-cols-[1rem_minmax(0,1fr)_1rem] gap-3 border-b border-border px-3 py-3 odd:border-r last:border-b-0 sm:min-h-20 xl:min-h-0 xl:px-0 xl:odd:border-r-0"
		>
			<Icon className="mt-0.5 h-4 w-4 text-muted-foreground group-hover:text-primary-accent" />
			<span className="min-w-0">
				<span className="block text-sm font-medium text-foreground group-hover:text-primary-accent">{title}</span>
				<span className="mt-0.5 hidden text-xs leading-5 text-muted-foreground sm:block">{description}</span>
			</span>
			<ArrowRight className="mt-0.5 h-4 w-4 text-muted-foreground group-hover:text-foreground" />
		</Link>
	);
}

function NextActions({ onAddResource }: { onAddResource: () => void }) {
	return (
		<section aria-labelledby="actions-heading">
			<SectionHeader title="Next actions" description="Continue the project workflow from here." />
			<div className="grid grid-cols-2 border-y border-border xl:block">
				<button
					type="button"
					onClick={onAddResource}
					className="group grid min-h-16 w-full grid-cols-[1rem_minmax(0,1fr)_1rem] gap-3 border-b border-r border-border px-3 py-3 text-left sm:min-h-20 xl:min-h-0 xl:px-0"
				>
					<Plus className="mt-0.5 h-4 w-4 text-primary-accent" />
					<span className="min-w-0">
						<span className="block text-sm font-medium text-foreground group-hover:text-primary-accent">Add a resource</span>
						<span className="mt-0.5 hidden text-xs leading-5 text-muted-foreground sm:block">
							Create an Agent, MCP server, Skill, Hook, or Prompt.
						</span>
					</span>
					<ArrowRight className="mt-0.5 h-4 w-4 text-muted-foreground group-hover:text-foreground" />
				</button>
				<ActionLink to="/agents/new" icon={Bot} title="Open Agent Builder" description="Assemble and release a versioned Agent." />
				<ActionLink
					to="/resources"
					search={{ mine: true, wip: true }}
					icon={GitPullRequest}
					title="Your open work"
					description="Resume drafts and inspect pending or rejected changes."
				/>
				<ActionLink to="/inbox" icon={Inbox} title="Review requests" description="Open work that is waiting for your decision." />
				<ActionLink to="/traces" icon={Workflow} title="Inspect traces" description="Investigate captured execution sessions." />
				<ActionLink to="/intelligence" icon={Radar} title="Project Intelligence" description="Explore deeper usage, reliability, and cost evidence." />
			</div>
		</section>
	);
}

function ProjectSelectionState({
	title,
	description,
	action,
}: {
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<div className="mx-auto flex min-h-96 w-full max-w-2xl flex-col items-start justify-center px-5 py-12">
			<FolderKanban className="h-7 w-7 text-muted-foreground" />
			<h1 className="mt-4 font-display text-xl text-foreground">{title}</h1>
			<p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p>
			{action && <div className="mt-5">{action}</div>}
		</div>
	);
}

export default function RegistryHome() {
	const [addResourceOpen, setAddResourceOpen] = useState(false);
	const { currentOrg, isLoading: orgLoading } = useCurrentOrg();
	const { currentProject, isLoading: projectLoading, needsSelection, noProjects } = useCurrentProject();
	const orgs = useOrgs();
	const projects = useOrgProjects(currentOrg?.slug);
	const org = currentOrg?.slug;
	const project = currentProject?.slug;
	const briefing = useIntelligenceBriefing(org, project, "7d");
	const history = useIntelligenceHistory(org, project, "7d", { page: 1, pageSize: 6 });
	const resources = useProjectResources({ sort: "updated", page_size: 6 }, { enabled: !!org && !!project });

	const sessionMetric = briefing.data?.metrics.find((metric) => metric.key === "sessions")?.value ?? null;
	const attentionSignals = (briefing.data?.signals ?? []).filter((signal) => signal.severity !== "info");
	const resourceCount = resources.isError ? null : (resources.data?.total ?? null);
	const hasData = (briefing.data?.has_data ?? false) || (resourceCount ?? 0) > 0;

	if (orgLoading || projectLoading || orgs.isLoading || projects.isLoading) {
		return (
			<>
				<PageHeader title="Home" />
				<div className="mx-auto w-full max-w-350 px-4 py-8 sm:px-6 lg:px-8"><InlineLoading rows={5} /></div>
			</>
		);
	}

	if (orgs.isError) {
		return (
			<>
				<PageHeader title="Home" />
				<ProjectSelectionState
					title="Organization context is unavailable"
					description="The organizations available to your account could not be loaded. No project data is shown until that context is confirmed."
					action={<Button variant="outline" onClick={() => orgs.refetch()}>Retry</Button>}
				/>
			</>
		);
	}

	if (!currentOrg) {
		return (
			<>
				<PageHeader title="Home" />
				<ProjectSelectionState
					title="Choose an organization"
					description="Select an organization before entering a project workspace. Project data is never shown without an active organization context."
					action={<Button asChild><a href="/onboarding">Choose organization</a></Button>}
				/>
			</>
		);
	}

	if (projects.isError) {
		return (
			<>
				<PageHeader title="Home" />
				<ProjectSelectionState
					title="Project context is unavailable"
					description={`Projects in ${currentOrg.name} could not be loaded. No resource or activity data is shown until the project boundary is confirmed.`}
					action={<Button variant="outline" onClick={() => projects.refetch()}>Retry</Button>}
				/>
			</>
		);
	}

	if (needsSelection) {
		return (
			<>
				<PageHeader title="Home" />
				<ProjectSelectionState
					title="Choose a project"
					description={`Select a project in ${currentOrg.name} from the project switcher to open its workspace.`}
				/>
			</>
		);
	}

	if (noProjects || !currentProject) {
		const canManageProjects = hasPermission(currentOrg, PERMISSIONS.orgProjectsManage);
		return (
			<>
				<PageHeader title="Home" />
				<ProjectSelectionState
					title="No project available"
					description={canManageProjects
						? `${currentOrg.name} has no available projects. Create one to establish a resource and activity boundary.`
						: `${currentOrg.name} has no project available to you. Ask an organization administrator to create one or grant access.`}
					action={canManageProjects ? <Button asChild variant="outline"><a href="/organization/projects">Manage projects</a></Button> : undefined}
				/>
			</>
		);
	}

	return (
		<>
			<PageHeader title="Home" />
			<main className="mx-auto w-full max-w-350 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
				<header className="flex flex-wrap items-start justify-between gap-5 border-b border-border pb-5">
					<div className="min-w-0">
						<p className="font-mono text-[10px] uppercase text-muted-foreground">{currentOrg.name} / Project</p>
						<h1 className="mt-1 font-display text-2xl text-foreground sm:text-3xl">{currentProject.name}</h1>
						<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
							{currentProject.description || "The active workspace for this project's resources, changes, and execution evidence."}
						</p>
						<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
							<span className="font-mono">{currentOrg.slug}/{currentProject.slug}</span>
							{currentProject.role && <span className="capitalize">Project {currentProject.role}</span>}
							{currentProject.member_count != null && <span>{currentProject.member_count} members</span>}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="outline" size="sm" asChild>
							<Link to="/resources"><ListTree className="mr-1.5 h-3.5 w-3.5" />Resources</Link>
						</Button>
						<Button size="sm" onClick={() => setAddResourceOpen(true)}>
							<Plus className="mr-1.5 h-3.5 w-3.5" />Add resource
						</Button>
					</div>
				</header>

				<section className="mt-6" aria-labelledby="state-heading">
					<h2 id="state-heading" className="mb-3 text-sm font-semibold text-foreground">Current state</h2>
					<ProjectState
						loading={briefing.isLoading || resources.isLoading}
						error={briefing.isError}
						onRetry={() => {
							briefing.refetch();
							resources.refetch();
						}}
						hasData={hasData}
						sessions={sessionMetric}
						resources={resourceCount}
						attention={attentionSignals.length}
					/>
				</section>

				<div className="mt-8 grid items-start gap-9 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.75fr)]">
					<AttentionSection
							loading={briefing.isLoading}
							error={briefing.isError}
							signals={attentionSignals}
							onRetry={() => briefing.refetch()}
					/>
					<NextActions onAddResource={() => setAddResourceOpen(true)} />
					<ActivitySection
							loading={history.isLoading}
							error={history.isError}
							events={history.data?.events ?? []}
							onRetry={() => history.refetch()}
					/>
					<ResourcesSection
							loading={resources.isLoading}
							error={resources.isError}
							resources={resources.data?.items ?? []}
							onRetry={() => resources.refetch()}
					/>
				</div>
			</main>
			<AddResourceSheet open={addResourceOpen} onOpenChange={setAddResourceOpen} />
		</>
	);
}
