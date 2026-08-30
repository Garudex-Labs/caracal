// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Settings home: a scope-grouped directory of every section the current
// role can open. Search lives in the persistent settings header.

import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useCurrentRole } from "@/components/settings/settings-shell";
import { SETTINGS_GROUPS, visibleSettingsSections } from "@/lib/settings-index";

export default function SettingsIndexPage() {
	const role = useCurrentRole();
	const sections = visibleSettingsSections(role);

	return (
		<div className="min-w-0 flex-1">
			<header className="border-b border-border pb-4">
				<h1 className="text-lg font-semibold tracking-tight">Settings</h1>
				<p className="mt-1 text-[13px] text-muted-foreground">
					Configuration for your account, this organization, and the instance itself.
				</p>
			</header>

			<div className="space-y-8 py-6">
				{SETTINGS_GROUPS.map((group) => {
					const items = sections.filter((s) => s.scope === group.scope);
					if (items.length === 0) return null;
					return (
						<section key={group.scope} aria-label={group.label}>
							<div className="mb-2">
								<h2 className="text-[13px] font-semibold uppercase tracking-wider text-foreground/80">
									{group.label}
								</h2>
								<p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
							</div>
							<div className="divide-y divide-border rounded-md border border-border bg-card">
								{items.map((item) => (
									<Link
										key={item.id}
										to={item.to}
										className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<p className="text-sm font-medium text-foreground">{item.title}</p>
											<p className="truncate text-xs text-muted-foreground">{item.description}</p>
										</div>
										<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
									</Link>
								))}
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}
