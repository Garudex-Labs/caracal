// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organization → Members: the server-paginated org roster with search, role
// filtering, deterministic sorting, per-member project-access visibility,
// role management, guarded removal, and owner-only ownership transfer.
// Email invitations (the self-serve join path) are managed below the roster.

import { useState, Fragment } from "react";
import { ChevronDown, ChevronRight, Copy, Crown, Loader2, Search, Trash2, UserX } from "lucide-react";
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
	useRemoveOrgMember,
	useRevokeOrgInvitation,
	useTransferOwnership,
	useUpsertOrgMember,
} from "@/hooks/use-api";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { Organization, OrgInvitation, OrgListParams, OrgMember, OrgRole } from "@/lib/types";
import {
	AddMemberRow,
	CONTROL_CLASS_NAME,
	MemberRoleBadge,
	SectionHeading,
	memberBody,
	useAdministeredOrg,
} from "@/pages/organization/shell";

const PAGE_SIZE = 25;

const SORTS: { value: string; label: string; sort: string; dir: "asc" | "desc" }[] = [
	{ value: "email-asc", label: "Email (A–Z)", sort: "email", dir: "asc" },
	{ value: "email-desc", label: "Email (Z–A)", sort: "email", dir: "desc" },
	{ value: "name-asc", label: "Name (A–Z)", sort: "name", dir: "asc" },
	{ value: "joined-desc", label: "Newest members", sort: "joined", dir: "desc" },
	{ value: "joined-asc", label: "Oldest members", sort: "joined", dir: "asc" },
	{ value: "role-asc", label: "Role", sort: "role", dir: "asc" },
];

function memberLabel(member: OrgMember) {
	return member.username ? `@${member.username}` : (member.name ?? member.email);
}

function formatDate(value?: string | null) {
	if (!value) return "–";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "–"
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Explicit project access for one member; admins inherit access org-wide. */
function MemberAccessPanel({ org, member }: { org: Organization; member: OrgMember }) {
	const access = useMemberProjects(org.slug, member.id);
	return (
		<div className="space-y-2 px-4 py-3">
			<p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">Project access</p>
			{(member.role === "owner" || member.role === "admin") && (
				<p className="text-xs text-muted-foreground">
					As an organization {member.role}, {memberLabel(member)} can administer every project.
				</p>
			)}
			{access.isLoading ? (
				<p className="text-xs text-muted-foreground">Loading project memberships…</p>
			) : access.isError ? (
				<p className="text-xs text-destructive">Failed to load project memberships.</p>
			) : (access.data ?? []).length === 0 ? (
				<p className="text-xs text-muted-foreground">No explicit project memberships.</p>
			) : (
				<ul className="flex flex-wrap gap-2">
					{(access.data ?? []).map((project) => (
						<li
							key={project.id}
							className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
						>
							<span className="font-medium">{project.name}</span>
							<span className="font-mono text-[11px] text-muted-foreground">
								{org.slug}/{project.slug}
							</span>
							<MemberRoleBadge role={project.role} />
							{project.is_default && (
								<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
									default
								</Badge>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export default function OrganizationMembersPage() {
	const org = useAdministeredOrg();
	const canManageMembers = hasPermission(org, PERMISSIONS.orgMembersManage);
	const canTransferOwnership = hasPermission(org, PERMISSIONS.orgOwnershipTransfer);

	const [search, setSearch] = useState("");
	const [roleFilter, setRoleFilter] = useState("");
	const [sortValue, setSortValue] = useState(SORTS[0].value);
	const [page, setPage] = useState(1);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);
	const [transferTarget, setTransferTarget] = useState<OrgMember | null>(null);

	const debouncedSearch = useDebouncedValue(search.trim());
	const sort = SORTS.find((s) => s.value === sortValue) ?? SORTS[0];
	const params: OrgListParams = {
		...(debouncedSearch ? { q: debouncedSearch } : {}),
		...(roleFilter ? { role: roleFilter as OrgRole } : {}),
		sort: sort.sort,
		dir: sort.dir,
		page,
		page_size: PAGE_SIZE,
	};

	const members = useOrgMembers(canManageMembers ? org?.slug : undefined, params);
	const upsert = useUpsertOrgMember(org?.slug ?? "");
	const remove = useRemoveOrgMember(org?.slug ?? "");
	const transfer = useTransferOwnership(org?.slug ?? "");

	if (!org || !canManageMembers) return <NotFoundState />;

	function resetToFirstPage() {
		setPage(1);
		setExpandedId(null);
	}

	const rows = members.data?.members ?? [];
	const total = members.data?.total ?? 0;

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-end gap-3">
				<AddMemberRow
					roles={[
						{ value: "admin", label: "Admin" },
						{ value: "member", label: "Member" },
					]}
					label="Add member"
					pending={upsert.isPending}
					onAdd={(identity, role) => upsert.mutate(memberBody(identity, role) as never)}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
							resetToFirstPage();
						}}
						placeholder="Search name, email, or username…"
						aria-label="Search members"
						className={cn("h-8 w-64 pl-8 text-sm", CONTROL_CLASS_NAME)}
					/>
				</div>
				<PickerSelect
					value={roleFilter}
					onValueChange={(value) => {
						setRoleFilter(value);
						resetToFirstPage();
					}}
					options={[
						{ value: "", label: "All roles" },
						{ value: "owner", label: "Owner" },
						{ value: "admin", label: "Admin" },
						{ value: "member", label: "Member" },
					]}
					className="w-32"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Filter by role"
				/>
				<PickerSelect
					value={sortValue}
					onValueChange={(value) => {
						setSortValue(value);
						resetToFirstPage();
					}}
					options={SORTS.map(({ value, label }) => ({ value, label }))}
					className="w-44"
					inputClassName={cn("h-8 text-sm", CONTROL_CLASS_NAME)}
					ariaLabel="Sort members"
				/>
			</div>

			{members.isLoading ? (
				<TableSkeleton rows={4} />
			) : members.isError ? (
				<ErrorState message="Failed to load members" onRetry={() => members.refetch()} />
			) : (
				<>
					<div className={cn("overflow-x-auto rounded-md border border-border", members.isFetching && "opacity-70")}>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8" />
									<TableHead>Member</TableHead>
									<TableHead>Email</TableHead>
									<TableHead className="w-36">Role</TableHead>
									<TableHead className="w-24">Projects</TableHead>
									<TableHead className="w-32">Joined</TableHead>
									<TableHead className="w-24" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((member) => (
								<Fragment key={member.id}>
									<TableRow>
										<TableCell className="pr-0">
												<Button
													size="icon"
													variant="ghost"
													className="h-6 w-6 text-muted-foreground"
													aria-label={`Toggle project access for ${member.email}`}
													aria-expanded={expandedId === member.id}
													onClick={() => setExpandedId(expandedId === member.id ? null : member.id)}
												>
													{expandedId === member.id ? (
														<ChevronDown className="h-3.5 w-3.5" />
													) : (
														<ChevronRight className="h-3.5 w-3.5" />
													)}
												</Button>
											</TableCell>
											<TableCell className="font-medium">
												{member.username ? `@${member.username}` : (member.name ?? "–")}
											</TableCell>
											<TableCell className="text-muted-foreground">{member.email}</TableCell>
											<TableCell>
												{member.role === "owner" ? (
													<MemberRoleBadge role="owner" />
												) : (
													<PickerSelect
														value={member.role}
														onValueChange={(role) =>
															upsert.mutate({ user_id: member.id, role: role as "admin" | "member" } as never)
														}
														options={[
															{ value: "admin", label: "Admin" },
															{ value: "member", label: "Member" },
														]}
														className="w-28"
														ariaLabel={`Role for ${member.email}`}
													/>
												)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{member.role === "owner" || member.role === "admin" ? "All" : (member.project_count ?? 0)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">{formatDate(member.created_at)}</TableCell>
											<TableCell>
												<div className="flex items-center justify-end gap-1">
													{canTransferOwnership && member.role !== "owner" && (
														<Button
															size="icon"
															variant="ghost"
															className="h-7 w-7 text-muted-foreground hover:text-primary-accent"
															aria-label={`Transfer ownership to ${member.email}`}
															onClick={() => setTransferTarget(member)}
														>
															<Crown className="h-3.5 w-3.5" />
														</Button>
													)}
													{member.role !== "owner" && (
														<Button
															size="icon"
															variant="ghost"
															className="h-7 w-7 text-muted-foreground hover:text-destructive"
															aria-label={`Remove ${member.email}`}
															onClick={() => setRemoveTarget(member)}
														>
															<Trash2 className="h-3.5 w-3.5" />
														</Button>
													)}
												</div>
											</TableCell>
										</TableRow>
										{expandedId === member.id && (
											<TableRow className="bg-accent/20 hover:bg-accent/20">
												<TableCell colSpan={7} className="p-0">
													<MemberAccessPanel org={org} member={member} />
												</TableCell>
											</TableRow>
										)}
									</Fragment>
								))}
								{rows.length === 0 && (
									<TableRow>
										<TableCell colSpan={7} className="py-6 text-center text-xs text-muted-foreground">
											No members match.
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
						label={total === 1 ? "member" : "members"}
						onPageChange={(next) => {
							setPage(next);
							setExpandedId(null);
						}}
					/>
				</>
			)}

			<ConfirmActionDialog
				open={!!removeTarget}
				onOpenChange={(open) => {
					if (!open) setRemoveTarget(null);
				}}
				title="Remove member"
				description={
					<>
						Remove <span className="font-medium text-foreground">{removeTarget?.email}</span> from{" "}
						<span className="font-mono">{org.slug}</span>?
					</>
				}
				impact={[
					"Their organization membership ends immediately.",
					`${removeTarget?.project_count ?? 0} explicit project membership${(removeTarget?.project_count ?? 0) === 1 ? "" : "s"} in this organization will be revoked.`,
					"The removal is recorded in the organization security events.",
				]}
				confirmLabel="Remove member"
				pending={remove.isPending}
				onConfirm={() => {
					if (!removeTarget) return;
					remove.mutate(removeTarget.id, { onSettled: () => setRemoveTarget(null) });
				}}
			/>

			<ConfirmActionDialog
				open={!!transferTarget}
				onOpenChange={(open) => {
					if (!open) setTransferTarget(null);
				}}
				title="Transfer ownership"
				description={
					<>
						Make <span className="font-medium text-foreground">{transferTarget?.email}</span> the owner of{" "}
						<span className="font-mono">{org.slug}</span>?
					</>
				}
				impact={[
					"There is exactly one owner: you become an admin.",
					"Only the new owner can transfer ownership back or delete the organization.",
					"The transfer is recorded in the organization security events.",
				]}
				confirmationText={org.slug}
				confirmLabel="Transfer ownership"
				pending={transfer.isPending}
				onConfirm={() => {
					if (!transferTarget) return;
					transfer.mutate(transferTarget.id, { onSettled: () => setTransferTarget(null) });
				}}
			/>

			<InvitationsSection orgSlug={org.slug} />
		</div>
	);
}

function invitationStateBadge(state: OrgInvitation["state"]) {
	return (
		<Badge
			variant={state === "pending" ? "outline" : "secondary"}
			className="px-1.5 py-0 text-[10px] font-medium capitalize"
		>
			{state}
		</Badge>
	);
}

function InvitationsSection({ orgSlug }: { orgSlug: string }) {
	const invitations = useOrgInvitations(orgSlug);
	const create = useCreateOrgInvitation(orgSlug);
	const revoke = useRevokeOrgInvitation(orgSlug);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [revokeTarget, setRevokeTarget] = useState<OrgInvitation | null>(null);

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
		<div className="space-y-3 border-t border-border/70 pt-5">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<SectionHeading
					title="Invitations"
					description="Email-bound join links. The invitee accepts during onboarding; links expire after 14 days."
				/>
				<div className="flex items-center gap-2">
					<Input
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="person@company.com"
						aria-label="Invitation email"
						className={cn("h-8 w-56 text-sm", CONTROL_CLASS_NAME)}
						onKeyDown={(e) => {
							if (e.key === "Enter") send();
						}}
					/>
					<PickerSelect
						value={role}
						onValueChange={(v) => setRole(v as "admin" | "member")}
						options={[
							{ value: "admin", label: "Admin" },
							{ value: "member", label: "Member" },
						]}
						className="w-28"
						ariaLabel="Invitation role"
					/>
					<Button size="sm" className="h-8" onClick={send} disabled={!emailValid || create.isPending}>
						{create.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
						Invite
					</Button>
				</div>
			</div>
			{invitations.isLoading ? (
				<TableSkeleton rows={2} />
			) : invitations.isError ? (
				<ErrorState message="Failed to load invitations" onRetry={() => invitations.refetch()} />
			) : (invitations.data ?? []).length === 0 ? (
				<p className="rounded-md border border-border px-3 py-3 text-xs text-muted-foreground">
					No invitations yet. Invite someone by email - they join through onboarding and get project access
					separately.
				</p>
			) : (
				<div className="rounded-md border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Expires</TableHead>
								<TableHead className="w-20" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{(invitations.data ?? []).map((inv) => (
								<TableRow key={inv.id}>
									<TableCell className="font-medium">{inv.email}</TableCell>
									<TableCell className="capitalize text-muted-foreground">{inv.role}</TableCell>
									<TableCell>{invitationStateBadge(inv.state)}</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										{new Date(inv.expires_at).toLocaleDateString()}
									</TableCell>
									<TableCell>
										<div className="flex items-center justify-end gap-1">
											{inv.state === "pending" && inv.url && (
												<Button
													size="icon"
													variant="ghost"
													className="h-7 w-7 text-muted-foreground hover:text-foreground"
													aria-label={`Copy invitation link for ${inv.email}`}
													onClick={async () => {
														await navigator.clipboard.writeText(inv.url ?? "");
														toast.success("Invitation link copied");
													}}
												>
													<Copy className="h-3.5 w-3.5" />
												</Button>
											)}
											{inv.state === "pending" && (
												<Button
													size="icon"
													variant="ghost"
													className="h-7 w-7 text-muted-foreground hover:text-destructive"
													aria-label={`Revoke invitation for ${inv.email}`}
													onClick={() => setRevokeTarget(inv)}
												>
													<UserX className="h-3.5 w-3.5" />
												</Button>
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
				onOpenChange={(open) => {
					if (!open) setRevokeTarget(null);
				}}
				title="Revoke invitation"
				description={
					<>
						Revoke the pending invitation for{" "}
						<span className="font-medium text-foreground">{revokeTarget?.email}</span>?
					</>
				}
				impact={["Their join link stops working immediately.", "You can invite the same address again later."]}
				confirmLabel="Revoke invitation"
				pending={revoke.isPending}
				onConfirm={() => {
					if (!revokeTarget) return;
					revoke.mutate(revokeTarget.id, { onSettled: () => setRevokeTarget(null) });
				}}
			/>
		</div>
	);
}
