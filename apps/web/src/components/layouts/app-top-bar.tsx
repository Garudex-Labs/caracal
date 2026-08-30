// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Application chrome: sidebar toggle and global search on the left,
// user-level controls (inbox, account) on the right.

import { useSyncExternalStore } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronRight, HelpCircle, Inbox, Search } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NavUser } from "@/components/nav/nav-user";
import { ProjectSwitcher } from "@/components/nav/project-switcher";
import { SystemStatusIndicator } from "@/components/nav/system-status-indicator";
import { openCommandMenu } from "@/components/nav/command-menu";
import { usePageChrome } from "@/components/layouts/page-chrome";
import { useHelp } from "@/components/help/help-context";
import { useInboxCounts } from "@/hooks/use-inbox-api";
import { useCurrentProject } from "@/hooks/use-current-project";
import { getUserEmail, getUserName, getUserUsername } from "@/lib/api";
import { projectRoutePath } from "@/lib/tenant-host";
import { cn } from "@/lib/utils";

const storeSub = (cb: () => void) => {
	window.addEventListener("storage", cb);
	return () => window.removeEventListener("storage", cb);
};
const getUserSnap = () =>
	`${getUserName() ?? ""}|${getUserEmail() ?? ""}|${getUserUsername() ?? ""}`;
const getServerSnap = () => "||";

// Unread state is a quiet dot rather than a count: the count lives on the
// Inbox page itself, and a number in the chrome goes stale between polls.
function InboxButton() {
	const { pathname } = useLocation();
	const { currentProject, preferredProject } = useCurrentProject();
	const projectSlug = currentProject?.slug ?? preferredProject?.slug;
	const { data: counts } = useInboxCounts(true);
	const unread = counts?.unread ?? 0;
	const active = pathname === "/inbox" || pathname.endsWith("/inbox");
	const label = unread > 0 ? `Inbox - ${unread} unread` : "Inbox";
	if (!projectSlug) return null;

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<a
						href={projectRoutePath(projectSlug, "/inbox")}
						aria-label={label}
						aria-current={active ? "page" : undefined}
						className={cn(
							"relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground outline-none ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2",
							active && "bg-accent text-foreground",
						)}
					>
						<Inbox className="h-4 w-4" />
						{unread > 0 && (
							<span
								aria-hidden="true"
								className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background"
							/>
						)}
					</a>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="text-xs">
					{label}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

// Contextual docs trigger; opens the overlay help panel without reserving layout space.
function PageHelpButton({ helpKey }: { helpKey: string }) {
	const { openHelp } = useHelp();
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label="Page documentation"
						onClick={() => openHelp({ pageKey: helpKey })}
						className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground outline-none ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2"
					>
						<HelpCircle className="h-4 w-4" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="text-xs">
					Page documentation
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

export function AppTopBar() {
	const snap = useSyncExternalStore(storeSub, getUserSnap, getServerSnap);
	const [userName, userEmail, userUsername] = snap.split("|");
	const { chrome } = usePageChrome();

	return (
		<header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2 sm:px-3">
			{/* Desktop collapse control lives in the sidebar; keep one reachable on mobile. */}
			<SidebarTrigger className="md:hidden" />

			<ProjectSwitcher className="hidden sm:flex" />

			<button
				type="button"
				onClick={openCommandMenu}
				aria-label="Search (Ctrl+K)"
				className="flex h-8 w-full max-w-xs items-center gap-2 rounded-md border border-border px-2.5 text-sm text-muted-foreground outline-none ring-ring transition-colors hover:border-input hover:text-foreground focus-visible:ring-2 sm:max-w-sm"
			>
				<Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
				<span className="flex-1 truncate text-left text-xs">
					Search agents, components, traces…
				</span>
				<kbd className="hidden shrink-0 rounded-sm border border-border px-1 font-mono text-[10px] leading-4 text-muted-foreground sm:inline-block">
					⌘K
				</kbd>
			</button>

			{/* Authoritative overall health, between search and the page context. */}
			<SystemStatusIndicator />

			{chrome.title && (
				<nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 sm:flex">
					<div aria-hidden="true" className="mr-0.5 h-4 w-px shrink-0 bg-border" />
					<ol className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						{(chrome.breadcrumbs ?? []).map((crumb, index) => (
							<li key={`${crumb.label}-${index}`} className="hidden min-w-0 items-center gap-1.5 lg:inline-flex">
								{crumb.href ? (
									<Link
										to={crumb.href}
										className="truncate underline-offset-4 hover:text-foreground hover:underline"
									>
										{crumb.label}
									</Link>
								) : (
									<span className="truncate">{crumb.label}</span>
								)}
								<ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground/60" />
							</li>
						))}
						<li aria-current="page" className="min-w-0 truncate text-sm font-medium text-foreground">
							{chrome.title}
						</li>
					</ol>
				</nav>
			)}

			<div className="ml-auto flex items-center gap-1">
				{chrome.helpKey && <PageHelpButton helpKey={chrome.helpKey} />}
				<InboxButton />
				<div aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
				<NavUser
					user={{
						name: userName || "User",
						email: userEmail || "",
						username: userUsername || undefined,
					}}
				/>
			</div>
		</header>
	);
}
