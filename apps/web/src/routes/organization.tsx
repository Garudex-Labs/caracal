// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Layout for the organization administration area. This is a root sibling of
// the project workspace (_authed): it establishes organization scope from the
// authenticated membership + org host and never renders the project sidebar,
// top bar, or any project-scoped chrome or state.

import { createFileRoute, Navigate } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AuthGuard } from "@/components/layouts/auth-guard";
import { Toaster } from "@/components/ui/sonner";

const OrganizationShell = lazy(() => import("@/pages/organization/shell"));

function OrganizationAdminLayout() {
	return (
		<AuthGuard>
			<Suspense fallback={<div className="flex h-svh w-full items-center justify-center" />}>
				<OrganizationShell />
			</Suspense>
			<Toaster visibleToasts={1} />
		</AuthGuard>
	);
}

export const Route = createFileRoute("/organization")({
	component: OrganizationAdminLayout,
	notFoundComponent: () => <Navigate to="/organization" replace />,
});
