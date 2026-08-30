// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Shared "current project" context - the mandatory working context inside an
// organization. The active project is ALWAYS the one carried by the URL prefix
// ({project} path segment / router basepath); there is no cache or
// first-project fallback for what is "current". When the URL carries no
// project, the project gate uses `preferredProject` (a remembered-and-still-
// valid selection, or the org's only project) to redirect and establish a
// project in the URL - it never renders project resources without one, and a
// URL naming a project outside the org is rejected rather than swapped.
// Selections are remembered PER ORGANIZATION (org slug -> project slug), so a
// project can never carry over across organizations.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useOrgProjects } from "@/hooks/use-orgs-api";
import { resolveCurrentProject } from "@/lib/current-project";
import { getTenant, isProjectFreePath, pathWithoutProjectPrefix, projectRoutePath } from "@/lib/tenant-host";
import type { Project } from "@/lib/types";

const STORAGE_KEY = "caracal_current_project";
const CHANGE_EVENT = "caracal:project-changed";

function subscribe(cb: () => void) {
	window.addEventListener("storage", cb);
	window.addEventListener(CHANGE_EVENT, cb);
	return () => {
		window.removeEventListener("storage", cb);
		window.removeEventListener(CHANGE_EVENT, cb);
	};
}

const getSnapshot = () => localStorage.getItem(STORAGE_KEY) ?? "";
const getServerSnapshot = () => "";

function readMap(raw: string): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

export function setCurrentProjectSlug(orgSlug: string, projectSlug: string) {
	const map = readMap(localStorage.getItem(STORAGE_KEY) ?? "");
	map[orgSlug] = projectSlug;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The remembered org→project map - preferences only, validated on use. */
export function rememberedProjectMap(): Record<string, string> {
	return readMap(localStorage.getItem(STORAGE_KEY) ?? "");
}

export interface CurrentProjectState {
	/** Projects of the active organization the user can see. */
	projects: Project[];
	isLoading: boolean;
	/** The project named by the URL - the authoritative working context. */
	currentProject: Project | undefined;
	/** A deterministic project to establish when the URL carries none. */
	preferredProject: Project | undefined;
	/** The URL names a project that is not in this organization. */
	urlProjectInvalid: boolean;
	/** Several projects are available and none is resolved: the user must pick. */
	needsSelection: boolean;
	/** The active organization has no accessible projects (setup state). */
	noProjects: boolean;
	setCurrentProject: (projectSlug: string) => void;
}

export function useCurrentProject(): CurrentProjectState {
	const { currentOrg } = useCurrentOrg();
	// Bounded context fetch: the working-context resolver reads the org's
	// projects up to the server page cap; deeper administration lists live in
	// the organization area with real pagination.
	const projectsQuery = useOrgProjects(currentOrg?.slug, { page_size: 200 });
	const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const loaded = !!currentOrg && !projectsQuery.isLoading && !projectsQuery.isError;
	const projects = currentOrg ? (projectsQuery.data?.projects ?? []) : [];
	// The project is carried by the URL prefix in every mode; it is the only
	// authoritative source of the active project (no cache/first-project guess).
	const { urlProject } = getTenant();
	const rememberedSlug = currentOrg ? readMap(raw)[currentOrg.slug] : undefined;
	const resolution = resolveCurrentProject(projects, urlProject, rememberedSlug, loaded);
	const { currentProject } = resolution;
	const orgSlug = currentOrg?.slug;
	// Arriving on a valid project URL is an explicit selection: remember it so
	// later unprefixed navigation for THIS org can restore the same project.
	useEffect(() => {
		if (orgSlug && currentProject && rememberedSlug !== currentProject.slug) {
			setCurrentProjectSlug(orgSlug, currentProject.slug);
		}
	}, [orgSlug, currentProject, rememberedSlug]);
	const setCurrentProject = useCallback(
		(projectSlug: string) => {
			if (!orgSlug) return;
			setCurrentProjectSlug(orgSlug, projectSlug);
			// The project is the router basepath in every mode: rewrite only the
			// prefix (the org host is preserved) and reload so the basepath and
			// every scoped request match the new project.
			const { urlProject: activeUrlProject } = getTenant();
			if (projectSlug !== activeUrlProject) {
				const rest = pathWithoutProjectPrefix(window.location.pathname, activeUrlProject);
				if (!isProjectFreePath(rest)) {
					window.location.assign(`${projectRoutePath(projectSlug, rest)}${window.location.search}`);
				}
			}
		},
		[orgSlug],
	);
	return {
		projects,
		isLoading: !!currentOrg && projectsQuery.isLoading,
		currentProject,
		preferredProject: resolution.preferredProject,
		urlProjectInvalid: resolution.urlProjectInvalid,
		needsSelection: resolution.needsSelection,
		noProjects: resolution.noProjects,
		setCurrentProject,
	};
}
