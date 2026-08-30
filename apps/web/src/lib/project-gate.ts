// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Pure decision for the project context gate. Given the current route class
// (project-free vs project-facing) and the resolved org/project state, it
// decides whether a project-facing route may render, must redirect to
// establish a project in the URL, must ask the user to pick, or must be
// rejected (a URL naming a project outside the org). The URL is the single
// source of the active project - the gate never silently adopts a cached or
// arbitrary project for a project-facing route.

export type ProjectGateDecision =
	| { kind: "render" }
	| { kind: "loading" }
	| { kind: "needsOrg" }
	| { kind: "redirect"; projectSlug: string }
	| { kind: "picker" }
	| { kind: "noProjects" }
	| { kind: "notFound" };

export interface ProjectGateInput {
	/** The current route is organization/account/operator scoped (no project). */
	isProjectFree: boolean;
	orgLoading: boolean;
	hasOrg: boolean;
	projectsLoading: boolean;
	/** The project named by the URL, if it belongs to the org. */
	currentProject: { slug: string } | undefined;
	/** A deterministic project to establish when the URL carries none. */
	preferredProject: { slug: string } | undefined;
	/** The URL names a project outside this org (stale/manipulated/cross-org). */
	urlProjectInvalid: boolean;
	needsSelection: boolean;
	noProjects: boolean;
}

export function decideProjectGate(input: ProjectGateInput): ProjectGateDecision {
	// Organization- and account-scoped surfaces never require a project.
	if (input.isProjectFree) return { kind: "render" };
	if (input.orgLoading) return { kind: "loading" };
	// No tenant boundary yet: onboarding / explicit org selection owns this.
	if (!input.hasOrg) return { kind: "needsOrg" };
	if (input.projectsLoading) return { kind: "loading" };
	// A valid project in the URL is the resolved working context.
	if (input.currentProject) return { kind: "render" };
	// A URL naming a project outside this org is rejected outright - never
	// redirected to a different project (no silent cross-project fallback).
	if (input.urlProjectInvalid) return { kind: "notFound" };
	if (input.noProjects) return { kind: "noProjects" };
	// No project in the URL: establish a deterministic one, or ask.
	if (input.preferredProject) return { kind: "redirect", projectSlug: input.preferredProject.slug };
	if (input.needsSelection) return { kind: "picker" };
	return { kind: "loading" };
}
