// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The onboarding namespace: authenticated, but rendered without the app
// chrome because no valid org/project context exists yet. Children are the
// explicit setup stages; /onboarding itself only resolves and redirects.

import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AuthGuard } from "@/components/layouts/auth-guard";
import { OnboardingShell } from "@/pages/onboarding/shell";

export const Route = createFileRoute("/onboarding")({
	validateSearch: (search: Record<string, unknown>): { next?: string; invite?: string } => ({
		...(typeof search.next === "string" ? { next: search.next } : {}),
		...(typeof search.invite === "string" ? { invite: search.invite } : {}),
	}),
	component: () => (
		<AuthGuard>
			<OnboardingShell>
				<Outlet />
			</OnboardingShell>
		</AuthGuard>
	),
});
