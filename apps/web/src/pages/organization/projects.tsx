// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organization -> Projects: authoritative organization-level project access.

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, FolderKanban, Loader2, Plus, Save, Search, Trash2, Users } from "lucide-react";
import { ConfirmActionDialog } from "@/components/organization/confirm-action-dialog";
import { ListPaginationFooter, useDebouncedValue } from "@/components/organization/list-controls";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { NotFoundState } from "@/components/shared/not-found-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PickerSelect } from "@/components/ui/picker-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
	useCreateProject,
	useDeleteProject,
	useOrgProjects,
	useProjectMembers,
	useRemoveProjectMember,
	useUpdateProject,
	useUpsertProjectMember,
} from "@/hooks/use-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { slugifyRegistryText } from "@/lib/registry-name";
import { cn } from "@/lib/utils";
import type { Organization, OrgListParams, Project, ProjectMember, ProjectMemberListParams, ProjectRole } from "@/lib/types";
import {
	AddMemberRow,
	CONTROL_CLASS_NAME,
	MemberRoleBadge,
	memberBody,
	useAdministeredOrg,
} from "@/pages/organization/shell";

const PAGE_SIZE = 25;
const MEMBER_PAGE_SIZE = 12;

const PROJECT_SORTS: { value: string; label: string; sort: string; dir: "asc" | "desc" }[] = [
	{ value: "name-asc", label: "Name A-Z", sort: "name", dir: "asc" },
	{ value: "name-desc", label: "Name Z-A", sort: "name", dir: "desc" },
	{ value: "members-desc", label: "Most access", sort: "members", dir: "desc" },
	{ value: "created-desc", label: "Newest", sort: "created", dir: "desc" },
	{ value: "created-asc", label: "Oldest", sort: "created", dir: "asc" },
];

const MEMBER_SORTS: { value: string; label: string; sort: string; dir: "asc" | "desc" }[] = [
	{ value: "email-asc", label: "Email A-Z", sort: "email", dir: "asc" },
	{ value: "name-asc", label: "Name A-Z", sort: "name", dir: "asc" },
	{ value: "role-asc", label: "Project role", sort: "role", dir: "asc" },
	{ value: "org-role-asc", label: "Org role", sort: "org_role", dir: "asc" },
	{ value: "joined-desc", label: "Newest access", sort: "joined", dir: "desc" },
];

function formatDate(value?: string | null) {
	if (!value) return "-";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "-"
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function userLabel(member: ProjectMember) {
	return member.name || (member.username ? `@${member.username}` : member.email);
}

function permissionLabel(permission: string) {
	return permission.replace(/^project\./, "").replaceAll(".", " ");
}

function inheritedOrgAccess(member: ProjectMember) {
	return member.org_role === "owner" || member.org_role === "admin";
}

function ProjectStatus({ project }: { project: Project }) {
	return project.is_default ? (
		<Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
			Protected default
		</Badge>
	) : (
		<Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
			Active
		</Badge>
	);
}

function AccessSource({ member }: { member: ProjectMember }) {
	if (inheritedOrgAccess(member)) {
		return <span className="text-xs text-muted-foreground">Org role</span>;
	}
	return <span className="text-xs text-muted-foreground">Project roster</span>;
}

function PermissionSummary({ member }: { member: ProjectMember }) {
	const permissions = member.permissions ?? [];
	if (permissions.length === 0) return <span className="text-xs text-muted-foreground">No permissions</span>;
	return (
		<details className="group">
			<summary className="cursor-pointer text-xs text-muted-foreground marker:text-muted-foreground">
				{permissions.length} permissions
			</summary>
			<div className="mt-1 flex max-w-md flex-wrap gap-1">
				{permissions.map((permission) => (
					<Badge key={permission} variant="outline" className="px-1.5 py-0 text-[10px] font-normal capitalize">
						{permissionLabel(permission)}
					</Badge>
				))}
			</div>
		</details>
	);
}

function ProjectMemberRow({ org, project, member }: { org: Organization; project: Project; member: ProjectMember }) {
	const upsert = useUpsertProjectMember(org.slug, project.slug);
	const remove = useRemoveProjectMember(org.slug, project.slug);
	const locked = inheritedOrgAccess(member);
	const assignedRole = member.assigned_role ?? member.role;

	return (
		<TableRow>
			<TableCell>
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{userLabel(member)}</p>
					<p className="truncate text-xs text-muted-foreground">{member.email}</p>
				</div>
			</TableCell>
			<TableCell>
				<div className="flex flex-wrap items-center gap-1.5">
					{member.org_role && <MemberRoleBadge role={member.org_role} />}
					<AccessSource member={member} />
				</div>
			</TableCell>
			<TableCell>
				<PickerSelect
					value={assignedRole}
					onValueChange={(role) => upsert.mutate({ user_id: member.id, role: role as ProjectRole })}
					options={[
						{ value: "lead", label: "Lead" },
						{ value: "user", label: "Member" },
					]}
					className="w-28"
					inputClassName="h-7 text-xs"
					ariaLabel={`Project role for ${member.email}`}
					disabled={locked || upsert.isPending}
				/>
				{locked && <p className="mt-1 text-[11px] text-muted-foreground">Effective lead</p>}
			</TableCell>
			<TableCell>
				<PermissionSummary member={member} />
			</TableCell>
			<TableCell className="text-xs text-muted-foreground">{formatDate(member.created_at)}</TableCell>
			<TableCell className="text-right">
				<Button
					size="icon"
					variant="ghost"
					className="h-7 w-7 text-muted-foreground hover:text-destructive"
					aria-label={`Remove ${member.email} from ${project.name}`}
					title={locked ? "Organization owner/admin access is inherited." : undefined}
					disabled={locked || remove.isPending}
					onClick={() => remove.mutate(member.id)}
				>
					<Trash2 className="h-3.5 w-3.5" />
				</Button>
			</TableCell>
		</TableRow>
	);
}

function ProjectAccessPanel({ org, project }: { org: Organization; project: Project }) {
	const [search, setSearch] = useState("");
	const [roleFilter, setRoleFilter] = useState<"all" | ProjectRole>("all");
	const [sortValue, setSortValue] = useState(MEMBER_SORTS[0].value);
	const [page, setPage] = useState(1);
	const debouncedSearch = useDebouncedValue(search.trim());
	const sort = MEMBER_SORTS.find((item) => item.value === sortValue) ?? MEMBER_SORTS[0];
	const params: ProjectMemberListParams = {
		...(debouncedSearch ? { q: debouncedSearch } : {}),
		...(roleFilter !== "all" ? { role: roleFilter } : {}),
		sort: sort.sort,
		dir: sort.dir,
		page,
		page_size: MEMBER_PAGE_SIZE,
	};
	const members = useProjectMembers(org.slug, project.slug, params);
	const upsert = useUpsertProjectMember(org.slug, project.slug);
	const rows = members.data?.members ?? [];
	const total = members.data?.total ?? 0;

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">Access</p>
					<p className="text-xs text-muted-foreground">
						{total} {total === 1 ? "user" : "users"} with project access
					</p>
				</div>
				<AddMemberRow
					roles={[
						{ value: "lead", label: "Lead" },
						{ value: "user", label: "Member" },
					]}
					pending={upsert.isPending}
					label="Grant access"
					onAdd={(identity, role) => upsert.mutate(memberBody(identity, role) as never)}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(1);
						}}
						placeholder="Search users"
						aria-label="Search project members"
						className={cn("h-8 w-56 pl-8 text-sm", CONTROL_CLASS_NAME)}
					/>
				</div>
				<PickerSelect
					value={roleFilter}
					onValueChange={(value) => {
						setRoleFilter(value as "all" | ProjectRole);
						setPage(1);
					}}
					options={[
						{ value: "all", label: "All roles" },
						{ value: "lead", label: "Lead" },
						{ value: "user", label: "Member" },
					]}
					className="w-32"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Filter project members by role"
				/>
				<PickerSelect
					value={sortValue}
					onValueChange={(value) => {
						setSortValue(value);
						setPage(1);
					}}
					options={MEMBER_SORTS.map(({ value, label }) => ({ value, label }))}
					className="w-40"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Sort project members"
				/>
			</div>

			{members.isLoading ? (
				<TableSkeleton rows={3} />
			) : members.isError ? (
				<ErrorState message="Failed to load project access" onRetry={() => members.refetch()} />
			) : (
				<>
					<div className={cn("overflow-x-auto rounded-md border border-border", members.isFetching && "opacity-70")}>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>User</TableHead>
									<TableHead className="w-40">Source</TableHead>
									<TableHead className="w-36">Project role</TableHead>
									<TableHead>Effective permissions</TableHead>
									<TableHead className="w-28">Added</TableHead>
									<TableHead className="w-10" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((member) => (
									<ProjectMemberRow key={member.id} org={org} project={project} member={member} />
								))}
								{rows.length === 0 && (
									<TableRow>
										<TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">
											No users match.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
					<ListPaginationFooter
						page={page}
						pageSize={MEMBER_PAGE_SIZE}
						total={total}
						label={total === 1 ? "user" : "users"}
						onPageChange={setPage}
					/>
				</>
			)}
		</div>
	);
}

function ProjectProfilePanel({ org, project }: { org: Organization; project: Project }) {
	const update = useUpdateProject(org.slug, project.slug);
	const deleteProject = useDeleteProject(org.slug);
	const [name, setName] = useState<string | null>(null);
	const [description, setDescription] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const effectiveName = name ?? project.name;
	const effectiveDescription = description ?? project.description ?? "";
	const profileDirty = effectiveName !== project.name || effectiveDescription !== (project.description ?? "");
	const canDelete = hasPermission(project, PERMISSIONS.projectDelete) && !project.is_default;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">Project</p>
				<ProjectStatus project={project} />
			</div>
			<div>
				<Label htmlFor={`project-name-${project.slug}`} className="text-xs">
					Name
				</Label>
				<Input
					id={`project-name-${project.slug}`}
					value={effectiveName}
					onChange={(event) => setName(event.target.value)}
					className={cn("mt-1 h-8 text-sm", CONTROL_CLASS_NAME)}
				/>
			</div>
			<div>
				<Label htmlFor={`project-description-${project.slug}`} className="text-xs">
					Description
				</Label>
				<Textarea
					id={`project-description-${project.slug}`}
					value={effectiveDescription}
					onChange={(event) => setDescription(event.target.value)}
					rows={3}
					className={cn("mt-1 text-sm", CONTROL_CLASS_NAME)}
				/>
			</div>
			<div className="grid grid-cols-2 gap-2 text-xs">
				<div className="rounded-md border border-border px-3 py-2">
					<p className="text-muted-foreground">Project id</p>
					<p className="truncate font-mono text-foreground">{project.slug}</p>
				</div>
				<div className="rounded-md border border-border px-3 py-2">
					<p className="text-muted-foreground">Created</p>
					<p className="text-foreground">{formatDate(project.created_at)}</p>
				</div>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Button
					size="sm"
					disabled={!profileDirty || !effectiveName.trim() || update.isPending}
					onClick={() => update.mutate({ name: effectiveName.trim(), description: effectiveDescription })}
				>
					{update.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
					Save
				</Button>
				<Button
					size="sm"
					variant="outline"
					className="text-destructive hover:bg-destructive/10"
					disabled={!canDelete}
					title={project.is_default ? "The protected default project cannot be deleted." : undefined}
					onClick={() => setConfirmDelete(true)}
				>
					<Trash2 className="mr-1.5 h-3.5 w-3.5" />
					Delete
				</Button>
			</div>

			<ConfirmActionDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete project"
				description={
					<>
						Permanently delete <span className="font-mono font-medium text-foreground">{org.slug}/{project.slug}</span>?
					</>
				}
				impact={[
					"The server refuses deletion while the project owns resources or related source state.",
					`${project.member_count ?? 0} project access record${(project.member_count ?? 0) === 1 ? "" : "s"} will be removed.`,
					"The protected default project is never deletable.",
				]}
				confirmationText={project.slug}
				confirmLabel="Delete project"
				pending={deleteProject.isPending}
				onConfirm={() => deleteProject.mutate(project.slug, { onSettled: () => setConfirmDelete(false) })}
			/>
		</div>
	);
}

function ProjectDetail({ org, project }: { org: Organization; project: Project }) {
	return (
		<div className="grid gap-5 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
			<ProjectAccessPanel org={org} project={project} />
			<ProjectProfilePanel org={org} project={project} />
		</div>
	);
}

function CreateProjectDialog({
	orgSlug,
	open,
	onOpenChange,
}: {
	orgSlug: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const createProject = useCreateProject(orgSlug);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugEdited, setSlugEdited] = useState(false);
	const [description, setDescription] = useState("");
	const effectiveSlug = slugEdited ? slug : slugifyRegistryText(name, { maxLength: 64 });

	function submit() {
		createProject.mutate(
			{
				name: name.trim(),
				...(effectiveSlug ? { slug: effectiveSlug } : {}),
				...(description.trim() ? { description: description.trim() } : {}),
			},
			{
				onSuccess: () => {
					setName("");
					setSlug("");
					setSlugEdited(false);
					setDescription("");
					onOpenChange(false);
				},
			},
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New project</DialogTitle>
					<DialogDescription>Projects own scoped registry resources and project-level access.</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div>
						<Label htmlFor="new-project-name" className="text-xs">
							Name
						</Label>
						<Input
							id="new-project-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Payments"
							className={cn("mt-1 h-8 text-sm", CONTROL_CLASS_NAME)}
						/>
					</div>
					<div>
						<Label htmlFor="new-project-slug" className="text-xs">
							Project id
						</Label>
						<Input
							id="new-project-slug"
							value={effectiveSlug}
							onChange={(event) => {
								setSlug(event.target.value);
								setSlugEdited(true);
							}}
							placeholder="payments"
							className={cn("mt-1 h-8 font-mono text-sm", CONTROL_CLASS_NAME)}
						/>
					</div>
					<div>
						<Label htmlFor="new-project-description" className="text-xs">
							Description <span className="text-muted-foreground">(optional)</span>
						</Label>
						<Textarea
							id="new-project-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							rows={2}
							className={cn("mt-1 text-sm", CONTROL_CLASS_NAME)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button size="sm" onClick={submit} disabled={!name.trim() || createProject.isPending}>
						{createProject.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
						Create project
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export default function OrganizationProjectsPage() {
	const org = useAdministeredOrg();
	const canManageProjects = hasPermission(org, PERMISSIONS.orgProjectsManage);
	const [search, setSearch] = useState("");
	const [statusFilter, setStatusFilter] = useState<"all" | "default" | "standard">("all");
	const [sortValue, setSortValue] = useState(PROJECT_SORTS[0].value);
	const [page, setPage] = useState(1);
	const [openProject, setOpenProject] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const debouncedSearch = useDebouncedValue(search.trim());
	const sort = PROJECT_SORTS.find((item) => item.value === sortValue) ?? PROJECT_SORTS[0];
	const params: OrgListParams = {
		...(debouncedSearch ? { q: debouncedSearch } : {}),
		sort: sort.sort,
		dir: sort.dir,
		page,
		page_size: PAGE_SIZE,
	};
	const projects = useOrgProjects(canManageProjects ? org?.slug : undefined, params);

	if (!org || !canManageProjects) return <NotFoundState />;

	const serverRows = projects.data?.projects ?? [];
	const rows = serverRows.filter((project) => {
		if (statusFilter === "default") return project.is_default;
		if (statusFilter === "standard") return !project.is_default;
		return true;
	});
	const total = projects.data?.total ?? 0;
	const filtered = !!debouncedSearch || statusFilter !== "all";
	const defaultProject = serverRows.find((project) => project.is_default);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-semibold text-foreground">Projects</p>
					<p className="text-xs text-muted-foreground">
						{total} total - default {defaultProject ? defaultProject.slug : "loading"} - org admins inherit lead access
					</p>
				</div>
				<Button size="sm" variant="outline" onClick={() => setCreating(true)}>
					<Plus className="mr-1.5 h-3.5 w-3.5" />
					New project
				</Button>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(1);
							setOpenProject(null);
						}}
						placeholder="Search projects"
						aria-label="Search projects"
						className={cn("h-8 w-64 pl-8 text-sm", CONTROL_CLASS_NAME)}
					/>
				</div>
				<PickerSelect
					value={statusFilter}
					onValueChange={(value) => {
						setStatusFilter(value as "all" | "default" | "standard");
						setOpenProject(null);
					}}
					options={[
						{ value: "all", label: "All projects" },
						{ value: "default", label: "Default only" },
						{ value: "standard", label: "Standard only" },
					]}
					className="w-36"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Filter projects by status"
				/>
				<PickerSelect
					value={sortValue}
					onValueChange={(value) => {
						setSortValue(value);
						setPage(1);
						setOpenProject(null);
					}}
					options={PROJECT_SORTS.map(({ value, label }) => ({ value, label }))}
					className="w-40"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Sort projects"
				/>
			</div>

			{projects.isLoading ? (
				<TableSkeleton rows={3} />
			) : projects.isError ? (
				<ErrorState message="Failed to load projects" onRetry={() => projects.refetch()} />
			) : rows.length === 0 && !filtered ? (
				<EmptyState icon={FolderKanban} title="No projects" description="Create a project to scope agents and components." />
			) : (
				<>
					<div className={cn("overflow-x-auto rounded-md border border-border", projects.isFetching && "opacity-70")}>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8" />
									<TableHead>Project</TableHead>
									<TableHead className="w-36">Status</TableHead>
									<TableHead className="w-32">Your access</TableHead>
									<TableHead className="w-28">Users</TableHead>
									<TableHead className="w-28">Created</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((project) => {
									const open = openProject === project.slug;
									return (
										<Fragment key={project.id}>
											<TableRow className="cursor-pointer" onClick={() => setOpenProject(open ? null : project.slug)}>
												<TableCell className="pr-0">
													<Button
														size="icon"
														variant="ghost"
														className="h-6 w-6 text-muted-foreground"
														aria-label={`Toggle details for ${project.name}`}
														aria-expanded={open}
														onClick={(event) => {
															event.stopPropagation();
															setOpenProject(open ? null : project.slug);
														}}
													>
														{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
													</Button>
												</TableCell>
												<TableCell>
													<div className="min-w-0">
														<div className="flex min-w-0 items-center gap-2">
															<span className="truncate text-sm font-medium">{project.name}</span>
															{project.is_default && <FolderKanban className="h-3.5 w-3.5 shrink-0 text-primary-accent" />}
														</div>
														<p className="truncate font-mono text-[11px] text-muted-foreground">{org.slug}/{project.slug}</p>
														{project.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{project.description}</p>}
													</div>
												</TableCell>
												<TableCell>
													<ProjectStatus project={project} />
												</TableCell>
												<TableCell>
													{project.role ? <MemberRoleBadge role={project.role} /> : <span className="text-xs text-muted-foreground">Inherited lead</span>}
												</TableCell>
												<TableCell>
													<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
														<Users className="h-3 w-3" />
														{project.member_count ?? 0}
													</span>
												</TableCell>
												<TableCell className="text-xs text-muted-foreground">{formatDate(project.created_at)}</TableCell>
											</TableRow>
											{open && (
												<TableRow className="bg-accent/20 hover:bg-accent/20">
													<TableCell colSpan={6} className="p-0">
														<ProjectDetail org={org} project={project} />
													</TableCell>
												</TableRow>
											)}
										</Fragment>
									);
								})}
								{rows.length === 0 && (
									<TableRow>
										<TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">
											No projects match.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
					<ListPaginationFooter
						page={page}
						pageSize={PAGE_SIZE}
						total={total}
						label={total === 1 ? "project" : "projects"}
						onPageChange={(next) => {
							setPage(next);
							setOpenProject(null);
						}}
					/>
				</>
			)}

			<CreateProjectDialog orgSlug={org.slug} open={creating} onOpenChange={setCreating} />
		</div>
	);
}
