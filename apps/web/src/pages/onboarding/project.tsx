// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Onboarding stage 3: resolve the project context. Organization membership
// and project membership are distinct: this stage either lets the user pick
// among the projects they can actually enter, enters the only one
// automatically, or - when membership grants no project at all - explains
// that state plainly. No-access is a waiting state, not a rejection: the
// membership is real, and access appears here the moment it is granted.

import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, Building2, FolderKanban, Loader2, RefreshCw, ShieldQuestion } from "lucide-react";
import { enterApp, useInvalidateOnboarding, useOnboardingStage } from "@/hooks/use-onboarding";
import { accessibleProjectCount } from "@/lib/onboarding";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StageHeader, StagePending } from "@/pages/onboarding/shell";
import type { OnboardingOrg, OnboardingProject } from "@/lib/types";

const PANEL = "rounded-md border border-border";

function ProjectRow({
	org,
	project,
	onEnter,
	disabled,
}: {
	org: OnboardingOrg;
	project: OnboardingProject;
	onEnter: () => void;
	disabled: boolean;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onEnter}
				disabled={disabled}
				className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-60"
			>
				<FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-medium">{project.name}</span>
					<span className="block truncate font-mono text-[11px] text-muted-foreground">
						{org.slug}/{project.slug}
					</span>
				</span>
				{project.is_default && (
					<Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-medium">
						Default
					</Badge>
				)}
				{project.role && (
					<Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-medium capitalize">
						{project.role}
					</Badge>
				)}
				<ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
			</button>
		</li>
	);
}

export default function OnboardingProjectPage() {
	const { snapshot, ready, query } = useOnboardingStage("project");
	const search = useSearch({ strict: false }) as { next?: string };
	const navigate = useNavigate();
	const invalidate = useInvalidateOnboarding();
	const [entering, setEntering] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const totalProjects = snapshot ? accessibleProjectCount(snapshot) : 0;

	// Exactly one accessible project: entering it is the only sensible move.
	useEffect(() => {
		if (!ready || !snapshot || entering || totalProjects !== 1) return;
		const org = snapshot.organizations.find((o) => o.projects.length > 0);
		if (!org) return;
		setEntering(true);
		const destination = enterApp({ orgSlug: org.slug, projectSlug: org.projects[0].slug }, search.next);
		if (destination !== null) navigate({ to: destination });
	}, [ready, snapshot, entering, totalProjects, search.next, navigate]);

	if (!ready || !snapshot || (totalProjects === 1 && !entering)) return <StagePending />;
	if (entering) return <StagePending />;

	const orgsWithAccess = snapshot.organizations.filter((o) => o.projects.length > 0);
	const orgsWithoutAccess = snapshot.organizations.filter((o) => o.projects.length === 0);

	function enter(orgSlug: string, projectSlug: string) {
		setEntering(true);
		const destination = enterApp({ orgSlug, projectSlug }, search.next);
		if (destination !== null) navigate({ to: destination });
	}

	async function refresh() {
		setRefreshing(true);
		invalidate();
		await query.refetch();
		setRefreshing(false);
	}

	// Membership without project access: a real, explained waiting state.
	if (totalProjects === 0) {
		return (
			<div className="space-y-10">
				<StageHeader
					kicker="Step 3 · Project"
					title="Your project access is pending"
					description="You're a member of the organization below, but you don't have access to any of its projects yet. Everything in Caracal is scoped to a project, so there's nothing to show until access is granted."
				/>

				<section className="space-y-3">
					{orgsWithoutAccess.map((org) => (
						<div key={org.slug} className={`${PANEL} px-4 py-4`}>
							<div className="flex items-center gap-3">
								<Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">{org.name}</p>
									<p className="truncate font-mono text-[11px] text-muted-foreground">{org.slug}</p>
								</div>
								<Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-medium capitalize">
									{org.role}
								</Badge>
								<Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-medium">
									Member · no project access
								</Badge>
							</div>
						</div>
					))}
				</section>

				<div className={`${PANEL} flex items-start gap-3 bg-card/40 px-4 py-4`}>
					<ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="text-xs leading-5 text-muted-foreground">
						<p>
							<span className="font-medium text-foreground">What to do next:</span> ask an organization admin to add
							you to a project. Your membership is intact - this page updates the moment access is granted.
						</p>
					</div>
				</div>

				<footer className="flex items-center justify-between border-t border-border pt-6">
					<p className="text-xs text-muted-foreground">Checked automatically; refresh any time.</p>
					<Button variant="outline" className="h-9" onClick={refresh} disabled={refreshing}>
						{refreshing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
						Check again
					</Button>
				</footer>
			</div>
		);
	}

	// Several accessible projects: explicit selection.
	return (
		<div className="space-y-10">
			<StageHeader
				kicker="Step 3 · Project"
				title="Choose where to work"
				description="You have access to more than one project. Pick the one to enter - you can switch projects and organizations at any time from the top bar."
			/>

			<section className="space-y-6">
				{orgsWithAccess.map((org) => (
					<div key={org.slug}>
						<div className="flex items-center gap-2">
							<Building2 className="h-3.5 w-3.5 text-muted-foreground" />
							<h2 className="text-[13px] font-semibold uppercase tracking-wider text-foreground/80">{org.name}</h2>
							<Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium capitalize">
								{org.role}
							</Badge>
						</div>
						<ul className={`${PANEL} mt-2.5 divide-y divide-border`}>
							{org.projects.map((project) => (
								<ProjectRow
									key={project.slug}
									org={org}
									project={project}
									disabled={entering}
									onEnter={() => enter(org.slug, project.slug)}
								/>
							))}
						</ul>
					</div>
				))}
			</section>

			{orgsWithoutAccess.length > 0 && (
				<p className="text-xs leading-5 text-muted-foreground">
					You're also a member of{" "}
					{orgsWithoutAccess.map((o) => o.name).join(", ")} without project access there yet.
				</p>
			)}
		</div>
	);
}
