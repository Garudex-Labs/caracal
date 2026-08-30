// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Dedicated shell for the organization administration area. This is its own
// application context - it never renders inside the project workspace chrome
// and never requires a project to exist or be selected. The organization
// comes from the authenticated membership plus the org host; owner/admins
// only - everyone else gets not-found, mirroring the API's 404 semantics.
// Shared roster primitives for the section pages also live here.

import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	ArrowLeft,
	Building2,
	Check,
	ChevronsUpDown,
	FolderKanban,
	Loader2,
	Plus,
	ScrollText,
	Settings2,
	ShieldAlert,
	Users,
	type LucideIcon,
} from "lucide-react";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PickerSelect } from "@/components/ui/picker-select";
import { useCreateOrg } from "@/hooks/use-api";
import { setCurrentOrgSlug, useCurrentOrg } from "@/hooks/use-current-org";
import { getTenant, orgOrigin, pathWithoutProjectPrefix, supportsOrgSubdomains } from "@/lib/tenant-host";
import { slugifyRegistryText } from "@/lib/registry-name";
import { cn } from "@/lib/utils";
import { canManageOrganization, hasPermission, PERMISSIONS } from "@/lib/permissions";
import type { Organization } from "@/lib/types";

export const CONTROL_CLASS_NAME =
	"bg-background/80 border-input/90 placeholder:text-muted-foreground/80 hover:border-primary-accent/50 focus-visible:border-primary-accent focus-visible:ring-primary-accent/30";

const ROLE_BADGE: Record<string, string> = {
	owner: "text-primary-accent",
	admin: "text-success",
	lead: "text-primary-accent",
};

export function canAdministerOrg(org?: Organization | null) {
	return canManageOrganization(org);
}

export function MemberRoleBadge({ role }: { role: string }) {
	return (
		<Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-medium capitalize", ROLE_BADGE[role])}>
			{role}
		</Badge>
	);
}

export function SectionHeading({ title, description }: { title: string; description?: string }) {
	return (
		<div className="min-w-0">
			<h2 className="text-[13px] font-semibold uppercase tracking-wider text-foreground/80">{title}</h2>
			{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
		</div>
	);
}

export function memberBody(identity: string, role: string) {
	const body: Record<string, string> = { role };
	if (identity.includes("@") && !identity.startsWith("@")) body.email = identity.toLowerCase();
	else body.username = identity.replace(/^@/, "");
	return body;
}

export function AddMemberRow({
	roles,
	pending,
	label = "Add",
	onAdd,
}: {
	roles: { value: string; label: string }[];
	pending: boolean;
	label?: string;
	onAdd: (identity: string, role: string) => void;
}) {
	const [identity, setIdentity] = useState("");
	const [role, setRole] = useState(roles[roles.length - 1].value);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Input
				value={identity}
				onChange={(e) => setIdentity(e.target.value)}
				placeholder="email or @username"
				className={cn("h-8 w-56 text-sm", CONTROL_CLASS_NAME)}
			/>
			<PickerSelect value={role} onValueChange={setRole} options={roles} className="w-28" ariaLabel="Member role" />
			<Button
				size="sm"
				variant="outline"
				disabled={!identity.trim() || pending}
				onClick={() => {
					onAdd(identity.trim(), role);
					setIdentity("");
				}}
			>
				{pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
				{label}
			</Button>
		</div>
	);
}

function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const createOrg = useCreateOrg();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugEdited, setSlugEdited] = useState(false);
	const effectiveSlug = slugEdited ? slug : slugifyRegistryText(name, { maxLength: 32 });

	function submit() {
		createOrg.mutate(
			{ name: name.trim(), slug: effectiveSlug },
			{
				onSuccess: (org) => {
					onOpenChange(false);
					// Enter the new organization at its own origin.
					if (supportsOrgSubdomains(window.location.hostname)) {
						window.location.assign(`${orgOrigin(org.slug)}/organization`);
					}
				},
			},
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New organization</DialogTitle>
					<DialogDescription>
						Creates a separate tenant with its own members, projects, and administration.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div>
						<Label htmlFor="org-name" className="text-xs">
							Name
						</Label>
						<Input
							id="org-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Acme Inc"
							className={cn("mt-1 h-8 text-sm", CONTROL_CLASS_NAME)}
						/>
					</div>
					<div>
						<Label htmlFor="org-slug" className="text-xs">
							Organization id
						</Label>
						<Input
							id="org-slug"
							value={effectiveSlug}
							onChange={(e) => {
								setSlug(e.target.value);
								setSlugEdited(true);
							}}
							placeholder="acme"
							className={cn("mt-1 h-8 font-mono text-sm", CONTROL_CLASS_NAME)}
						/>
						<p className="mt-1 text-[11px] text-muted-foreground">
							Single lowercase label; becomes the organization subdomain.
						</p>
					</div>
				</div>
				<DialogFooter>
					<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button size="sm" onClick={submit} disabled={!name.trim() || !effectiveSlug || createOrg.isPending}>
						{createOrg.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
						Create organization
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface OrgSection {
	to: string;
	label: string;
	description: string;
	icon: LucideIcon;
	exact: boolean;
	visible: boolean;
}

function sectionsFor(org: Organization): OrgSection[] {
	return [
		{
			to: "/organization",
			label: "General",
			description: "Profile, identity, and lifecycle",
			icon: Settings2,
			exact: true,
			visible: hasPermission(org, PERMISSIONS.orgUpdate),
		},
		{
			to: "/organization/members",
			label: "Members",
			description: "Roster, roles, and invitations",
			icon: Users,
			exact: false,
			visible: hasPermission(org, PERMISSIONS.orgMembersManage),
		},
		{
			to: "/organization/projects",
			label: "Projects",
			description: "Projects and their access",
			icon: FolderKanban,
			exact: false,
			visible: hasPermission(org, PERMISSIONS.orgProjectsManage),
		},
		{
			to: "/organization/audit-log",
			label: "Audit",
			description: "Administrative activity",
			icon: ScrollText,
			exact: false,
			visible: hasPermission(org, PERMISSIONS.orgAuditRead),
		},
		{
			to: "/organization/security-events",
			label: "Security",
			description: "Security-relevant changes",
			icon: ShieldAlert,
			exact: false,
			visible: hasPermission(org, PERMISSIONS.orgSecurityRead),
		},
	].filter((section) => section.visible);
}

/** The active org, guaranteed administered by the caller (shell gates it). */
export function useAdministeredOrg(): Organization | undefined {
	const { currentOrg } = useCurrentOrg();
	return currentOrg && canAdministerOrg(currentOrg) ? currentOrg : undefined;
}

function OrgIdentity({
	org,
	orgs,
	onSwitch,
	onCreate,
}: {
	org: Organization;
	orgs: Organization[];
	onSwitch: (slug: string) => void;
	onCreate: () => void;
}) {
	const identity = (
		<div className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
			<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary-accent/25 bg-primary-accent/10 text-primary-accent">
				<Building2 className="h-4.5 w-4.5" />
			</div>
			<div className="min-w-0">
				<p className="truncate text-sm font-semibold leading-tight">{org.name}</p>
				<p className="truncate font-mono text-[11px] text-muted-foreground">{org.slug}</p>
			</div>
		</div>
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="Switch organization"
					className="flex w-full items-center gap-2 rounded-md p-1.5 transition-colors hover:bg-accent/40"
				>
					{identity}
					<ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
					Your organizations
				</DropdownMenuLabel>
				<div className="max-h-72 overflow-y-auto overscroll-contain">
					{orgs.map((candidate) => (
						<DropdownMenuItem
							key={candidate.slug}
							onSelect={() => {
								if (candidate.slug !== org.slug) onSwitch(candidate.slug);
							}}
							className="gap-2"
						>
							<span className="min-w-0 flex-1 truncate">{candidate.name}</span>
							{candidate.role && <MemberRoleBadge role={candidate.role} />}
							{candidate.slug === org.slug && <Check className="h-3.5 w-3.5 text-primary-accent" />}
						</DropdownMenuItem>
					))}
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onCreate} className="gap-2">
					<Plus className="h-3.5 w-3.5" />
					New organization
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function SectionNavLink({ section, compact }: { section: OrgSection; compact?: boolean }) {
	return (
		<Link
			to={section.to}
			activeOptions={{ exact: section.exact }}
			className={cn(
				"flex items-center gap-2.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground",
				compact ? "shrink-0 px-2.5 py-1.5" : "px-2.5 py-2",
			)}
			activeProps={{
				className: "bg-primary-accent/10 text-foreground font-medium",
				"aria-current": "page",
			}}
		>
			<section.icon className="h-4 w-4 shrink-0" />
			<span className="min-w-0">
				<span className="block truncate leading-tight">{section.label}</span>
				{!compact && (
					<span className="block truncate text-[11px] font-normal leading-tight text-muted-foreground">
						{section.description}
					</span>
				)}
			</span>
		</Link>
	);
}

export default function OrganizationShell() {
	const { currentOrg, orgs, isLoading, selectionInvalid } = useCurrentOrg();
	const pathname = useLocation({ select: (location) => location.pathname });
	const [creating, setCreating] = useState(false);
	const sections = currentOrg ? sectionsFor(currentOrg) : [];
	const organizationPath = pathWithoutProjectPrefix(pathname, getTenant().urlProject);
	const activeSection = sections.find((section) =>
		section.exact ? organizationPath === section.to : organizationPath.startsWith(section.to),
	);

	function switchOrganization(slug: string) {
		setCurrentOrgSlug(slug);
		if (supportsOrgSubdomains(window.location.hostname) && slug !== getTenant().hostOrg) {
			window.location.assign(`${orgOrigin(slug)}${window.location.pathname}${window.location.search}`);
		}
	}

	// Organization administration is org-scoped, never project-scoped: on an
	// org host it lives at {org}.{host}/organization/… - strip a stray project
	// prefix ({org}.{host}/{project}/organization) once, preserving the section.
	useEffect(() => {
		const { urlProject } = getTenant();
		if (!urlProject) return;
		const rest = pathWithoutProjectPrefix(window.location.pathname, urlProject);
		window.location.replace(`${rest}${window.location.search}`);
	}, []);

	if (isLoading) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 py-10">
				<TableSkeleton rows={5} />
			</div>
		);
	}

	// No active org, a revoked selection, or no administrative role: this
	// surface does not exist for the caller (mirrors the API's 404 semantics).
	if (!currentOrg || selectionInvalid || !canAdministerOrg(currentOrg)) {
		return <NotFoundState />;
	}

	return (
		<div className="flex min-h-svh w-full bg-background">
			<aside className="sticky top-0 hidden h-svh w-64 shrink-0 flex-col border-r border-border bg-card/30 md:flex">
				<div className="border-b border-border/70 p-3">
					<OrgIdentity org={currentOrg} orgs={orgs} onSwitch={switchOrganization} onCreate={() => setCreating(true)} />
					<div className="mt-2 flex items-center gap-1.5 px-1.5">
						<span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Organization admin</span>
						<MemberRoleBadge role={currentOrg.role ?? "member"} />
					</div>
				</div>
				<nav aria-label="Organization sections" className="flex flex-col gap-0.5 p-2">
					{sections.map((section) => (
						<SectionNavLink key={section.to} section={section} />
					))}
				</nav>
				<div className="mt-auto border-t border-border/70 p-2">
					{/* Plain anchor: leaving admin re-enters the project workspace shell,
					    which re-resolves the canonical {org}/{project} URL itself. */}
					<a
						href="/"
						className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
					>
						<ArrowLeft className="h-4 w-4" />
						Back to workspace
					</a>
				</div>
			</aside>

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="border-b border-border/70 px-4 py-3 md:hidden">
					<div className="flex items-center justify-between gap-3">
						<OrgIdentity org={currentOrg} orgs={orgs} onSwitch={switchOrganization} onCreate={() => setCreating(true)} />
						<a href="/" aria-label="Back to workspace" className="text-muted-foreground hover:text-foreground">
							<ArrowLeft className="h-4 w-4" />
						</a>
					</div>
					<nav aria-label="Organization sections" className="mt-2 flex gap-1 overflow-x-auto">
						{sections.map((section) => (
							<SectionNavLink key={section.to} section={section} compact />
						))}
					</nav>
				</header>
				{activeSection && (
					<header className="border-b border-border/70 px-4 py-5 sm:px-6 lg:px-8">
						<div className="flex items-center gap-3">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
								<activeSection.icon className="h-4 w-4" />
							</div>
							<div className="min-w-0">
								<h1 className="font-display text-lg text-foreground">{activeSection.label}</h1>
								<p className="mt-0.5 text-xs text-muted-foreground">{activeSection.description}</p>
							</div>
						</div>
					</header>
				)}
				<main className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8">
					<Outlet />
				</main>
			</div>

			<CreateOrgDialog open={creating} onOpenChange={setCreating} />
		</div>
	);
}
