// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Repository-style workspace navigation for a resource detail page. The active
// view lives in the `?view=` search param so every subsection of a resource is
// deep-linkable while the page itself stays one stable canonical URL.

import { useNavigate, useSearch } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";

export interface WorkspaceTab {
	id: string;
	label: string;
	icon?: LucideIcon;
	count?: number;
	/** Accent the count badge (e.g. open issues / pending changes). */
	attention?: boolean;
	hidden?: boolean;
}

export function useWorkspaceView(defaultView = "overview") {
	const search = useSearch({ strict: false }) as { view?: string };
	const navigate = useNavigate();
	const view = search.view ?? defaultView;
	const setView = (next: string) =>
		navigate({
			to: ".",
			replace: false,
			search: (prev: Record<string, unknown>) => ({
				...prev,
				view: next === defaultView ? undefined : next,
			}),
		});
	return { view, setView };
}

export function WorkspaceTabBar({
	tabs,
	active,
	onSelect,
}: {
	tabs: WorkspaceTab[];
	active: string;
	onSelect: (id: string) => void;
}) {
	return (
		<nav
			aria-label="Resource sections"
			className="flex items-center gap-0.5 overflow-x-auto border-b border-border"
		>
			{tabs
				.filter((tab) => !tab.hidden)
				.map((tab) => {
					const Icon = tab.icon;
					const isActive = tab.id === active;
					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => onSelect(tab.id)}
							aria-current={isActive ? "page" : undefined}
							className={`relative -mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
								isActive
									? "border-primary font-medium text-foreground"
									: "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
							}`}
						>
							{Icon && <Icon className="h-3.5 w-3.5" />}
							{tab.label}
							{tab.count != null && tab.count > 0 && (
								<span
									className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
										tab.attention
											? "bg-warning/15 text-warning"
											: "bg-muted text-muted-foreground"
									}`}
								>
									{tab.count}
								</span>
							)}
						</button>
					);
				})}
		</nav>
	);
}
