// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organization → Projects: server-paginated project administration. Create
// projects, edit their profile, manage each roster (lead/user - the access
// mechanism for its resources), and delete empty projects with a typed
// confirmation. Never shows the resources themselves - those stay in the
// project workspace.

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
import type { Organization, OrgListParams, Project, ProjectMember, ProjectRole } from "@/lib/types";
import {
	AddMemberRow,
	CONTROL_CLASS_NAME,
	MemberRoleBadge,
	memberBody,
	useAdministeredOrg,
} from "@/pages/organization/shell";

const PAGE_SIZE = 25;

const SORTS: { value: string; label: string; sort: string; dir: "asc" | "desc" }[] = [
	{ value: "name-asc", label: "Name (A–Z)", sort: "name", dir: "asc" },
	{ value: "name-desc", label: "Name (Z–A)", sort: "name", dir: "desc" },
	{ value: "created-desc", label: "Newest projects", sort: "created", dir: "desc" },
	{ value: "created-asc", label: "Oldest projects", sort: "created", dir: "asc" },
	{ value: "members-desc", label: "Most members", sort: "members", dir: "desc" },
];

function formatDate(value?: string | null) {
	if (!value) return "–";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "–"
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function RosterRow({ org, project, member }: { org: Organization; project: Project; member: ProjectMember }) {
	const upsert = useUpsertProjectMember(org.slug, project.slug);
	const remove = useRemoveProjectMember(org.slug, project.slug);
	return (
		<li className="flex items-center justify-between gap-2 text-sm">
			<span className="flex min-w-0 items-center gap-2">
				<span className="truncate">{member.username ? `@${member.username}` : member.email}</span>
			</span>
			<span className="flex items-center gap-1.5">
				<PickerSelect
					value={member.role}
					onValueChange={(role) => upsert.mutate({ user_id: member.id, role: role as ProjectRole } as never)}
					options={[
						{ value: "lead", label: "Lead" },
						{ value: "user", label: "User" },
					]}
					className="w-24"
					ariaLabel={`Project role for ${member.email}`}
				/>
				<Button
					size="icon"
					variant="ghost"
					className="h-6 w-6 text-muted-foreground hover:text-destructive"
					aria-label={`Remove ${member.email} from project`}
					disabled={remove.isPending}
					onClick={() => remove.mutate(member.id)}
				>
					<Trash2 className="h-3 w-3" />
				</Button>
			</span>
		</li>
	);
}

function ProjectDetail({ org, project }: { org: Organization; project: Project }) {
	const members = useProjectMembers(org.slug, project.slug);
	const upsert = useUpsertProjectMember(org.slug, project.slug);
	const update = useUpdateProject(org.slug, project.slug);
	const deleteProject = useDeleteProject(org.slug);
	const [name, setName] = useState<string | null>(null);
	const [description, setDescription] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const effectiveName = name ?? project.name;
	const effectiveDescription = description ?? project.description ?? "";
	const profileDirty = effectiveName !== project.name || effectiveDescription !== (project.description ?? "");

	return (
		<div className="grid gap-5 px-4 py-4 lg:grid-cols-2">
			<div className="space-y-2">
				<p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">Project members</p>
				<AddMemberRow
					roles={[
						{ value: "lead", label: "Lead" },
						{ value: "user", label: "User" },
					]}
					pending={upsert.isPending}
					onAdd={(identity, role) => upsert.mutate(memberBody(identity, role) as never)}
				/>
				<p className="text-xs text-muted-foreground">
					Project membership is what grants access to this project's resources. Organization owners and admins can
					administer every project without a roster entry.
				</p>
				{members.isLoading ? (
					<TableSkeleton rows={2} />
				) : (
					<ul className="space-y-1.5">
						{(members.data ?? []).map((member) => (
							<RosterRow key={member.id} org={org} project={project} member={member} />
						))}
						{(members.data ?? []).length === 0 && (
							<li className="text-xs text-muted-foreground">No project members yet.</li>
						)}
					</ul>
				)}
			</div>

			<div className="space-y-3">
				<p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">Profile</p>
				<div>
					<Label htmlFor={`project-name-${project.slug}`} className="text-xs">
						Name
					</Label>
					<Input
						id={`project-name-${project.slug}`}
						value={effectiveName}
						onChange={(e) => setName(e.target.value)}
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
						onChange={(e) => setDescription(e.target.value)}
						rows={2}
						className={cn("mt-1 text-sm", CONTROL_CLASS_NAME)}
					/>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Button
						size="sm"
						disabled={!profileDirty || !effectiveName.trim() || update.isPending}
						onClick={() => update.mutate({ name: effectiveName.trim(), description: effectiveDescription })}
					>
						{update.isPending ? (
							<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
						) : (
							<Save className="mr-1.5 h-3.5 w-3.5" />
						)}
						Save profile
					</Button>
					<Button
						size="sm"
						variant="outline"
						className="text-destructive hover:bg-destructive/10"
						disabled={project.is_default}
						title={project.is_default ? "The default project cannot be deleted." : undefined}
						onClick={() => setConfirmDelete(true)}
					>
						<Trash2 className="mr-1.5 h-3.5 w-3.5" />
						Delete project
					</Button>
				</div>
				{project.is_default && (
					<p className="text-[11px] text-muted-foreground">
						This is the organization's default project; it exists as long as the organization does.
					</p>
				)}
			</div>

			<ConfirmActionDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete project"
				description={
					<>
						Permanently delete{" "}
						<span className="font-mono font-medium text-foreground">
							{org.slug}/{project.slug}
						</span>
						?
					</>
				}
				impact={[
					"The project must own no resources; the server refuses otherwise.",
					`${project.member_count ?? 0} project membership${(project.member_count ?? 0) === 1 ? "" : "s"} will be revoked.`,
					"The deletion is recorded in the organization security events.",
				]}
				confirmationText={project.slug}
				confirmLabel="Delete project"
				pending={deleteProject.isPending}
				onConfirm={() => deleteProject.mutate(project.slug, { onSettled: () => setConfirmDelete(false) })}
			/>
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
					<DialogDescription>
						Projects own agents and components; project membership grants access to them.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div>
						<Label htmlFor="new-project-name" className="text-xs">
							Name
						</Label>
						<Input
							id="new-project-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
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
							onChange={(e) => {
								setSlug(e.target.value);
								setSlugEdited(true);
							}}
							placeholder="payments"
							className={cn("mt-1 h-8 font-mono text-sm", CONTROL_CLASS_NAME)}
						/>
						<p className="mt-1 text-[11px] text-muted-foreground">Becomes the project's URL segment.</p>
					</div>
					<div>
						<Label htmlFor="new-project-description" className="text-xs">
							Description <span className="text-muted-foreground">(optional)</span>
						</Label>
						<Textarea
							id="new-project-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
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
	const [sortValue, setSortValue] = useState(SORTS[0].value);
	const [page, setPage] = useState(1);
	const [openProject, setOpenProject] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const debouncedSearch = useDebouncedValue(search.trim());
	const sort = SORTS.find((s) => s.value === sortValue) ?? SORTS[0];
	const params: OrgListParams = {
		...(debouncedSearch ? { q: debouncedSearch } : {}),
		sort: sort.sort,
		dir: sort.dir,
		page,
		page_size: PAGE_SIZE,
	};

	const projects = useOrgProjects(canManageProjects ? org?.slug : undefined, params);

	if (!org || !canManageProjects) return <NotFoundState />;

	const rows = projects.data?.projects ?? [];
	const total = projects.data?.total ?? 0;
	const filtered = !!debouncedSearch;

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-end gap-3">
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
						onChange={(e) => {
							setSearch(e.target.value);
							setPage(1);
							setOpenProject(null);
						}}
						placeholder="Search projects…"
						aria-label="Search projects"
						className={cn("h-8 w-64 pl-8 text-sm", CONTROL_CLASS_NAME)}
					/>
				</div>
				<PickerSelect
					value={sortValue}
					onValueChange={(value) => {
						setSortValue(value);
						setPage(1);
						setOpenProject(null);
					}}
					options={SORTS.map(({ value, label }) => ({ value, label }))}
					className="w-44"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Sort projects"
				/>
			</div>

			{projects.isLoading ? (
				<TableSkeleton rows={3} />
			) : projects.isError ? (
				<ErrorState message="Failed to load projects" onRetry={() => projects.refetch()} />
			) : rows.length === 0 && !filtered ? (
				<EmptyState
					icon={FolderKanban}
					title="No projects"
					description="Create the first project to home agents and components."
				/>
			) : (
				<>
					<div className={cn("overflow-x-auto rounded-md border border-border", projects.isFetching && "opacity-70")}>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8" />
									<TableHead>Project</TableHead>
									<TableHead className="w-28">Your role</TableHead>
									<TableHead className="w-24">Members</TableHead>
									<TableHead className="w-32">Created</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((project) => (
									<Fragment key={project.id}>
										<TableRow
											className="cursor-pointer"
											onClick={() => setOpenProject(openProject === project.slug ? null : project.slug)}
										>
											<TableCell className="pr-0">
												<Button
													size="icon"
													variant="ghost"
													className="h-6 w-6 text-muted-foreground"
													aria-label={`Toggle details for ${project.name}`}
													aria-expanded={openProject === project.slug}
													onClick={(e) => {
														e.stopPropagation();
														setOpenProject(openProject === project.slug ? null : project.slug);
													}}
												>
													{openProject === project.slug ? (
														<ChevronDown className="h-3.5 w-3.5" />
													) : (
														<ChevronRight className="h-3.5 w-3.5" />
													)}
												</Button>
											</TableCell>
											<TableCell>
												<div className="flex min-w-0 items-center gap-2">
													<span className="truncate text-sm font-medium">{project.name}</span>
													<span className="truncate font-mono text-[11px] text-muted-foreground">
														{org.slug}/{project.slug}
													</span>
													{project.is_default && (
														<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
															default
														</Badge>
													)}
												</div>
											</TableCell>
											<TableCell>
												{project.role ? (
													<MemberRoleBadge role={project.role} />
												) : (
													<span className="text-xs text-muted-foreground">via org role</span>
												)}
											</TableCell>
											<TableCell>
												<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
													<Users className="h-3 w-3" />
													{project.member_count ?? 0}
												</span>
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">{formatDate(project.created_at)}</TableCell>
										</TableRow>
										{openProject === project.slug && (
											<TableRow className="bg-accent/20 hover:bg-accent/20">
												<TableCell colSpan={5} className="p-0">
													<ProjectDetail org={org} project={project} />
												</TableCell>
											</TableRow>
										)}
									</Fragment>
								))}
								{rows.length === 0 && (
									<TableRow>
										<TableCell colSpan={5} className="py-6 text-center text-xs text-muted-foreground">
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
