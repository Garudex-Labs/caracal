// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Settings search: finds sections and individual settings across the whole
// settings area and deep-links straight to the anchored control. The
// `header` variant is a compact field whose results float over the page, so
// it stays available on every settings route.

import { useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CornerDownLeft } from "lucide-react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	SETTINGS_SEARCH_ENTRIES,
	sectionById,
	visibleSettingsSections,
	scopeLabel,
} from "@/lib/settings-index";
import { cn } from "@/lib/utils";
import { useCurrentRole } from "./settings-shell";

export function SettingsSearch({
	autoFocus = false,
	variant = "inline",
}: {
	autoFocus?: boolean;
	variant?: "inline" | "header";
}) {
	const router = useRouter();
	const role = useCurrentRole();
	const [query, setQuery] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);
	const sections = visibleSettingsSections(role);
	const sectionIds = new Set(sections.map((s) => s.id));
	const entries = SETTINGS_SEARCH_ENTRIES.filter((e) => sectionIds.has(e.sectionId));

	const open = query.trim().length > 0;
	const isHeader = variant === "header";

	function goTo(to: string, hash?: string) {
		setQuery("");
		router.navigate(hash ? { to, hash } : { to });
	}

	return (
		<div
			ref={rootRef}
			className={cn(isHeader && "relative w-full max-w-64 sm:max-w-80")}
			onBlur={(e) => {
				// Close the floating results when focus leaves the search entirely.
				if (isHeader && !rootRef.current?.contains(e.relatedTarget as Node)) setQuery("");
			}}
		>
			<Command
				shouldFilter
				className={cn(
					"h-auto overflow-visible rounded-md border border-border",
					isHeader ? "bg-transparent [&_[cmdk-input-wrapper]]:border-b-0" : "bg-card",
				)}
				aria-label="Search settings"
			>
				<CommandInput
					autoFocus={autoFocus}
					value={query}
					onValueChange={setQuery}
					placeholder="Search settings…"
					className={cn("text-sm", isHeader ? "h-8 text-xs" : "h-9")}
					onKeyDown={(e) => {
						if (e.key === "Escape") setQuery("");
					}}
				/>
				{open && (
					<CommandList
						className={cn(
							"max-h-72",
							isHeader
								? "absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-border bg-popover shadow-md"
								: "border-t border-border",
						)}
					>
						<CommandEmpty className="py-5 text-center text-xs text-muted-foreground">
							No settings match “{query.trim()}”.
						</CommandEmpty>
						<CommandGroup heading="Sections">
							{sections.map((section) => (
								<CommandItem
									key={section.id}
									value={`${section.title} ${section.description}`}
									onSelect={() => goTo(section.to)}
								>
									<section.icon className="text-muted-foreground" />
									<span className="font-medium">{section.title}</span>
									<span className="truncate text-xs text-muted-foreground">{section.description}</span>
									<span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/70">
										{scopeLabel(section.scope)}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
						<CommandGroup heading="Settings">
							{entries.map((entry) => {
								const section = sectionById(entry.sectionId);
								if (!section) return null;
								return (
									<CommandItem
										key={`${entry.sectionId}-${entry.title}`}
										value={`${entry.title} ${section.title} ${entry.keywords.join(" ")}`}
										onSelect={() => goTo(section.to, entry.hash)}
									>
										<CornerDownLeft className="text-muted-foreground/50" />
										<span>{entry.title}</span>
										<span className="truncate text-xs text-muted-foreground">
											{section.title}
										</span>
										<span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/70">
											{scopeLabel(section.scope)}
										</span>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				)}
			</Command>
		</div>
	);
}
