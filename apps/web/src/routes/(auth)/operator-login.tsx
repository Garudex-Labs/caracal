// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createFileRoute } from "@tanstack/react-router";
import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";

const OperatorLoginPage = lazy(() => import("@/pages/operator-login"));

function OperatorLoginRoute() {
	return (
		<div className="min-h-dvh bg-background">
			<Suspense fallback={<div className="flex h-screen w-full items-center justify-center" />}>
				<OperatorLoginPage />
			</Suspense>
			<Toaster visibleToasts={1} />
		</div>
	);
}

export const Route = createFileRoute("/(auth)/operator-login")({
	component: OperatorLoginRoute,
});
