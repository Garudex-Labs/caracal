// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Thin right-edge utility rail: theme toggle up top, contact and
// issue-reporting actions anchored to the bottom. Icon-only; labels are
// revealed via tooltips on hover and keyboard focus.

import { type ComponentProps, type ElementType } from "react";
import { Bug, Mail, Moon, Sun } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";

const CONTACT_MAILTO = "mailto:support@caracal.run";
const ISSUE_URL = "https://github.com/Garudex-Labs/caracal/issues/new/choose";

const railActionClass =
	"flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground outline-none ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2";

function RailAction<T extends ElementType>({
	as,
	label,
	...props
}: { as: T; label: string } & ComponentProps<T>) {
	const Comp = as as ElementType;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Comp aria-label={label} className={railActionClass} {...props} />
			</TooltipTrigger>
			<TooltipContent side="left">{label}</TooltipContent>
		</Tooltip>
	);
}

function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const isDark = theme !== "light";
	return (
		<RailAction
			as="button"
			type="button"
			label={isDark ? "Switch to light theme" : "Switch to dark theme"}
			onClick={() => setTheme(isDark ? "light" : "dark")}
		>
			{isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
		</RailAction>
	);
}

export function UtilityRail() {
	return (
		<aside
			aria-label="Utilities"
			className="hidden w-10 shrink-0 flex-col items-center border-l border-border bg-background py-2 md:flex"
		>
			<ThemeToggle />
			<div className="mt-auto flex flex-col items-center gap-1">
				<RailAction
					as="a"
					label="Contact us"
					href={CONTACT_MAILTO}
					target="_blank"
					rel="noopener noreferrer"
				>
					<Mail className="h-4 w-4" />
				</RailAction>
				<RailAction
					as="a"
					label="Report an issue"
					href={ISSUE_URL}
					target="_blank"
					rel="noopener noreferrer"
				>
					<Bug className="h-4 w-4" />
				</RailAction>
			</div>
		</aside>
	);
}
