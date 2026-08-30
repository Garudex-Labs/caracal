// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Structural primitives for the /settings area: the scope-grouped side nav,
// the page scaffold with scope badge, and anchored sections that settings
// search can deep-link into.

import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { getUserRole } from "@/lib/api";
import {
	SETTINGS_GROUPS,
	visibleSettingsSections,
	scopeLabel,
	type SettingsScope,
} from "@/lib/settings-index";
import { cn } from "@/lib/utils";

function subscribeRole(cb: () => void) {
	window.addEventListener("storage", cb);
	return () => window.removeEventListener("storage", cb);
}

export function useCurrentRole(): string | null {
	return useSyncExternalStore(
		subscribeRole,
		() => getUserRole(),
		() => null,
	);
}

// ── Scope badge ─────────────────────────────────────────────────────────────

const SCOPE_BADGE_CLASS: Record<SettingsScope, string> = {
	account: "border-border text-muted-foreground",
	organization: "border-info/40 text-info",
	instance: "border-warning/40 text-warning",
};

export function ScopeBadge({ scope }: { scope: SettingsScope }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-sm border px-1.5 py-px text-[10px] font-medium uppercase tracking-wider",
				SCOPE_BADGE_CLASS[scope],
			)}
			title={SETTINGS_GROUPS.find((g) => g.scope === scope)?.description}
		>
			{scopeLabel(scope)}
		</span>
	);
}

// ── Side navigation ─────────────────────────────────────────────────────────

export function SettingsNav() {
	const role = useCurrentRole();
	const { pathname } = useLocation();
	const sections = visibleSettingsSections(role);

	return (
		<nav
			aria-label="Settings sections"
			className="hidden w-56 shrink-0 border-r border-border md:block"
		>
			{/* top-14 = the sticky settings header above. */}
			<div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] space-y-5 overflow-y-auto px-3 py-4">
				{SETTINGS_GROUPS.map((group) => {
					const items = sections.filter((s) => s.scope === group.scope);
					if (items.length === 0) return null;
					return (
						<div key={group.scope}>
							<p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
								{group.label}
							</p>
							<ul className="space-y-px">
								{items.map((item) => {
									const isActive = pathname === item.to;
									return (
										<li key={item.id}>
											<Link
												to={item.to}
												aria-current={isActive ? "page" : undefined}
												title={item.description}
												className={cn(
													"flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
													isActive
														? "bg-accent font-medium text-foreground"
														: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
												)}
											>
												<item.icon
													className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-primary-accent" : "text-muted-foreground/70")}
												/>
												<span className="truncate">{item.title}</span>
											</Link>
										</li>
									);
								})}
							</ul>
						</div>
					);
				})}
			</div>
		</nav>
	);
}

/** Horizontal section strip for viewports where the side nav is hidden. */
export function SettingsMobileNav() {
	const role = useCurrentRole();
	const { pathname } = useLocation();
	const sections = visibleSettingsSections(role);

	return (
		<nav
			aria-label="Settings sections"
			className="overflow-x-auto border-b border-border px-2 md:hidden"
		>
			<ul className="flex h-10 w-max min-w-full items-end gap-4 px-2">
				{sections.map((item) => {
					const isActive = pathname === item.to;
					return (
						<li key={item.id} className="h-full">
							<Link
								to={item.to}
								aria-current={isActive ? "page" : undefined}
								className={cn(
									"inline-flex h-full items-center border-b-2 border-transparent px-0.5 text-xs font-medium whitespace-nowrap transition-colors",
									isActive
										? "border-primary-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{item.title}
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

// ── Page scaffold ───────────────────────────────────────────────────────────

interface SettingsPageProps {
	title: string;
	description?: string;
	scope: SettingsScope;
	actions?: React.ReactNode;
	children: React.ReactNode;
}

/** Scrolls to and briefly highlights the section referenced by the URL hash. */
function useSectionAnchor() {
	const { hash } = useLocation();
	useEffect(() => {
		const id = hash?.replace(/^#/, "");
		if (!id) return;
		// Let lazy content mount before resolving the anchor.
		const timer = window.setTimeout(() => {
			const el = document.getElementById(id);
			if (!el) return;
			el.scrollIntoView({ behavior: "smooth", block: "start" });
			el.classList.add("settings-anchor-highlight");
			window.setTimeout(() => el.classList.remove("settings-anchor-highlight"), 1600);
		}, 80);
		return () => window.clearTimeout(timer);
	}, [hash]);
}

export function SettingsPage({ title, description, scope, actions, children }: SettingsPageProps) {
	useSectionAnchor();
	return (
		<div className="min-w-0 flex-1">
			<header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2.5">
						<h1 className="text-lg font-semibold tracking-tight">{title}</h1>
						<ScopeBadge scope={scope} />
					</div>
					{description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
				</div>
				{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			</header>
			<div className="space-y-8 py-6">{children}</div>
		</div>
	);
}

// ── Sections and rows ───────────────────────────────────────────────────────

interface SettingsSectionProps {
	id: string;
	title: string;
	description?: React.ReactNode;
	/** Renders the title in destructive styling for dangerous groups. */
	danger?: boolean;
	actions?: React.ReactNode;
	children: React.ReactNode;
}

export function SettingsSection({ id, title, description, danger, actions, children }: SettingsSectionProps) {
	return (
		<section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-20 rounded-md transition-shadow">
			<div className="mb-2.5 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2
						id={`${id}-heading`}
						className={cn(
							"text-[13px] font-semibold uppercase tracking-wider",
							danger ? "text-destructive" : "text-foreground/80",
						)}
					>
						{title}
					</h2>
					{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
				</div>
				{actions && <div className="shrink-0">{actions}</div>}
			</div>
			{children}
		</section>
	);
}

/** Bordered container that stacks `SettingRow`s with hairline separators. */
export function SettingsCard({ className, children }: { className?: string; children: React.ReactNode }) {
	return (
		<div className={cn("divide-y divide-border rounded-md border border-border bg-card", className)}>
			{children}
		</div>
	);
}

interface SettingRowProps {
	label: React.ReactNode;
	description?: React.ReactNode;
	/** Control rendered on the right (switch, button, value…). */
	children?: React.ReactNode;
	/** Stacks the control under the text instead of beside it. */
	stacked?: boolean;
	htmlFor?: string;
}

export function SettingRow({ label, description, children, stacked, htmlFor }: SettingRowProps) {
	const text = (
		<div className="min-w-0 flex-1">
			{htmlFor ? (
				<label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
					{label}
				</label>
			) : (
				<p className="text-sm font-medium text-foreground">{label}</p>
			)}
			{description && <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</div>}
		</div>
	);

	if (stacked) {
		return (
			<div className="space-y-2.5 px-4 py-3">
				{text}
				{children}
			</div>
		);
	}
	return (
		<div className="flex items-center justify-between gap-4 px-4 py-3">
			{text}
			{children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
		</div>
	);
}
