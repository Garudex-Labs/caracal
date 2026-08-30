// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Application-side onboarding gate: authenticated users whose server-derived
// setup state is incomplete are moved into the onboarding namespace before
// any app surface renders. The client never decides access - it only relays
// the server's answer; a manual URL cannot skip a required stage.

import { useEffect } from "react";
import { useOnboardingState } from "@/hooks/use-onboarding";
import { onboardingStagePath } from "@/lib/onboarding";
import { currentPathAsNext } from "@/lib/safe-next";
import { Button } from "@/components/ui/button";

export function OnboardingGate({ children }: { children: React.ReactNode }) {
	const query = useOnboardingState();
	const step = query.data?.next_step;
	const mustOnboard = !!step && step !== "done";

	useEffect(() => {
		if (!mustOnboard || !step) return;
		// Hard navigation: /onboarding lives outside the project basepath.
		// The interrupted destination rides along so finishing setup returns here.
		const next = currentPathAsNext();
		const target = onboardingStagePath(step);
		window.location.replace(next ? `${target}?next=${encodeURIComponent(next)}` : target);
	}, [mustOnboard, step]);

	if (query.isError) {
		return (
			<div className="flex h-screen w-full flex-col items-center justify-center gap-3 bg-background">
				<p className="text-sm text-muted-foreground">Could not confirm your workspace setup.</p>
				<Button variant="outline" size="sm" onClick={() => query.refetch()}>
					Retry
				</Button>
			</div>
		);
	}
	if (query.isLoading || mustOnboard) {
		return <div className="flex h-screen w-full items-center justify-center" aria-busy="true" />;
	}
	return <>{children}</>;
}
