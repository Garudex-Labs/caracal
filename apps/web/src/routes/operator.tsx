// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AuthGuard } from "@/components/layouts/auth-guard";
import { RoleGuard } from "@/components/layouts/role-guard";
import { PageChromeProvider } from "@/components/layouts/page-chrome";
import { OperatorSidebar } from "@/components/nav/operator-sidebar";
import { RetentionWarningBanner } from "@/components/shared/retention-warning-banner";
import { Toaster } from "@/components/ui/sonner";

// Operator auth must not pass through tenant onboarding or project context.
function OperatorLayout() {
	return (
		<AuthGuard context="operator">
			<RoleGuard minRole="operator" context="operator">
				<PageChromeProvider>
					<SidebarProvider>
						<OperatorSidebar />
						<div className="flex min-w-0 flex-1 flex-col">
							<header className="flex h-12 shrink-0 items-center border-b border-border/70 px-4">
								<div>
									<p className="text-sm font-semibold tracking-tight">Operator Console</p>
									<p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Deployment control plane</p>
								</div>
							</header>
							<RetentionWarningBanner />
							<SidebarInset>
								<Suspense fallback={<div className="flex h-full w-full items-center justify-center" />}>
									<Outlet />
								</Suspense>
							</SidebarInset>
						</div>
						<Toaster visibleToasts={1} />
					</SidebarProvider>
				</PageChromeProvider>
			</RoleGuard>
		</AuthGuard>
	);
}

export const Route = createFileRoute("/operator")({
	component: OperatorLayout,
	notFoundComponent: () => <Navigate to="/operator" replace />,
});
