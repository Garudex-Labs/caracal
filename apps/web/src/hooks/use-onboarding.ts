// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Onboarding state and stage transitions. The server is the only authority:
// GET /api/v1/onboarding derives the user's setup position from profile,
// membership, and project-access tables, and every stage renders or redirects
// off that snapshot. Client storage only remembers preferences (last org and
// project), never grants anything.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { onboarding } from "@/lib/api";
import { onboardingStagePath, type EntryTarget } from "@/lib/onboarding";
import { tenantNext } from "@/lib/safe-next";
import { orgOrigin, projectEntryPath, supportsOrgSubdomains } from "@/lib/tenant-host";
import { setCurrentOrgSlug } from "@/hooks/use-current-org";
import { setCurrentProjectSlug } from "@/hooks/use-current-project";
import type { OnboardingStep } from "@/lib/types";

export function useOnboardingState() {
	return useQuery({
		queryKey: ["onboarding"],
		queryFn: onboarding.snapshot,
		staleTime: 15 * 1000,
		refetchOnWindowFocus: "always",
	});
}

export function useInvalidateOnboarding() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: ["onboarding"] });
		qc.invalidateQueries({ queryKey: ["orgs"] });
	};
}

/**
 * Per-stage guard: renders the stage only while the server says it is the
 * current one, otherwise moves to the step that actually is. "done" always
 * resolves through /onboarding so entry stays in one place. The project
 * stage additionally serves "done" (explicit selection between several
 * accessible projects), and callers may allow extra steps - e.g. the
 * organization stage stays open for an explicit invitation link.
 */
export function useOnboardingStage(stage: OnboardingStep, extraAllowedSteps: OnboardingStep[] = []) {
	const query = useOnboardingState();
	const navigate = useNavigate();
	const step = query.data?.next_step;
	const allowed =
		step === stage ||
		(stage === "project" && step === "done") ||
		(!!step && extraAllowedSteps.includes(step));
	useEffect(() => {
		if (!step || allowed) return;
		const target = step === "done" ? "/onboarding" : onboardingStagePath(step);
		// Preserve ?next and ?invite across stage moves.
		navigate({ to: target, replace: true, search: (prev) => prev });
	}, [step, allowed, navigate]);
	return { query, snapshot: query.data, ready: allowed && !!query.data };
}

/**
 * Commit the chosen context and enter the application. On subdomain-capable
 * hosts this is a hard navigation to the org origin (the org lives in the
 * host); elsewhere the caller receives the destination to navigate to.
 */
export function enterApp(target: EntryTarget, next?: string): string | null {
	setCurrentOrgSlug(target.orgSlug);
	setCurrentProjectSlug(target.orgSlug, target.projectSlug);
	const destination = projectEntryPath(target.projectSlug, tenantNext(next));
	if (supportsOrgSubdomains(window.location.hostname)) {
		window.location.assign(`${orgOrigin(target.orgSlug)}${destination}`);
		return null;
	}
	return destination;
}
