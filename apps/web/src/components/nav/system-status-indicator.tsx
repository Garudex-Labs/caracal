// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Compact top-bar system health indicator (admins only - the status endpoint
// is admin-gated server-side). Reflects the authoritative aggregate from
// /admin/status and links to the status center. Green / yellow / red, with an
// accessible label; failing to reach the endpoint reads as degraded, never
// as healthy.

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useSystemStatus } from "@/hooks/use-api";
import { hasMinRole } from "@/hooks/use-role-guard";
import { getUserRole } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<string, string> = {
	healthy: "text-success",
	degraded: "text-warning",
	critical: "text-destructive",
};

const STATE_LABEL: Record<string, string> = {
	healthy: "Healthy",
	degraded: "Degraded",
	critical: "Critical",
};

export function SystemStatusIndicator() {
	const isAdmin = hasMinRole(getUserRole(), "operator");
	const status = useSystemStatus({ enabled: isAdmin, refetchInterval: 60_000 });
	if (!isAdmin) return null;

	// An unreachable status endpoint must not present as healthy.
	const state = status.isError ? "degraded" : (status.data?.overall ?? "unknown");
	const label = `System status: ${STATE_LABEL[state] ?? "Checking…"}`;

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					{/* Plain anchor: the operator console is instance-scoped, outside project context. */}
					<a
						href="/operator/status"
						aria-label={label}
						className="flex h-8 w-8 items-center justify-center rounded-md outline-none ring-ring transition-colors hover:bg-accent focus-visible:ring-2"
					>
						{/* Solid pill bars - thicker than lucide's 2px strokes. */}
						<svg
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
							className={cn("h-4 w-4", STATE_STYLE[state] ?? "text-muted-foreground")}
						>
							<rect x="4" y="13" width="4" height="8" rx="2" />
							<rect x="10" y="3" width="4" height="18" rx="2" />
							<rect x="16" y="9" width="4" height="12" rx="2" />
						</svg>
					</a>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="text-xs">
					{label}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
