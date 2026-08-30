// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Pure onboarding routing logic: which stage a server-derived step maps to,
// and which org/project a fully onboarded user should enter. Kept free of
// browser and React dependencies so the transitions are unit-testable.

import type { OnboardingSnapshot, OnboardingStep } from "@/lib/types";

/** The route each onboarding step is served at. */
export function onboardingStagePath(step: OnboardingStep): string {
	switch (step) {
		case "profile":
			return "/onboarding/profile";
		case "organization":
			return "/onboarding/organization";
		case "project":
			return "/onboarding/project";
		default:
			return "/onboarding";
	}
}

export interface EntryTarget {
	orgSlug: string;
	projectSlug: string;
}

/**
 * The org/project context a "done" user should enter, or null when the
 * choice is ambiguous and needs an explicit selection. Only organizations
 * with at least one accessible project qualify, and remembered context
 * counts only while it still matches live membership state - a revoked
 * project can never be re-entered from stale storage.
 */
export function resolveEntry(
	snap: OnboardingSnapshot,
	rememberedOrgSlug: string | null,
	rememberedProjects: Record<string, string>,
): EntryTarget | null {
	const candidates = snap.organizations.filter((o) => o.projects.length > 0);
	if (candidates.length === 0) return null;
	const org = candidates.find((o) => o.slug === rememberedOrgSlug) ?? (candidates.length === 1 ? candidates[0] : undefined);
	if (!org) return null;
	const remembered = rememberedProjects[org.slug];
	const project =
		org.projects.find((p) => p.slug === remembered) ?? (org.projects.length === 1 ? org.projects[0] : undefined);
	return project ? { orgSlug: org.slug, projectSlug: project.slug } : null;
}

/** Total accessible projects across all organizations. */
export function accessibleProjectCount(snap: OnboardingSnapshot): number {
	return snap.organizations.reduce((sum, org) => sum + org.projects.length, 0);
}
