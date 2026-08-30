// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Layout for the /settings namespace. The area header (title + settings
// search) and the attached left nav persist across every settings route;
// only the outlet re-renders on navigation.

import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { PageHeader } from "@/components/layouts/page-header";
import { SettingsMobileNav, SettingsNav } from "@/components/settings/settings-shell";
import { SettingsSearch } from "@/components/settings/settings-search";
import { SETTINGS_SECTIONS } from "@/lib/settings-index";

function SettingsLayout() {
	const { pathname } = useLocation();
	const section = SETTINGS_SECTIONS.find((s) => s.to === pathname.replace(/\/$/, ""));

	return (
		<>
			<PageHeader
				title={section ? section.title : "Settings"}
				breadcrumbs={section ? [{ label: "Settings", href: "/settings" }] : []}
			/>
			<div className="flex min-h-[calc(100dvh-3rem)] flex-col">
				<header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-4 sm:px-6">
					<h1 className="font-[family-name:var(--font-display)] text-lg text-foreground">Settings</h1>
					<SettingsSearch variant="header" />
				</header>
				<SettingsMobileNav />
				<div className="flex flex-1 items-stretch">
					<SettingsNav />
					<main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
						<div className="w-full max-w-4xl">
							<Outlet />
						</div>
					</main>
				</div>
			</div>
		</>
	);
}

export const Route = createFileRoute("/_authed/settings")({
	component: SettingsLayout,
});
