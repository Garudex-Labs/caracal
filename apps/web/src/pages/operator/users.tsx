// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Deployment account inventory: every account on this installation with
// its deployment role, department, and organization footprint. Server-side
// search, filtering, sorting, and pagination. Organization rosters and org
// roles stay inside tenant administration; this page never duplicates them.

import { useMemo, useState, useCallback } from "react";
import {
	ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, Key, Loader2, Plus, Search, Trash2, Users,
} from "lucide-react";
import { toast } from "sonner";
import {
	useAdminUsers,
	useCreateUser,
	useUpdateUserRole,
	useUpdateUserDepartment,
	useDeleteUser,
} from "@/hooks/use-api";
import { admin, getUserRole } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import { copyToClipboard } from "@/lib/utils";
import { PageHeader } from "@/components/layouts/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
	Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { PickerSelect } from "@/components/ui/picker-select";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { ROLE_LABELS, hasMinRole, type Role } from "@/hooks/use-role-guard";
import { useDeploymentConfig } from "@/hooks/use-deployment-config";

const ALL_ROLES: Role[] = ["operator", "reviewer", "user"];
const PAGE_SIZE = 50;

const sortColumns = [
	{ key: "name", label: "Name" },
	{ key: "email", label: "Email" },
	{ key: "role", label: "Role" },
	{ key: "created", label: "Joined" },
] as const;

type SortKey = (typeof sortColumns)[number]["key"];

// Initial credential for admin-created accounts; users change it via the
// identity service's password-reset flow.
function generatePassword(length = 20): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
	const values = new Uint32Array(length);
	crypto.getRandomValues(values);
	return Array.from(values, (v) => alphabet[v % alphabet.length]).join("");
}

function useAssignableRoles(): Role[] {
	const myRole = getUserRole();
	return ALL_ROLES.filter((r) => hasMinRole(myRole, r));
}

function RoleSelect({ userId, currentRole }: { userId: string; currentRole: string }) {
	const mutation = useUpdateUserRole();
	const assignable = useAssignableRoles();
	const currentRoleOption = {
		value: currentRole,
		label: ROLE_LABELS[currentRole as Role] ?? currentRole,
	};
	const canEdit = assignable.includes(currentRole as Role);
	const options = canEdit
		? assignable.map((r) => ({ value: r, label: ROLE_LABELS[r] }))
		: [currentRoleOption];

	return (
		<PickerSelect
			value={currentRole}
			onValueChange={(value) => mutation.mutate({ id: userId, role: value })}
			disabled={!canEdit || mutation.isPending}
			className="w-35"
			inputClassName="h-7 text-xs"
			options={options}
		/>
	);
}

function DepartmentInput({ userId, currentDept }: { userId: string; currentDept: string | null | undefined }) {
	const mutation = useUpdateUserDepartment();
	const [value, setValue] = useState(currentDept ?? "");
	const [editing, setEditing] = useState(false);

	if (!editing) {
		return (
			<button
				onClick={() => setEditing(true)}
				className="text-xs text-muted-foreground transition-colors hover:text-foreground"
				title="Click to set department"
			>
				{currentDept || "-"}
			</button>
		);
	}

	return (
		<Input
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onBlur={() => {
				const trimmed = value.trim() || null;
				if (trimmed !== (currentDept ?? null)) {
					mutation.mutate({ id: userId, department: trimmed });
				}
				setEditing(false);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") { setValue(currentDept ?? ""); setEditing(false); }
			}}
			className="h-6 w-30 px-1.5 text-xs"
			placeholder="Department"
			autoFocus
		/>
	);
}

export default function OperatorUsersPage() {
	const [qDraft, setQDraft] = useState("");
	const [q, setQ] = useState("");
	const [roleFilter, setRoleFilter] = useState("all");
	const [sort, setSort] = useState<SortKey>("created");
	const [order, setOrder] = useState<"asc" | "desc">("desc");
	const [page, setPage] = useState(0);

	const params = useMemo(
		() => ({
			q: q || undefined,
			role: roleFilter === "all" ? undefined : roleFilter,
			sort,
			order,
			limit: PAGE_SIZE,
			offset: page * PAGE_SIZE,
		}),
		[q, roleFilter, sort, order, page],
	);
	const { data, isLoading, isError, error, refetch } = useAdminUsers(params);
	const createUser = useCreateUser();
	const deleteUser = useDeleteUser();
	const assignableRoles = useAssignableRoles();
	const { ssoOnly } = useDeploymentConfig();
	const [showCreate, setShowCreate] = useState(false);
	const [showBulkDept, setShowBulkDept] = useState(false);
	const [bulkCsv, setBulkCsv] = useState("");
	const [bulkLoading, setBulkLoading] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<string>("user");
	const [createdPassword, setCreatedPassword] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	function toggleSort(key: SortKey) {
		setPage(0);
		if (sort === key) {
			setOrder(order === "desc" ? "asc" : "desc");
		} else {
			setSort(key);
			setOrder(key === "created" ? "desc" : "asc");
		}
	}

	const handleCreate = useCallback(async () => {
		if (!name.trim() || !email.trim()) return;
		const password = generatePassword();
		createUser.mutate(
			{ email: email.trim(), name: name.trim(), password, role },
			{
				onSuccess: () => {
					setCreatedPassword(password);
					setName("");
					setEmail("");
					setRole("user");
				},
			},
		);
	}, [name, email, role, createUser]);

	const handleCopyPassword = useCallback(async () => {
		if (!createdPassword) return;
		try {
			await copyToClipboard(createdPassword);
			setCopied(true);
			toast.success("Password copied");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Failed to copy password");
		}
	}, [createdPassword]);

	const closeDialog = useCallback(() => {
		setShowCreate(false);
		setCreatedPassword(null);
		setName("");
		setEmail("");
		setRole("user");
	}, []);

	const items = data?.items ?? [];
	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return (
		<>
			<PageHeader title="Users" breadcrumbs={[{ label: "Operator" }, { label: "Users" }]} />
			<div className="mx-auto w-full max-w-6xl space-y-4 p-6">
				<header className="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h1 className="text-lg font-semibold tracking-tight">Users</h1>
						<p className="mt-1 text-[13px] text-muted-foreground">
							Every account on this deployment: deployment role, department, and organization
							footprint. Organization rosters live in tenant administration.
						</p>
					</div>
					<div className="flex gap-2">
						<Button size="sm" variant="outline" onClick={() => setShowBulkDept(true)} className="h-8">
							<Users className="mr-1 h-3.5 w-3.5" /> Bulk departments
						</Button>
						{!ssoOnly && (
							<Button size="sm" onClick={() => setShowCreate(true)} className="h-8">
								<Plus className="mr-1 h-3.5 w-3.5" /> Add user
							</Button>
						)}
					</div>
				</header>

				<div className="flex flex-wrap items-center gap-3">
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							setQ(qDraft.trim());
							setPage(0);
						}}
					>
						<div className="relative">
							<Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								value={qDraft}
								onChange={(e) => setQDraft(e.target.value)}
								placeholder="Search email, name, or username"
								className="h-9 w-70 pl-8 text-xs"
							/>
						</div>
						<Button type="submit" variant="outline" size="sm" className="h-9">
							Search
						</Button>
					</form>
					<PickerSelect
						value={roleFilter}
						onValueChange={(v) => { setRoleFilter(v); setPage(0); }}
						placeholder="Role"
						className="w-40"
						inputClassName="h-9 text-xs"
						options={[
							{ value: "all", label: "All roles" },
							...ALL_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
						]}
					/>
				</div>

				{isLoading ? (
					<TableSkeleton rows={10} cols={7} />
				) : isError ? (
					<ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
				) : total === 0 ? (
					<EmptyState
						icon={Users}
						title={q || roleFilter !== "all" ? "No matching users" : "No users yet"}
						description={
							q || roleFilter !== "all"
								? "Adjust the search or role filter."
								: "Accounts appear here once people sign up or are added by an operator."
						}
					/>
				) : (
					<>
						<div className="overflow-x-auto rounded-md border border-border">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										{sortColumns.map((col) => (
											<TableHead key={col.key} className="h-8 text-xs">
												<button
													type="button"
													onClick={() => toggleSort(col.key)}
													className="inline-flex items-center gap-1 hover:text-foreground"
												>
													{col.label}
													{sort === col.key ? (
														order === "desc" ? (
															<ArrowDown className="h-3 w-3" />
														) : (
															<ArrowUp className="h-3 w-3" />
														)
													) : (
														<ArrowUpDown className="h-3 w-3 opacity-40" />
													)}
												</button>
											</TableHead>
										))}
										<TableHead className="h-8 text-xs">Department</TableHead>
										<TableHead className="h-8 text-right text-xs">Orgs</TableHead>
										<TableHead className="h-8 w-15 text-xs" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{items.map((u) => (
										<TableRow key={u.id}>
											<TableCell className="py-1.5">
												<span className="text-sm font-medium">{u.name ?? "-"}</span>
												{u.username && (
													<span className="ml-2 text-xs text-muted-foreground">@{u.username}</span>
												)}
											</TableCell>
											<TableCell className="py-1.5 font-mono text-sm text-muted-foreground">
												{u.email ?? "-"}
											</TableCell>
											<TableCell className="py-1.5">
												<RoleSelect userId={u.id} currentRole={u.role} />
											</TableCell>
											<TableCell className="py-1.5 text-xs tabular-nums text-muted-foreground">
												{u.created_at ? new Date(u.created_at).toLocaleDateString() : "-"}
											</TableCell>
											<TableCell className="py-1.5">
												<DepartmentInput userId={u.id} currentDept={u.department} />
											</TableCell>
											<TableCell className="py-1.5 text-right text-[13px] tabular-nums">
												{u.org_count ?? 0}
											</TableCell>
											<TableCell className="py-1.5">
												<div className="flex items-center justify-end gap-1">
													<Button
														variant="ghost"
														size="sm"
														className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
														aria-label={`Delete ${u.name ?? u.email ?? "user"}`}
														onClick={() => setDeleteTarget(u)}
													>
														<Trash2 className="h-3.5 w-3.5" />
													</Button>
												</div>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>

						<div className="flex items-center justify-between">
							<p className="text-xs text-muted-foreground">
								Showing {page * PAGE_SIZE + 1}-{page * PAGE_SIZE + items.length} of {total}
							</p>
							<div className="flex items-center gap-2">
								<Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
									Previous
								</Button>
								<span className="text-xs text-muted-foreground">
									Page {page + 1} of {pageCount}
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={page + 1 >= pageCount}
									onClick={() => setPage(page + 1)}
								>
									Next
								</Button>
							</div>
						</div>
					</>
				)}

				{/* Create user dialog */}
				<Dialog open={showCreate} onOpenChange={(open) => { if (!open) closeDialog(); }}>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>{createdPassword ? "User created" : "Add user"}</DialogTitle>
							<DialogDescription>
								{createdPassword
									? "Save this password - it will not be shown again."
									: "Create a new account. They will receive a password for authentication."}
							</DialogDescription>
						</DialogHeader>

						{createdPassword ? (
							<div className="space-y-4">
								<div className="rounded-md border border-border bg-muted/30 p-3">
									<div className="mb-2 flex items-center gap-2">
										<Key className="h-3.5 w-3.5 text-muted-foreground" />
										<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</span>
									</div>
									<div className="flex items-center gap-2">
										<code className="flex-1 select-all break-all font-mono text-xs text-foreground">
											{createdPassword}
										</code>
										<Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" onClick={handleCopyPassword}>
											{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
										</Button>
									</div>
								</div>
								<DialogFooter>
									<Button variant="ghost" size="sm" onClick={closeDialog}>Done</Button>
									<Button size="sm" onClick={() => setCreatedPassword(null)}>Create another</Button>
								</DialogFooter>
							</div>
						) : (
							<div className="space-y-4">
								<div className="space-y-2">
									<label className="text-xs font-medium text-muted-foreground">Name</label>
									<Input
										placeholder="Richard Hendricks"
										value={name}
										onChange={(e) => setName(e.target.value)}
										className="h-8 text-sm"
										autoFocus
									/>
								</div>
								<div className="space-y-2">
									<label className="text-xs font-medium text-muted-foreground">Email</label>
									<Input
										type="email"
										placeholder="richard@example.com"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										className="h-8 text-sm"
										onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
									/>
								</div>
								<div className="space-y-2">
									<label className="text-xs font-medium text-muted-foreground">Role</label>
									<PickerSelect
										value={role}
										onValueChange={setRole}
										inputClassName="h-8 text-sm"
										options={assignableRoles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
									/>
								</div>
								<DialogFooter>
									<Button variant="ghost" size="sm" onClick={closeDialog}>Cancel</Button>
									<Button
										size="sm"
										onClick={handleCreate}
										disabled={createUser.isPending || !name.trim() || !email.trim()}
									>
										{createUser.isPending ? (
											<><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Creating...</>
										) : (
											"Create user"
										)}
									</Button>
								</DialogFooter>
							</div>
						)}
					</DialogContent>
				</Dialog>

				{/* Delete user confirmation */}
				<Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>Delete user</DialogTitle>
							<DialogDescription>
								This will permanently delete <strong>{deleteTarget?.name}</strong> ({deleteTarget?.email}) and all associated data.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
							<Button
								variant="destructive"
								size="sm"
								onClick={() => {
									if (!deleteTarget) return;
									deleteUser.mutate(deleteTarget.id, {
										onSuccess: () => setDeleteTarget(null),
									});
								}}
								disabled={deleteUser.isPending}
							>
								{deleteUser.isPending ? (
									<><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Deleting...</>
								) : (
									"Delete user"
								)}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				{/* Bulk department import */}
				<Dialog open={showBulkDept} onOpenChange={(open) => { if (!open) { setShowBulkDept(false); setBulkCsv(""); } }}>
					<DialogContent className="sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>Bulk import departments</DialogTitle>
							<DialogDescription>
								Paste CSV data with one user per line: <code className="rounded bg-muted px-1 text-xs">email,department</code>
							</DialogDescription>
						</DialogHeader>
						<textarea
							value={bulkCsv}
							onChange={(e) => setBulkCsv(e.target.value)}
							placeholder={"richard@company.com,Engineering\njared@company.com,Product\ngilfoyle@company.com,DevOps"}
							className="h-40 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						/>
						<DialogFooter>
							<Button variant="ghost" size="sm" onClick={() => { setShowBulkDept(false); setBulkCsv(""); }}>Cancel</Button>
							<Button
								size="sm"
								disabled={bulkLoading || !bulkCsv.trim()}
								onClick={async () => {
									setBulkLoading(true);
									try {
										const entries = bulkCsv.trim().split("\n").map((line) => {
											const [entryEmail, ...rest] = line.split(",");
											return { email: entryEmail.trim(), department: rest.join(",").trim() };
										}).filter((e) => e.email && e.department);
										const result = await admin.bulkDepartment(entries);
										toast.success(`Updated ${result.updated} users${result.not_found.length > 0 ? `, ${result.not_found.length} not found` : ""}`);
										if (result.not_found.length > 0) {
											toast.error(`Not found: ${result.not_found.slice(0, 5).join(", ")}${result.not_found.length > 5 ? "..." : ""}`);
										}
										setShowBulkDept(false);
										setBulkCsv("");
										refetch();
									} catch (e) {
										toast.error(e instanceof Error ? e.message : "Bulk import failed");
									} finally {
										setBulkLoading(false);
									}
								}}
							>
								{bulkLoading ? (
									<><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Importing...</>
								) : (
									"Import"
								)}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
		</>
	);
}
