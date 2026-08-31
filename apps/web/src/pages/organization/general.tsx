// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organization -> General: the primary overview for the active organization.
// Detailed members, projects, audit, and security workflows remain in their
// dedicated sections; this page surfaces identity and state.

import { useState } from "react";
import {
	AlertCircle,
	Hash,
	Loader2,
	Save,
	Trash2,
} from "lucide-react";
import { ConfirmActionDialog } from "@/components/organization/confirm-action-dialog";
import { NotFoundState } from "@/components/shared/not-found-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDeleteOrg, useOrg, useOrgInvitations, useUpdateOrg } from "@/hooks/use-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { orgOrigin, supportsOrgSubdomains } from "@/lib/tenant-host";
import { cn } from "@/lib/utils";
import { CONTROL_CLASS_NAME, MemberRoleBadge, SectionHeading, useAdministeredOrg } from "@/pages/organization/shell";

function formatDate(value?: string | null) {
	if (!value) return "Not recorded";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "Not recorded"
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatCount(value?: number | null) {
	return value == null ? "-" : value.toLocaleString();
}

function activeOrgOrigin(slug: string) {
	if (typeof window === "undefined" || !supportsOrgSubdomains(window.location.hostname)) return null;
	return orgOrigin(slug);
}

function SummaryMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
	return (
		<div className="min-w-0 sm:border-l sm:border-border/80 sm:pl-4 sm:first:border-l-0 sm:first:pl-0">
			<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
			<p className="mt-1 truncate text-lg font-semibold leading-none text-foreground">{value}</p>
			{detail && <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>}
		</div>
	);
}

function DetailRow({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<div className="grid gap-1 border-t border-border/70 py-3 first:border-t-0 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
			<dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
			<dd className="min-w-0">
				<p className="truncate text-sm text-foreground">{value}</p>
				{note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
			</dd>
		</div>
	);
}

export default function OrganizationGeneralPage() {
	const org = useAdministeredOrg();
	const canUpdate = hasPermission(org, PERMISSIONS.orgUpdate);
	const canDelete = hasPermission(org, PERMISSIONS.orgDelete);
	const canManageMembers = hasPermission(org, PERMISSIONS.orgMembersManage);
	const detail = useOrg(org?.slug);
	const invitations = useOrgInvitations(canManageMembers ? org?.slug : undefined);
	const updateOrg = useUpdateOrg(org?.slug ?? "");
	const deleteOrg = useDeleteOrg();

	const [name, setName] = useState<string | null>(null);
	const [description, setDescription] = useState<string | null>(null);
	const [orgId, setOrgId] = useState<string | null>(null);
	const [confirmRename, setConfirmRename] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	if (!org || !canUpdate) return <NotFoundState />;

	const effectiveName = name ?? org.name;
	const effectiveDescription = description ?? org.description ?? "";
	const effectiveOrgId = orgId ?? org.slug;
	const profileDirty = effectiveName !== org.name || effectiveDescription !== (org.description ?? "");
	const idDirty = effectiveOrgId !== org.slug;
	const pendingInvitations = (invitations.data ?? []).filter((inv) => inv.state === "pending").length;
	const createdAt = detail.data?.created_at ?? org.created_at;
	const createdLabel = formatDate(createdAt);
	const memberCount = detail.data?.member_count ?? org.member_count ?? null;
	const projectCount = detail.data?.project_count ?? org.project_count ?? null;
	const canonicalOrigin = activeOrgOrigin(org.slug);
	const descriptionText = effectiveDescription.trim() || "No description set.";

	function saveProfile() {
		updateOrg.mutate({ name: effectiveName.trim(), description: effectiveDescription });
	}

	return (
		<div className="mx-auto w-full max-w-6xl space-y-6">
			<section aria-label="Organization summary" className="border-b border-border/70 pb-6">
				<div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
					<div className="min-w-0">
						<div className="mb-3 flex flex-wrap items-center gap-2">
							<span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-sm font-semibold text-foreground">
								{org.name.slice(0, 2).toUpperCase()}
							</span>
							<MemberRoleBadge role={org.role ?? "member"} />
							{detail.isFetching && (
								<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
									<Loader2 className="h-3 w-3 animate-spin" /> Refreshing
								</span>
							)}
						</div>
						<h2 className="text-2xl font-semibold leading-tight tracking-tight text-foreground sm:text-3xl">{org.name}</h2>
						<p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{descriptionText}</p>
					</div>
				</div>

				<div className="mt-6 grid grid-cols-2 gap-y-4 sm:grid-cols-4">
					<SummaryMetric label="Members" value={formatCount(memberCount)} detail="Organization roster" />
					<SummaryMetric label="Projects" value={formatCount(projectCount)} detail="Workspaces" />
					{canManageMembers ? (
						<SummaryMetric
							label="Invitations"
							value={invitations.isLoading ? "-" : formatCount(pendingInvitations)}
							detail={invitations.isError ? "Could not load" : "Pending invites"}
						/>
					) : (
						<SummaryMetric label="Access" value={org.role ?? "member"} detail="Your organization role" />
					)}
					<SummaryMetric label="Created" value={createdLabel} detail="Organization lifetime" />
				</div>

				{detail.isError && (
					<div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
						<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span>Some organization details could not be refreshed. Cached membership data is shown.</span>
					</div>
				)}
			</section>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<section aria-label="Organization profile" className="space-y-4">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<SectionHeading title="Organization profile" description="The name and description members see across Caracal." />
						<Button
							size="sm"
							disabled={!profileDirty || !effectiveName.trim() || updateOrg.isPending}
							onClick={saveProfile}
						>
							{updateOrg.isPending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Save className="h-3.5 w-3.5" />
							)}
							Save profile
						</Button>
					</div>
					<div className="grid gap-4 rounded-md border border-border bg-card/50 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
						<div>
							<Label htmlFor="org-profile-name" className="text-xs">
								Name
							</Label>
							<Input
								id="org-profile-name"
								value={effectiveName}
								onChange={(e) => setName(e.target.value)}
								className={cn("mt-1 h-9 text-sm", CONTROL_CLASS_NAME)}
							/>
						</div>
						<div>
							<Label htmlFor="org-profile-description" className="text-xs">
								Description
							</Label>
							<Textarea
								id="org-profile-description"
								value={effectiveDescription}
								onChange={(e) => setDescription(e.target.value)}
								rows={3}
								className={cn("mt-1 min-h-22 text-sm", CONTROL_CLASS_NAME)}
							/>
						</div>
					</div>
				</section>

				<section aria-label="Organization details" className="space-y-4">
					<SectionHeading title="Details" description="Stable identifiers and organization state." />
					<dl className="rounded-md border border-border bg-card/50 px-4">
						<DetailRow label="Org id" value={org.slug} note="Used in scoped API calls and URLs." />
						<DetailRow label="Role" value={org.role ?? "member"} note="Your administrative level here." />
						<DetailRow label="Created" value={createdLabel} />
						<DetailRow label="Origin" value={canonicalOrigin ?? "Current host"} note="Organization administration is project-free." />
					</dl>
				</section>
			</div>

			{canDelete && (
				<section aria-label="Owner controls" className="space-y-4">
					<SectionHeading
						title="Owner controls"
						description="Changes here affect the organization boundary, URLs, and lifecycle."
					/>
					<div className="divide-y divide-border/70 rounded-md border border-border bg-card/50">
						<div className="grid gap-4 p-4 lg:grid-cols-[1.5rem_minmax(0,1fr)_auto] lg:items-center">
							<Hash className="hidden h-4 w-4 text-muted-foreground lg:block" />
							<div className="min-w-0 space-y-2">
								<Label htmlFor="org-id-input" className="text-xs">
									Organization id
								</Label>
								<Input
									id="org-id-input"
									value={effectiveOrgId}
									onChange={(e) => setOrgId(e.target.value)}
									aria-label="Organization id"
									className={cn("h-9 max-w-sm font-mono text-sm", CONTROL_CLASS_NAME)}
								/>
								<p className="text-xs text-muted-foreground">
									Changing the id moves the organization to a new address and invalidates saved URLs.
								</p>
							</div>
							<Button size="sm" variant="outline" disabled={!idDirty || updateOrg.isPending} onClick={() => setConfirmRename(true)}>
								Change id
							</Button>
						</div>
						<div className="grid gap-4 p-4 lg:grid-cols-[1.5rem_minmax(0,1fr)_auto] lg:items-center">
							<Trash2 className="hidden h-4 w-4 text-destructive lg:block" />
							<div className="min-w-0">
								<p className="text-sm font-medium text-foreground">Delete organization</p>
								<p className="mt-0.5 text-xs text-muted-foreground">
									Permanent removal is allowed only after non-default projects have been removed.
								</p>
							</div>
							<Button
								size="sm"
								variant="outline"
								className="shrink-0 text-destructive hover:bg-destructive/10"
								onClick={() => setConfirmDelete(true)}
							>
								<Trash2 className="h-3.5 w-3.5" />
								Delete
							</Button>
						</div>
					</div>
				</section>
			)}

			<ConfirmActionDialog
				open={confirmRename}
				onOpenChange={setConfirmRename}
				title="Change organization id"
				description={
					<>
						Change the organization id from <span className="font-mono font-medium text-foreground">{org.slug}</span>{" "}
						to <span className="font-mono font-medium text-foreground">{effectiveOrgId.trim().toLowerCase()}</span>?
					</>
				}
				impact={[
					"The organization moves to a new subdomain; every existing URL changes.",
					"Members' bookmarks and CLI contexts must be updated to the new id.",
					"The rename is recorded in the organization security events.",
				]}
				confirmLabel="Change id"
				pending={updateOrg.isPending}
				onConfirm={() => {
					updateOrg.mutate(
						{ slug: effectiveOrgId.trim().toLowerCase() },
						{
							onSuccess: (updated) => {
								setConfirmRename(false);
								// The org id is the host: follow the organization to its new origin.
								if (supportsOrgSubdomains(window.location.hostname)) {
									window.location.assign(`${orgOrigin(updated.slug)}/organization`);
								}
							},
							onError: () => setConfirmRename(false),
						},
					);
				}}
			/>

			<ConfirmActionDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete organization"
				description={
					<>
						Permanently delete <span className="font-mono font-medium text-foreground">{org.slug}</span>? This cannot
						be undone.
					</>
				}
				impact={[
					`All ${detail.data?.member_count ?? org.member_count ?? "…"} memberships end immediately.`,
					"The organization id becomes available to others.",
					"The deletion is recorded in the platform security events.",
				]}
				confirmationText={org.slug}
				confirmLabel="Delete organization"
				pending={deleteOrg.isPending}
				onConfirm={() => deleteOrg.mutate(org.slug, { onSettled: () => setConfirmDelete(false) })}
			/>
		</div>
	);
}
