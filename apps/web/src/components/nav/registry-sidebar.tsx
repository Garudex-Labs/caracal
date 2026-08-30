// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useLocation } from "@tanstack/react-router";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";

import {
	Home,
	FolderTree,
	Building2,
	LineChart,
	Activity,
	Settings,
	Server,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import {
	getUserRole,
	getAccessToken,
	getUserName,
	getUserEmail,
	getUserUsername,
} from "@/lib/api";
import { hasMinRole, type Role } from "@/hooks/use-role-guard";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import { useDeploymentConfig } from "@/hooks/use-deployment-config";
import { canManageOrganization } from "@/lib/permissions";
import { projectRoutePath } from "@/lib/tenant-host";

type NavItem = {
	title: string;
	href: string;
	icon: typeof Home;
	projectFree?: boolean;
	requiresAuth?: boolean;
	minRole?: Role;
};

// The project workspace: one resource tree over agents and components and
// analytics. There is no standalone /agents list or /changes queue - agent
// surfaces are contextual (builder, detail) and change review lives on each
// resource's own page.
const registryNav: NavItem[] = [
	{ title: "Home", href: "/", icon: Home },
	{ title: "Resources", href: "/resources", icon: FolderTree },
	{ title: "Intelligence", href: "/intelligence", icon: LineChart },
];

// Personal surfaces only: things the signed-in user authors or owns.
// Building agents is contextual now: /agents/new and /agents/$ns/$slug/edit.
const yourWorkNav: NavItem[] = [
        { title: "My Traces", href: "/traces", icon: Activity, minRole: "user" },
];

// Tenant app only gets a context switch; operator pages have their own shell.
const adminNav: NavItem[] = [
	{
		title: "Operator Console",
		href: "/operator",
		icon: Server,
		projectFree: true,
		minRole: "operator",
	},
];

// Grouped view of the primary navigation, consumed by the command menu.
export const allNavItems = [
	{ group: "Registry", items: registryNav },
	{ group: "Your work", items: yourWorkNav },
	{ group: "Operator", items: adminNav },
];

const storeSub = (cb: () => void) => {
	window.addEventListener("storage", cb);
	return () => window.removeEventListener("storage", cb);
};
const getAuthSnap = () =>
	`${getAccessToken() ?? ""}|${getUserRole() ?? ""}|${getUserName() ?? ""}|${getUserEmail() ?? ""}|${getUserUsername() ?? ""}`;
const getServerSnap = () => "||||";

function NavGroup({
	label,
	items,
	isActive,
	projectSlug,
}: {
	label: string;
	items: NavItem[];
	isActive: (href: string) => boolean;
	projectSlug?: string;
}) {
	if (items.length === 0) return null;
	return (
		<SidebarGroup className="py-1.5">
			<SidebarGroupLabel className="h-7 text-xs font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/55">
				{label}
			</SidebarGroupLabel>
			<SidebarGroupContent>
				<SidebarMenu className="gap-0.5">
					{items.map((item) => (
						<SidebarMenuItem key={item.href}>
							<SidebarMenuButton
								asChild
								isActive={isActive(item.href)}
								tooltip={item.title}
							>
								{item.projectFree ? (
									<a href={item.href}>
										<item.icon className="h-4 w-4" />
										<span>{item.title}</span>
									</a>
								) : (
									<a href={projectRoutePath(projectSlug!, item.href)}>
										<item.icon className="h-4 w-4" />
										<span>{item.title}</span>
									</a>
								)}
							</SidebarMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}

export function RegistrySidebar() {
	const { pathname } = useLocation();
	const snap = useSyncExternalStore(storeSub, getAuthSnap, getServerSnap);
	const [token, role] = snap.split("|");
	const isAuthenticated = !!token;
	// Organization administration is gated by the ACTIVE org's effective
	// permissions, not the deployment role.
	const { currentOrg } = useCurrentOrg();
	const { currentProject, preferredProject } = useCurrentProject();
	const projectSlug = currentProject?.slug ?? preferredProject?.slug;
	const canAdministerActiveOrg = isAuthenticated && canManageOrganization(currentOrg);
	const {
		brandingLogo,
		brandingAppName,
		brandingWordmark,
	} = useDeploymentConfig();

	function isActive(href: string) {
		if (href === "/") return pathname === "/";
		if (pathname === href) return true;
		// Only treat as active if no *more-specific* sibling nav item matches,
		// so a parent entry doesn't light up while a nested entry is open.
		const allHrefs = [...registryNav, ...yourWorkNav, ...adminNav].map(
			(n) => n.href,
		);
		const moreSpecific = allHrefs.some(
			(h) => h !== href && h.startsWith(href + "/") && pathname.startsWith(h),
		);
		if (moreSpecific) return false;
		return pathname.startsWith(href);
	}

	// One rule for every group: auth-only items need a session, role-gated
	// items need the deployment role. Groups whose items all filter out vanish.
	const visible = (items: NavItem[]) =>
		items.filter(
			(item) =>
				(!item.requiresAuth || isAuthenticated) &&
				(!item.minRole || (isAuthenticated && hasMinRole(role, item.minRole))),
		);

	const visibleRegistryNav = projectSlug ? visible(registryNav) : [];
	const visibleYourWorkNav = projectSlug ? visible(yourWorkNav) : [];
	const visibleAdminNav = visible(adminNav);

	return (
		<Sidebar collapsible="icon" className="border-r border-sidebar-border">
			{/* h-12 matches the top bar so both header borders sit on the same line. */}
			<SidebarHeader className="h-12 shrink-0 justify-center border-b border-sidebar-border/70 px-2 py-0">
				<div className="flex items-center gap-1">
					<SidebarMenu className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
						<SidebarMenuItem>
							<SidebarMenuButton asChild>
								<a href={projectSlug ? projectRoutePath(projectSlug, "/") : "/onboarding/project"}>
									<div className="flex size-8 shrink-0 items-center justify-center">
										{brandingLogo ? (
											<img
												src={brandingLogo}
												alt=""
												width={26}
												height={26}
												className="object-contain"
											/>
										) : (
											<img
												src="/caracal_nobg_dark_mode.png"
												alt=""
												width={26}
												height={26}
												className="object-contain"
											/>
										)}
									</div>
									<div className="flex flex-col gap-0.5 leading-none">
										{brandingWordmark ? (
											<img
												src={brandingWordmark}
												alt={brandingAppName || "Caracal"}
												width={140}
												height={20}
												className="h-5 max-w-35 object-contain object-left"
											/>
										) : (
											<span className="text-base font-semibold tracking-tight font-display truncate max-w-35">
												{brandingAppName || "Caracal"}
											</span>
										)}
									</div>
								</a>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
					<SidebarTrigger className="h-7 w-7 shrink-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
				</div>
			</SidebarHeader>
			<SidebarContent className="gap-0 py-1">
				<NavGroup label="Registry" items={visibleRegistryNav} isActive={isActive} projectSlug={projectSlug} />
				<NavGroup label="Your work" items={visibleYourWorkNav} isActive={isActive} projectSlug={projectSlug} />
				<NavGroup label="Operator" items={visibleAdminNav} isActive={isActive} />
			</SidebarContent>
			<SidebarFooter className="border-t border-sidebar-border/70 px-2 py-2">
				{isAuthenticated && (
					<SidebarMenu>
						{canAdministerActiveOrg && (
							<SidebarMenuItem>
								<SidebarMenuButton
									asChild
									isActive={pathname.includes("/organization")}
									tooltip="Organization"
								>
									{/* Plain anchor: org administration lives outside project context. */}
									<a href="/organization">
										<Building2 className="h-4 w-4" />
										<span>Organization</span>
									</a>
								</SidebarMenuButton>
							</SidebarMenuItem>
						)}
						<SidebarMenuItem>
							<SidebarMenuButton
								asChild
								isActive={pathname.startsWith("/settings")}
								tooltip="Settings"
							>
								<a href="/settings">
									<Settings className="h-4 w-4" />
									<span>Settings</span>
								</a>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				)}
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
