// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// /onboarding resolver: reads the authoritative snapshot and moves the user
// to the stage they are actually at, or - when setup is complete - into the
// valid org/project context. All sign-in completions land here, so a fully
// onboarded user passes straight through into the application.

import { useEffect } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { enterApp, useOnboardingState } from "@/hooks/use-onboarding";
import { getRememberedOrgSlug } from "@/hooks/use-current-org";
import { rememberedProjectMap } from "@/hooks/use-current-project";
import { onboardingStagePath, resolveEntry } from "@/lib/onboarding";
import { StagePending } from "@/pages/onboarding/shell";

export default function OnboardingResolvePage() {
	const query = useOnboardingState();
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as { next?: string; invite?: string };

	useEffect(() => {
		const snap = query.data;
		if (!snap) return;
		// An invitation link resolves on the organization stage regardless of
		// how far along the account already is.
		if (search.invite) {
			navigate({ to: "/onboarding/organization", replace: true, search: (prev) => prev });
			return;
		}
		if (snap.next_step !== "done") {
			navigate({ to: onboardingStagePath(snap.next_step), replace: true, search: (prev) => prev });
			return;
		}
		const target = resolveEntry(snap, getRememberedOrgSlug(), rememberedProjectMap());
		if (!target) {
			// Several valid contexts and no remembered one: explicit selection.
			navigate({ to: "/onboarding/project", replace: true, search: (prev) => prev });
			return;
		}
		const destination = enterApp(target, search.next);
		if (destination !== null) navigate({ to: destination, replace: true });
	}, [query.data, navigate, search.invite, search.next]);

	if (query.isError) {
		return (
			<div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
				<p className="text-sm text-muted-foreground">Could not load your setup state.</p>
				<Button variant="outline" size="sm" onClick={() => query.refetch()}>
					Retry
				</Button>
			</div>
		);
	}
	return <StagePending />;
}
