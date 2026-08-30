// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organization → General: overview of the org's footprint, profile
// management, the owner-only organization id (subdomain) change, and the
// owner-only danger zone with typed delete confirmation.

import { useState } from "react";
import { CalendarDays, FolderKanban, Loader2, MailPlus, Save, Trash2, Users } from "lucide-react";
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
import { CONTROL_CLASS_NAME, SectionHeading, useAdministeredOrg } from "@/pages/organization/shell";

function StatChip({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string | number | null }) {
	return (
		<div className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2.5">
			<Icon className="h-4 w-4 shrink-0 text-primary-accent" />
			<div className="min-w-0">
				<p className="truncate text-sm font-semibold leading-tight">{value ?? "–"}</p>
				<p className="text-[11px] text-muted-foreground">{label}</p>
			</div>
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
	const createdLabel = createdAt
		? new Date(createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
		: null;

	function saveProfile() {
		updateOrg.mutate({ name: effectiveName.trim(), description: effectiveDescription });
	}

	return (
		<div className="space-y-8">
			<section aria-label="Organization overview" className="grid grid-cols-2 gap-2 lg:max-w-3xl lg:grid-cols-4">
				<StatChip icon={Users} label="Members" value={detail.data?.member_count ?? org.member_count ?? null} />
				<StatChip icon={FolderKanban} label="Projects" value={detail.data?.project_count ?? org.project_count ?? null} />
				{canManageMembers && <StatChip icon={MailPlus} label="Pending invitations" value={pendingInvitations} />}
				<StatChip icon={CalendarDays} label="Created" value={createdLabel} />
			</section>

			<section aria-labelledby="org-profile" className="space-y-3">
				<SectionHeading title="Profile" description="How this organization appears across the product." />
				<div className="max-w-lg space-y-3 rounded-md border border-border bg-card p-4">
					<div>
						<Label htmlFor="org-profile-name" className="text-xs">
							Name
						</Label>
						<Input
							id="org-profile-name"
							value={effectiveName}
							onChange={(e) => setName(e.target.value)}
							className={cn("mt-1 h-8 text-sm", CONTROL_CLASS_NAME)}
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
							className={cn("mt-1 text-sm", CONTROL_CLASS_NAME)}
						/>
					</div>
					<Button size="sm" disabled={!profileDirty || !effectiveName.trim() || updateOrg.isPending} onClick={saveProfile}>
						{updateOrg.isPending ? (
							<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
						) : (
							<Save className="mr-1.5 h-3.5 w-3.5" />
						)}
						Save profile
					</Button>
				</div>
			</section>

			{canDelete && (
				<section aria-labelledby="org-id" className="space-y-3">
					<SectionHeading
						title="Organization id"
						description="The single lowercase label that addresses this organization as a subdomain. Owner only; changing it moves every URL."
					/>
					<div className="flex max-w-lg flex-wrap items-center gap-2">
						<Input
							value={effectiveOrgId}
							onChange={(e) => setOrgId(e.target.value)}
							aria-label="Organization id"
							className={cn("h-8 w-56 font-mono text-sm", CONTROL_CLASS_NAME)}
						/>
						<Button size="sm" variant="outline" disabled={!idDirty || updateOrg.isPending} onClick={() => setConfirmRename(true)}>
							Change id
						</Button>
					</div>
				</section>
			)}

			{canDelete && (
				<section aria-labelledby="org-danger" className="space-y-3">
					<SectionHeading title="Danger zone" />
					<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
						<p className="text-xs text-muted-foreground">
							Deleting the organization is permanent and requires it to contain no projects beyond the default.
						</p>
						<Button
							size="sm"
							variant="outline"
							className="shrink-0 text-destructive hover:bg-destructive/10"
							onClick={() => setConfirmDelete(true)}
						>
							<Trash2 className="mr-1.5 h-3.5 w-3.5" />
							Delete organization
						</Button>
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
