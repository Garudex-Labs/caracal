// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Personal interface preferences plus project-scoped resource preferences.

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, Loader2, Save } from "lucide-react";
import { ConfirmActionDialog } from "@/components/organization/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/lib/theme";
import { SettingsPage, SettingsSection } from "@/components/settings/settings-shell";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import { useResourceRetentionPolicy, useUpdateResourceRetentionPolicy } from "@/hooks/use-api";
import type { ResourceRetentionPolicy } from "@/lib/types";

// Dark is the product default; light remains available for bright environments.
const THEMES = [
	{
		value: "dark",
		label: "Dark",
		description: "Pure-black default",
		swatches: [
			"var(--theme-preview-dark-shell)",
			"var(--theme-preview-dark-canvas)",
			"var(--theme-preview-dark-accent)",
		],
	},
	{
		value: "light",
		label: "Light",
		description: "For bright environments",
		swatches: [
			"var(--theme-preview-light-shell)",
			"var(--theme-preview-light-canvas)",
			"var(--theme-preview-light-accent)",
		],
	},
] as const;

const FALLBACK_BOUNDS = {
	private: { min_days: 0, max_days: 90 },
	project: { min_days: 7, max_days: 180 },
};

function dateLabel(value: string): string {
	return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ResourceRetentionSection() {
	const { currentOrg } = useCurrentOrg();
	const { currentProject, preferredProject, isLoading } = useCurrentProject();
	const project = currentProject ?? preferredProject;
	const orgSlug = currentOrg?.slug ?? "";
	const projectSlug = project?.slug ?? "";
	const policy = useResourceRetentionPolicy(orgSlug, projectSlug);
	const preview = useUpdateResourceRetentionPolicy(orgSlug, projectSlug, true);
	const apply = useUpdateResourceRetentionPolicy(orgSlug, projectSlug);
	const [privateDays, setPrivateDays] = useState("30");
	const [projectDays, setProjectDays] = useState("30");
	const [conflictPreview, setConflictPreview] = useState<ResourceRetentionPolicy | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);

	useEffect(() => {
		if (!policy.data) return;
		setPrivateDays(String(policy.data.private_retention_days));
		setProjectDays(String(policy.data.project_retention_days));
		setConflictPreview(null);
	}, [policy.data]);

	if (isLoading || policy.isLoading) {
		return <p className="text-sm text-muted-foreground">Loading project retention policy…</p>;
	}
	if (!currentOrg || !project) {
		return <p className="text-sm text-muted-foreground">Select an organization and project to manage resource deletion retention.</p>;
	}
	if (policy.isError) {
		return <p className="text-sm text-destructive">Failed to load resource retention policy.</p>;
	}

	const bounds = policy.data?.bounds ?? FALLBACK_BOUNDS;
	const canUpdate = policy.data?.can_update ?? false;
	const privateValue = Number(privateDays);
	const projectValue = Number(projectDays);
	const invalid = !Number.isInteger(privateValue) || !Number.isInteger(projectValue) ||
		privateValue < bounds.private.min_days || privateValue > bounds.private.max_days ||
		projectValue < bounds.project.min_days || projectValue > bounds.project.max_days;
	const busy = preview.isPending || apply.isPending;
	const payload = { private_retention_days: privateValue, project_retention_days: projectValue };

	async function savePolicy() {
		setConflictPreview(null);
		try {
			const result = await preview.mutateAsync(payload);
			if (result.conflicts?.length) {
				setConflictPreview(result);
				return;
			}
			await apply.mutateAsync(payload);
		} catch {
			// Toasts are emitted by the mutation hook.
		}
	}

	async function confirmPolicy() {
		const conflicts = conflictPreview?.conflicts ?? [];
		try {
			await apply.mutateAsync({ ...payload, confirm: true, confirmed_conflict_ids: conflicts.map((item) => item.id) });
			setConflictPreview(null);
			setConfirmOpen(false);
		} catch {
			// Toasts are emitted by the mutation hook.
		}
	}

	return (
		<div className="max-w-2xl space-y-4">
			<div className="rounded-md border border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
				<span className="font-medium text-foreground">{currentOrg.name} / {project.name}</span> keeps private deleted agents for {privateDays || "0"} days and project deleted agents for {projectDays || "0"} days before automatic permanent deletion.
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="private-retention-days">Private resources</Label>
					<Input
						id="private-retention-days"
						type="number"
						min={bounds.private.min_days}
						max={bounds.private.max_days}
						value={privateDays}
						disabled={!canUpdate || busy}
						onChange={(event) => setPrivateDays(event.target.value)}
					/>
					<p className="text-xs text-muted-foreground">{bounds.private.min_days} to {bounds.private.max_days} days. A value of 0 makes private deleted agents eligible for cleanup immediately.</p>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="project-retention-days">Project resources</Label>
					<Input
						id="project-retention-days"
						type="number"
						min={bounds.project.min_days}
						max={bounds.project.max_days}
						value={projectDays}
						disabled={!canUpdate || busy}
						onChange={(event) => setProjectDays(event.target.value)}
					/>
					<p className="text-xs text-muted-foreground">{bounds.project.min_days} to {bounds.project.max_days} days. Project resources cannot bypass the minimum recovery floor.</p>
				</div>
			</div>
			{!canUpdate && (
				<p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">Only project leads and organization admins can change this policy.</p>
			)}
			{conflictPreview?.conflicts?.length ? (
				<div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
					<div className="flex gap-2 text-sm font-medium text-foreground">
						<AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
						<span>{conflictPreview.conflicts.length} deleted agent{conflictPreview.conflicts.length === 1 ? "" : "s"} will become eligible sooner.</span>
					</div>
					<div className="space-y-1.5">
						{conflictPreview.conflicts.map((item) => (
							<div key={item.id} className="rounded border border-border bg-background/80 px-2 py-1.5 text-xs">
								<div className="font-medium text-foreground">{item.qualified_name}</div>
								<div className="text-muted-foreground">
									Deleted {dateLabel(item.deleted_at)} · current purge {item.scheduled_purge_at ? dateLabel(item.scheduled_purge_at) : "not scheduled"} · new purge {dateLabel(item.proposed_scheduled_purge_at)}{item.eligible_at_apply ? " (eligible immediately)" : ""}
								</div>
							</div>
						))}
					</div>
					<Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirmOpen(true)}>
						{apply.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
						Apply retention reduction
					</Button>
				</div>
			) : null}
			<Button size="sm" disabled={!canUpdate || busy || invalid} onClick={() => void savePolicy()}>
				{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
				Save policy
			</Button>
			<ConfirmActionDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Apply retention reduction?"
				description="The affected deleted agents will use the shorter recovery window. Agents already outside that window become eligible for automatic permanent deletion."
				impact={(conflictPreview?.conflicts ?? []).slice(0, 5).map((item) => `${item.qualified_name}: new purge ${dateLabel(item.proposed_scheduled_purge_at)}${item.eligible_at_apply ? " (eligible immediately)" : ""}`)}
				confirmationText="apply retention"
				confirmLabel="Apply policy"
				pending={apply.isPending}
				onConfirm={() => void confirmPolicy()}
			/>
		</div>
	);
}

export default function PreferencesSettingsPage() {
	const { theme, setTheme } = useTheme();

	return (
		<SettingsPage
			title="Preferences"
			description="Interface behavior for your account on this browser."
			scope="account"
		>
			<SettingsSection
				id="theme"
				title="Theme"
				description="Also switchable from the sun/moon toggle in the top bar."
			>
				<div className="grid max-w-md grid-cols-2 gap-2" role="radiogroup" aria-label="Theme">
					{THEMES.map((t) => {
						const isActive = theme === t.value;
						return (
							<button
								key={t.value}
								type="button"
								role="radio"
								aria-checked={isActive}
								onClick={() => setTheme(t.value)}
								className={
									"rounded-md border p-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" +
									(isActive ? " border-primary-accent bg-accent/20" : " border-border bg-card")
								}
							>
								<div className="mb-2.5 flex h-8 flex-col gap-px overflow-hidden rounded">
									{t.swatches.map((color, i) => (
										<div key={i} className="flex-1" style={{ backgroundColor: color }} />
									))}
								</div>
								<div className="flex items-center justify-between">
									<div>
										<span className="text-xs font-medium">{t.label}</span>
										<p className="text-[11px] text-muted-foreground">{t.description}</p>
									</div>
									{isActive && <Check className="h-3 w-3 text-primary-accent" />}
								</div>
							</button>
						);
					})}
				</div>
			</SettingsSection>
			<SettingsSection
				id="resource-retention"
				title="Resource Deletion"
				description="Recovery windows for deleted agents in the active project."
			>
				<ResourceRetentionSection />
			</SettingsSection>
		</SettingsPage>
	);
}
