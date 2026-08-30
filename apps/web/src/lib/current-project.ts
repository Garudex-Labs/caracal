// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Pure resolution of the active project from the URL and the org's project
// list. The project carried by the URL is the ONLY authoritative context -
// there is no cache/first-project fallback for what is "current". A remembered
// or single project is offered separately as a redirect *preference* when the
// URL carries no project, so the app can establish a project in the URL rather
// than silently browsing project resources without one.

import type { Project } from "./types/org.ts";

export interface ProjectResolution {
	/** The project named by the URL, and only that - undefined otherwise. */
	currentProject: Project | undefined;
	/**
	 * A deterministic project to redirect to when the URL carries none: the
	 * remembered selection (while still valid) or the org's only project. Never
	 * an arbitrary pick among several.
	 */
	preferredProject: Project | undefined;
	/** The URL names a project that is not in this org (stale/manipulated/cross-org). */
	urlProjectInvalid: boolean;
	/** No URL project, no deterministic preference, and several to choose from. */
	needsSelection: boolean;
	/** The organization has no accessible projects (setup state). */
	noProjects: boolean;
}

export function resolveCurrentProject(
	projects: Project[],
	urlProject: string | null,
	rememberedSlug: string | undefined,
	loaded: boolean,
): ProjectResolution {
	const urlMatch = urlProject ? projects.find((p) => p.slug === urlProject) : undefined;
	const remembered = rememberedSlug ? projects.find((p) => p.slug === rememberedSlug) : undefined;
	const preferredProject = remembered ?? (loaded && projects.length === 1 ? projects[0] : undefined);
	return {
		currentProject: urlMatch,
		preferredProject,
		urlProjectInvalid: !!urlProject && loaded && !urlMatch,
		needsSelection: loaded && !urlMatch && !preferredProject && projects.length > 1,
		noProjects: loaded && projects.length === 0,
	};
}
