// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organization -> Members: the authoritative access-management workspace for
// organization roles, project memberships, effective project permissions, and
// email-bound invitations. Mutations stay server-authorized; this page only
// renders server-computed access and sends explicit role/member changes.

import { useMemo, useState } from "react";
import { ArrowUpDown, Copy, Crown, FolderKanban, KeyRound, Loader2, MailPlus, Search, ShieldCheck, Trash2, UserX, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmActionDialog } from "@/components/organization/confirm-action-dialog";
import { ListPaginationFooter, useDebouncedValue } from "@/components/organization/list-controls";
import { ErrorState } from "@/components/shared/error-state";
import { NotFoundState } from "@/components/shared/not-found-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PickerSelect } from "@/components/ui/picker-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
	useCreateOrgInvitation,
	useMemberProjects,
	useOrgInvitations,
	useOrgMembers,
	useOrgProjects,
	useRemoveOrgMember,
	useRemoveProjectMember,
	useRevokeOrgInvitation,
	useTransferOwnership,
	useUpsertOrgMember,
	useUpsertProjectMember,
} from "@/hooks/use-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { MemberProject, Organization, OrgInvitation, OrgInvitationState, OrgListParams, OrgMember, OrgRole, Permission, Project, ProjectRole } from "@/lib/types";
import {
	AddMemberRow,
	CONTROL_CLASS_NAME,
	MemberRoleBadge,
	SectionHeading,
	memberBody,
	useAdministeredOrg,
} from "@/pages/organization/shell";

const PAGE_SIZE = 25;
const PROJECT_FILTER_PAGE_SIZE = 200;

const SORTS: { value: string; label: string; sort: string; dir: "asc" | "desc" }[] = [
	{ value: "email-asc", label: "Email A-Z", sort: "email", dir: "asc" },
	{ value: "email-desc", label: "Email Z-A", sort: "email", dir: "desc" },
	{ value: "name-asc", label: "Name A-Z", sort: "name", dir: "asc" },
	{ value: "joined-desc", label: "Newest members", sort: "joined", dir: "desc" },
	{ value: "joined-asc", label: "Oldest members", sort: "joined", dir: "asc" },
	{ value: "role-asc", label: "Organization role", sort: "role", dir: "asc" },
];

const ORG_ROLE_OPTIONS = [
	{ value: "admin", label: "Admin" },
	{ value: "member", label: "Member" },
];

const PROJECT_ROLE_OPTIONS = [
	{ value: "lead", label: "Project Lead" },
	{ value: "user", label: "Project Member" },
];

const PERMISSION_LABELS: Partial<Record<Permission, string>> = {
	"org.update": "Org profile",
	"org.delete": "Delete org",
	"org.ownership.transfer": "Transfer owner",
	"org.members.manage": "Manage members",
	"org.projects.manage": "Manage projects",
	"org.audit.read": "Org audit",
	"org.security.read": "Security events",
	"project.update": "Edit project",
	"project.delete": "Delete project",
	"project.members.manage": "Manage project members",
	"project.resources.read": "Read resources",
	"project.resources.write": "Write resources",
	"project.audit.read": "Project audit",
	"project.security.read": "Project security",
};

function memberLabel(member: OrgMember) {
	return member.username ? `@${member.username}` : (member.name ?? member.email);
}

function formatDate(value?: string | null) {
	if (!value) return "-";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "-"
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function roleLabel(role?: string | null) {
	switch (role) {
		case "owner":
			return "Owner";
		case "admin":
			return "Admin";
		case "member":
			return "Member";
		case "lead":
			return "Project Lead";
		case "user":
			return "Project Member";
		case null:
		case undefined:
		case "":
			return "None";
		default:
			return role.replace(/[_-]+/g, " ");
	}
}

function orgPermissionsFor(role: OrgRole): Permission[] {
	switch (role) {
		case "owner":
			return ["org.update", "org.delete", "org.ownership.transfer", "org.members.manage", "org.projects.manage", "org.audit.read", "org.security.read"];
		case "admin":
			return ["org.update", "org.members.manage", "org.projects.manage", "org.audit.read", "org.security.read"];
		case "member":
			return ["org.view"];
	}
}

function accessSummary(member: OrgMember) {
	if (member.role === "owner" || member.role === "admin") return "All projects, lead-level";
	const count = member.project_count ?? 0;
	return `${count} project${count === 1 ? "" : "s"}`;
}

function PermissionChips({ permissions, compact = false }: { permissions?: readonly Permission[]; compact?: boolean }) {
	const visible = (permissions ?? []).filter((permission) => permission !== "project.view" && permission !== "org.view");
	if (visible.length === 0) return <span className="text-xs text-muted-foreground">No effective permissions</span>;
	const limit = compact ? 3 : 8;
	return (
		<div className="flex flex-wrap gap-1">
			{visible.slice(0, limit).map((permission) => (
				<Badge key={permission} variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
					{PERMISSION_LABELS[permission] ?? permission}
				</Badge>
			))}
			{visible.length > limit && (
				<Badge variant="outline" className="px-1.5 py-0 text-[10px]">
					+{visible.length - limit}
				</Badge>
			)}
		</div>
	);
}

function WorkspaceStat({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof ShieldCheck }) {
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
			<Icon className="h-4 w-4 shrink-0 text-primary-accent" />
			<div className="min-w-0">
				<p className="truncate text-sm font-semibold leading-tight">{value}</p>
				<p className="text-[11px] text-muted-foreground">{label}</p>
			</div>
		</div>
	);
}

function ProjectAccessRow({ org, member, project, onRemove }: { org: Organization; member: OrgMember; project: MemberProject; onRemove: (project: MemberProject) => void }) {
	const upsert = useUpsertProjectMember(org.slug, project.slug);
	const inherited = project.access_source === "organization";
	const editable = !inherited && !!project.assigned_role;
	return (
		<li className="grid gap-2 border-b border-border/70 px-3 py-2 last:border-b-0 lg:grid-cols-[minmax(0,1.25fr)_9rem_minmax(0,1.4fr)_4rem] lg:items-center">
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm font-medium">{project.name}</span>
					{project.is_default && (
						<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
							default
						</Badge>
					)}
				</div>
				<p className="truncate font-mono text-[11px] text-muted-foreground">{org.slug}/{project.slug}</p>
			</div>
			<div className="flex items-center gap-1.5">
				{editable ? (
					<PickerSelect
						value={project.assigned_role ?? project.role}
						onValueChange={(role) => upsert.mutate({ user_id: member.id, role: role as ProjectRole } as never)}
						options={PROJECT_ROLE_OPTIONS}
						className="w-32"
						inputClassName="h-8 text-xs"
						ariaLabel={`Project role for ${member.email} in ${project.name}`}
					/>
				) : (
					<MemberRoleBadge role={project.role} />
				)}
				{inherited && <span className="text-[11px] text-muted-foreground">inherited</span>}
			</div>
			<PermissionChips permissions={project.permissions} compact />
			<div className="flex justify-end">
				{editable && (
					<Button
						size="icon"
						variant="ghost"
						className="h-7 w-7 text-muted-foreground hover:text-destructive"
						aria-label={`Remove ${member.email} from ${project.name}`}
						onClick={() => onRemove(project)}
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				)}
			</div>
		</li>
	);
}

function MemberAccessPanel({ org, member, projects }: { org: Organization; member: OrgMember; projects: Project[] }) {
	const access = useMemberProjects(org.slug, member.id);
	const [projectSlug, setProjectSlug] = useState("");
	const [projectRole, setProjectRole] = useState<ProjectRole>("user");
	const [removeProject, setRemoveProject] = useState<MemberProject | null>(null);
	const accessRows = access.data ?? [];
	const inheritedOrgAdmin = member.role === "owner" || member.role === "admin";
	const assignedSlugs = new Set(accessRows.filter((project) => project.assigned_role).map((project) => project.slug));
	const availableProjects = projects.filter((project) => !assignedSlugs.has(project.slug));
	const effectiveProjectSlug = projectSlug || availableProjects[0]?.slug || "";
	const upsertProject = useUpsertProjectMember(org.slug, effectiveProjectSlug);
	const removeProjectMember = useRemoveProjectMember(org.slug, removeProject?.slug ?? "");

	return (
		<aside className="rounded-md border border-border bg-card">
			<div className="border-b border-border px-4 py-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<p className="truncate text-sm font-semibold">{memberLabel(member)}</p>
						<p className="truncate text-xs text-muted-foreground">{member.email}</p>
					</div>
					<MemberRoleBadge role={member.role} />
				</div>
				<div className="mt-3 grid grid-cols-2 gap-2 text-xs">
					<div className="rounded-md border border-border/80 px-2.5 py-2">
						<p className="text-muted-foreground">Organization role</p>
						<p className="mt-0.5 font-medium">{roleLabel(member.role)}</p>
					</div>
					<div className="rounded-md border border-border/80 px-2.5 py-2">
						<p className="text-muted-foreground">Project access</p>
						<p className="mt-0.5 font-medium">{accessSummary(member)}</p>
					</div>
				</div>
			</div>

			<div className="space-y-4 px-4 py-4">
				<section className="space-y-2">
					<SectionHeading title="Organization permissions" />
					<PermissionChips permissions={orgPermissionsFor(member.role)} />
				</section>

				<section className="space-y-2">
					<div className="flex items-end justify-between gap-3">
						<SectionHeading
							title="Project access"
							description={inheritedOrgAdmin ? "Inherited project lead authority across the organization." : "Explicit project memberships for this member."}
						/>
						{!inheritedOrgAdmin && availableProjects.length > 0 && (
							<div className="flex items-center gap-2">
								<PickerSelect
									value={effectiveProjectSlug}
									onValueChange={setProjectSlug}
									options={availableProjects.map((project) => ({ value: project.slug, label: project.name }))}
									className="w-36"
									inputClassName="h-8 text-xs"
									ariaLabel="Project to grant"
								/>
								<PickerSelect
									value={projectRole}
									onValueChange={(value) => setProjectRole(value as ProjectRole)}
									options={PROJECT_ROLE_OPTIONS}
									className="w-32"
									inputClassName="h-8 text-xs"
									ariaLabel="Project role to grant"
								/>
								<Button
									size="sm"
									variant="outline"
									className="h-8"
									disabled={!effectiveProjectSlug || upsertProject.isPending}
									onClick={() => upsertProject.mutate({ user_id: member.id, role: projectRole } as never)}
								>
									{upsertProject.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
									Grant
								</Button>
							</div>
						)}
					</div>
					{access.isLoading ? (
						<TableSkeleton rows={3} />
					) : access.isError ? (
						<ErrorState message="Failed to load project access" onRetry={() => access.refetch()} />
					) : accessRows.length === 0 ? (
						<p className="rounded-md border border-border px-3 py-3 text-xs text-muted-foreground">No project access.</p>
					) : (
						<ul className="overflow-hidden rounded-md border border-border">
							{accessRows.map((project) => (
								<ProjectAccessRow key={project.id} org={org} member={member} project={project} onRemove={setRemoveProject} />
							))}
						</ul>
					)}
				</section>
			</div>

			<ConfirmActionDialog
				open={!!removeProject}
				onOpenChange={(open) => {
					if (!open) setRemoveProject(null);
				}}
				title="Remove project access"
				description={
					<>
						Remove <span className="font-medium text-foreground">{member.email}</span> from <span className="font-mono">{org.slug}/{removeProject?.slug}</span>?
					</>
				}
				impact={["The organization membership remains active.", "Access to this project's resources ends immediately."]}
				confirmLabel="Remove project access"
				pending={removeProjectMember.isPending}
				onConfirm={() => {
					if (!removeProject) return;
					removeProjectMember.mutate(member.id, { onSettled: () => setRemoveProject(null) });
				}}
			/>
		</aside>
	);
}

export default function OrganizationMembersPage() {
	const org = useAdministeredOrg();
	const canManageMembers = hasPermission(org, PERMISSIONS.orgMembersManage);
	const canTransferOwnership = hasPermission(org, PERMISSIONS.orgOwnershipTransfer);

	const [search, setSearch] = useState("");
	const [roleFilter, setRoleFilter] = useState("");
	const [projectFilter, setProjectFilter] = useState("");
	const [projectRoleFilter, setProjectRoleFilter] = useState("");
	const [sortValue, setSortValue] = useState(SORTS[0].value);
	const [page, setPage] = useState(1);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);
	const [transferTarget, setTransferTarget] = useState<OrgMember | null>(null);
	const [roleChange, setRoleChange] = useState<{ member: OrgMember; role: "admin" | "member" } | null>(null);

	const debouncedSearch = useDebouncedValue(search.trim());
	const sort = SORTS.find((candidate) => candidate.value === sortValue) ?? SORTS[0];
	const params: OrgListParams = {
		...(debouncedSearch ? { q: debouncedSearch } : {}),
		...(roleFilter ? { role: roleFilter as OrgRole } : {}),
		...(projectFilter ? { project: projectFilter } : {}),
		...(projectRoleFilter ? { project_role: projectRoleFilter as ProjectRole } : {}),
		sort: sort.sort,
		dir: sort.dir,
		page,
		page_size: PAGE_SIZE,
	};

	const members = useOrgMembers(canManageMembers ? org?.slug : undefined, params);
	const projects = useOrgProjects(canManageMembers ? org?.slug : undefined, {
		sort: "name",
		dir: "asc",
		page: 1,
		page_size: PROJECT_FILTER_PAGE_SIZE,
	});
	const pendingInvitations = useOrgInvitations(canManageMembers ? org?.slug : undefined, { state: "pending" });
	const upsert = useUpsertOrgMember(org?.slug ?? "");
	const remove = useRemoveOrgMember(org?.slug ?? "");
	const transfer = useTransferOwnership(org?.slug ?? "");

	const rows = members.data?.members ?? [];
	const total = members.data?.total ?? 0;
	const projectRows = projects.data?.projects ?? [];
	const selectedMember = useMemo(() => rows.find((member) => member.id === selectedId) ?? rows[0] ?? null, [rows, selectedId]);
	const activeFilterCount = [debouncedSearch, roleFilter, projectFilter, projectRoleFilter].filter(Boolean).length;

	if (!org || !canManageMembers) return <NotFoundState />;

	function resetToFirstPage() {
		setPage(1);
		setSelectedId(null);
	}

	function clearFilters() {
		setSearch("");
		setRoleFilter("");
		setProjectFilter("");
		setProjectRoleFilter("");
		resetToFirstPage();
	}

	return (
		<div className="space-y-5">
			<section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
				<WorkspaceStat icon={ShieldCheck} label="Organization role" value={roleLabel(org.role)} />
				<WorkspaceStat icon={KeyRound} label="Matching members" value={total} />
				<WorkspaceStat icon={FolderKanban} label="Projects" value={projects.data?.total ?? org.project_count ?? "-"} />
				<WorkspaceStat icon={MailPlus} label="Pending invitations" value={pendingInvitations.data?.length ?? "-"} />
			</section>

			<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-3">
				<div className="min-w-0">
					<h1 className="text-sm font-semibold">Organization access</h1>
					<p className="text-xs text-muted-foreground">Members, organization roles, effective project authority, and join links.</p>
				</div>
				<AddMemberRow roles={ORG_ROLE_OPTIONS} label="Add member" pending={upsert.isPending} onAdd={(identity, role) => upsert.mutate(memberBody(identity, role) as never)} />
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							resetToFirstPage();
						}}
						placeholder="Search members"
						aria-label="Search members"
						className={cn("h-8 w-56 pl-8 text-sm", CONTROL_CLASS_NAME)}
					/>
				</div>
				<PickerSelect value={roleFilter} onValueChange={(value) => { setRoleFilter(value); resetToFirstPage(); }} options={[{ value: "", label: "All org roles" }, { value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "member", label: "Member" }]} className="w-36" inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)} ariaLabel="Filter by organization role" />
				<PickerSelect value={projectFilter} onValueChange={(value) => { setProjectFilter(value); resetToFirstPage(); }} options={[{ value: "", label: "All projects" }, ...projectRows.map((project) => ({ value: project.slug, label: project.name }))]} className="w-40" inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)} ariaLabel="Filter by project" />
				<PickerSelect value={projectRoleFilter} onValueChange={(value) => { setProjectRoleFilter(value); resetToFirstPage(); }} options={[{ value: "", label: "All project roles" }, ...PROJECT_ROLE_OPTIONS]} className="w-40" inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)} ariaLabel="Filter by project role" />
				<PickerSelect value={sortValue} onValueChange={(value) => { setSortValue(value); resetToFirstPage(); }} options={SORTS.map(({ value, label }) => ({ value, label }))} className="w-44" inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)} ariaLabel="Sort members" />
				{activeFilterCount > 0 && (
					<Button size="sm" variant="ghost" className="h-8" onClick={clearFilters}>
						<X className="mr-1.5 h-3.5 w-3.5" />
						Clear
					</Button>
				)}
			</div>

			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_28rem]">
				<div className="min-w-0 space-y-3">
					{members.isLoading ? (
						<TableSkeleton rows={6} />
					) : members.isError ? (
						<ErrorState message="Failed to load members" onRetry={() => members.refetch()} />
					) : (
						<>
							<div className={cn("overflow-x-auto rounded-md border border-border", members.isFetching && "opacity-70")}>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Member</TableHead>
											<TableHead className="w-32">Org role</TableHead>
											<TableHead className="w-44">Project access</TableHead>
											<TableHead className="w-24">Status</TableHead>
											<TableHead className="w-32"><span className="inline-flex items-center gap-1"><ArrowUpDown className="h-3 w-3" /> Joined</span></TableHead>
											<TableHead className="w-24" />
										</TableRow>
									</TableHeader>
									<TableBody>
										{rows.map((member) => (
											<TableRow key={member.id} className={cn("cursor-pointer", selectedMember?.id === member.id && "bg-accent/30")} onClick={() => setSelectedId(member.id)}>
												<TableCell>
													<div className="min-w-0">
														<p className="truncate text-sm font-medium">{memberLabel(member)}</p>
														<p className="truncate text-xs text-muted-foreground">{member.email}</p>
													</div>
												</TableCell>
												<TableCell onClick={(event) => event.stopPropagation()}>
													{member.role === "owner" ? (
														<MemberRoleBadge role="owner" />
													) : (
														<PickerSelect value={member.role} onValueChange={(role) => { if (role !== member.role) setRoleChange({ member, role: role as "admin" | "member" }); }} options={ORG_ROLE_OPTIONS} className="w-28" inputClassName="h-8 text-xs" ariaLabel={`Organization role for ${member.email}`} />
													)}
												</TableCell>
												<TableCell className="text-xs text-muted-foreground">{accessSummary(member)}</TableCell>
												<TableCell><Badge variant="secondary" className="px-1.5 py-0 text-[10px]">active</Badge></TableCell>
												<TableCell className="text-xs text-muted-foreground">{formatDate(member.created_at)}</TableCell>
												<TableCell onClick={(event) => event.stopPropagation()}>
													<div className="flex items-center justify-end gap-1">
														{canTransferOwnership && member.role !== "owner" && (
															<Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-primary-accent" aria-label={`Transfer ownership to ${member.email}`} onClick={() => setTransferTarget(member)}><Crown className="h-3.5 w-3.5" /></Button>
														)}
														{member.role !== "owner" && (
															<Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Remove ${member.email}`} onClick={() => setRemoveTarget(member)}><Trash2 className="h-3.5 w-3.5" /></Button>
														)}
													</div>
												</TableCell>
											</TableRow>
										))}
										{rows.length === 0 && (
											<TableRow><TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">No members match.</TableCell></TableRow>
										)}
									</TableBody>
								</Table>
							</div>
							<ListPaginationFooter page={page} pageSize={PAGE_SIZE} total={total} label={total === 1 ? "member" : "members"} onPageChange={(next) => { setPage(next); setSelectedId(null); }} />
						</>
					)}
				</div>

				{selectedMember ? (
					<MemberAccessPanel org={org} member={selectedMember} projects={projectRows} />
				) : (
					<div className="rounded-md border border-border bg-card px-4 py-8 text-center text-xs text-muted-foreground">Select a member to inspect access.</div>
				)}
			</div>

			<ConfirmActionDialog
				open={!!roleChange}
				onOpenChange={(open) => { if (!open) setRoleChange(null); }}
				title="Change organization role"
				description={<>{"Set "}<span className="font-medium text-foreground">{roleChange?.member.email}</span>{" to "}<span className="font-medium text-foreground">{roleLabel(roleChange?.role)}</span>?</>}
				impact={["Organization role changes take effect immediately.", roleChange?.role === "admin" ? "Admins inherit project lead-level authority across all projects." : "Members keep only explicit project memberships.", "Owner changes must use ownership transfer."]}
				confirmLabel="Change role"
				pending={upsert.isPending}
				onConfirm={() => {
					if (!roleChange) return;
					upsert.mutate({ user_id: roleChange.member.id, role: roleChange.role } as never, { onSettled: () => setRoleChange(null) });
				}}
			/>

			<ConfirmActionDialog
				open={!!removeTarget}
				onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
				title="Remove member"
				description={<>{"Remove "}<span className="font-medium text-foreground">{removeTarget?.email}</span>{" from "}<span className="font-mono">{org.slug}</span>?</>}
				impact={["Their organization membership ends immediately.", `${removeTarget?.project_count ?? 0} explicit project membership${(removeTarget?.project_count ?? 0) === 1 ? "" : "s"} in this organization will be revoked.`, "The removal is recorded in the organization security events."]}
				confirmLabel="Remove member"
				pending={remove.isPending}
				onConfirm={() => { if (!removeTarget) return; remove.mutate(removeTarget.id, { onSettled: () => setRemoveTarget(null) }); }}
			/>

			<ConfirmActionDialog
				open={!!transferTarget}
				onOpenChange={(open) => { if (!open) setTransferTarget(null); }}
				title="Transfer ownership"
				description={<>{"Make "}<span className="font-medium text-foreground">{transferTarget?.email}</span>{" the owner of "}<span className="font-mono">{org.slug}</span>?</>}
				impact={["There is exactly one owner: you become an admin.", "Only the new owner can transfer ownership back or delete the organization.", "The transfer is recorded in the organization security events."]}
				confirmationText={org.slug}
				confirmLabel="Transfer ownership"
				pending={transfer.isPending}
				onConfirm={() => { if (!transferTarget) return; transfer.mutate(transferTarget.id, { onSettled: () => setTransferTarget(null) }); }}
			/>

			<InvitationsSection orgSlug={org.slug} />
		</div>
	);
}

function invitationStateBadge(state: OrgInvitation["state"]) {
	return (
		<Badge variant={state === "pending" ? "outline" : "secondary"} className="px-1.5 py-0 text-[10px] font-medium capitalize">
			{state}
		</Badge>
	);
}

function InvitationsSection({ orgSlug }: { orgSlug: string }) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [stateFilter, setStateFilter] = useState<"" | OrgInvitationState>("");
	const [inviteSearch, setInviteSearch] = useState("");
	const [revokeTarget, setRevokeTarget] = useState<OrgInvitation | null>(null);
	const debouncedInviteSearch = useDebouncedValue(inviteSearch.trim());
	const invitations = useOrgInvitations(orgSlug, {
		...(stateFilter ? { state: stateFilter } : {}),
		...(debouncedInviteSearch ? { q: debouncedInviteSearch } : {}),
	});
	const create = useCreateOrgInvitation(orgSlug);
	const revoke = useRevokeOrgInvitation(orgSlug);
	const emailValid = email.includes("@") && email.trim().length > 3;

	async function send() {
		if (!emailValid) return;
		const inv = await create.mutateAsync({ email: email.trim(), role });
		setEmail("");
		if (inv.url) {
			await navigator.clipboard.writeText(inv.url).catch(() => {});
			toast.success("Invitation link copied to clipboard");
		}
	}

	return (
		<section className="space-y-3 border-t border-border/70 pt-5">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<SectionHeading title="Invitations" description="Email-bound join links with server-side lifecycle checks." />
				<div className="flex flex-wrap items-center gap-2">
					<Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="person@company.com" aria-label="Invitation email" className={cn("h-8 w-56 text-sm", CONTROL_CLASS_NAME)} onKeyDown={(event) => { if (event.key === "Enter") send(); }} />
					<PickerSelect value={role} onValueChange={(value) => setRole(value as "admin" | "member")} options={ORG_ROLE_OPTIONS} className="w-28" inputClassName="h-8 text-sm" ariaLabel="Invitation role" />
					<Button size="sm" className="h-8" onClick={send} disabled={!emailValid || create.isPending}>
						{create.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
						Invite
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input value={inviteSearch} onChange={(event) => setInviteSearch(event.target.value)} placeholder="Search invitations" aria-label="Search invitations" className={cn("h-8 w-56 pl-8 text-sm", CONTROL_CLASS_NAME)} />
				</div>
				<PickerSelect value={stateFilter} onValueChange={(value) => setStateFilter(value as "" | OrgInvitationState)} options={[{ value: "", label: "All invitation states" }, { value: "pending", label: "Pending" }, { value: "accepted", label: "Accepted" }, { value: "expired", label: "Expired" }, { value: "revoked", label: "Revoked" }]} className="w-44" inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)} ariaLabel="Filter invitations by state" />
			</div>

			{invitations.isLoading ? (
				<TableSkeleton rows={2} />
			) : invitations.isError ? (
				<ErrorState message="Failed to load invitations" onRetry={() => invitations.refetch()} />
			) : (invitations.data ?? []).length === 0 ? (
				<p className="rounded-md border border-border px-3 py-3 text-xs text-muted-foreground">No invitations match.</p>
			) : (
				<div className={cn("overflow-x-auto rounded-md border border-border", invitations.isFetching && "opacity-70")}>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead className="w-28">Role</TableHead>
								<TableHead className="w-28">Status</TableHead>
								<TableHead className="w-36">Expires</TableHead>
								<TableHead className="w-20" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{(invitations.data ?? []).map((inv) => (
								<TableRow key={inv.id}>
									<TableCell>
										<p className="font-medium">{inv.email}</p>
										{inv.invited_by && <p className="text-[11px] text-muted-foreground">invited by @{inv.invited_by}</p>}
									</TableCell>
									<TableCell><MemberRoleBadge role={inv.role} /></TableCell>
									<TableCell>{invitationStateBadge(inv.state)}</TableCell>
									<TableCell className="text-xs text-muted-foreground">{formatDate(inv.expires_at)}</TableCell>
									<TableCell>
										<div className="flex items-center justify-end gap-1">
											{inv.state === "pending" && inv.url && (
												<Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" aria-label={`Copy invitation link for ${inv.email}`} onClick={async () => { await navigator.clipboard.writeText(inv.url ?? ""); toast.success("Invitation link copied"); }}><Copy className="h-3.5 w-3.5" /></Button>
											)}
											{inv.state === "pending" && (
												<Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Revoke invitation for ${inv.email}`} onClick={() => setRevokeTarget(inv)}><UserX className="h-3.5 w-3.5" /></Button>
											)}
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			<ConfirmActionDialog
				open={!!revokeTarget}
				onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
				title="Revoke invitation"
				description={<>{"Revoke the pending invitation for "}<span className="font-medium text-foreground">{revokeTarget?.email}</span>?</>}
				impact={["Their join link stops working immediately.", "You can invite the same address again later."]}
				confirmLabel="Revoke invitation"
				pending={revoke.isPending}
				onConfirm={() => { if (!revokeTarget) return; revoke.mutate(revokeTarget.id, { onSettled: () => setRevokeTarget(null) }); }}
			/>
		</section>
	);
}
